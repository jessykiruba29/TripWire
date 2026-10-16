"""Configuration, loaded from environment variables (never from source).

Secrets live only in the environment: ``.env.example`` documents every supported
variable and ``.env`` is git-ignored, so a real API key can never be committed
(spec S3/S16).

Notable behaviour
-----------------
``TRIPWIRE_STORE`` defaults to ``falkordb`` - the architecture the specification
calls for.  If the server cannot be reached and ``TRIPWIRE_STORE_FALLBACK`` is
true (the default), Tripwire logs a loud warning and falls back to the JSON store
so the demo still runs end to end without Docker.  The *active* backend is always
reported by ``GET /api/health`` and ``GET /api/demo/state``, so a silent fallback
cannot masquerade as a real FalkorDB deployment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

__all__ = ["Settings", "load_settings", "load_dotenv_file"]

_TRUTHY = {"1", "true", "yes", "on"}


def _as_bool(value: Any, default: bool = False) -> bool:
    """Parse a boolean environment value."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in _TRUTHY


def _as_int(value: Any, default: int) -> int:
    """Parse an int environment value, falling back when unparseable."""
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float) -> float:
    """Parse a float environment value, falling back when unparseable."""
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def load_dotenv_file(path: str = ".env") -> dict[str, str]:
    """Minimal ``.env`` loader used when ``python-dotenv`` is unavailable.

    Only sets variables that are not already present in the environment, so real
    environment configuration always wins over a stale local file.
    """
    loaded: dict[str, str] = {}
    if not os.path.exists(path):
        return loaded
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip("'\"")
                if key and key not in os.environ:
                    os.environ[key] = value
                    loaded[key] = value
    except OSError:
        return loaded
    return loaded


@dataclass
class Settings:
    """Runtime configuration for the whole backend."""

    # -- graph store -------------------------------------------------------
    store_backend: str = "falkordb"
    store_fallback: bool = True
    state_path: str = "data/graph.json"

    # -- FalkorDB ----------------------------------------------------------
    falkor_host: str = "localhost"
    falkor_port: int = 6379
    falkor_username: Optional[str] = None
    falkor_password: Optional[str] = None
    falkor_graph: str = "tripwire"
    falkor_socket_timeout: float = 15.0

    # -- LLM (optional) ----------------------------------------------------
    llm_provider: str = "none"
    llm_model: str = ""
    llm_api_key: Optional[str] = None
    llm_base_url: Optional[str] = None
    llm_timeout: float = 30.0
    llm_max_output_tokens: int = 1500

    # -- engine limits -----------------------------------------------------
    max_propagation_depth: int = 3
    verified_confidence_floor: float = 0.6

    # -- API ---------------------------------------------------------------
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    cors_origins: tuple[str, ...] = ("*",)

    # -- operations --------------------------------------------------------
    log_level: str = "INFO"
    log_json: bool = False
    seed_on_startup: bool = False
    environment: str = "development"

    extra: dict[str, Any] = field(default_factory=dict)

    # ------------------------------------------------------------------ load
    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "Settings":
        """Build settings from a mapping (defaults to ``os.environ``)."""
        source = env if env is not None else os.environ

        def get(key: str, default: Optional[str] = None) -> Optional[str]:
            value = source.get(key)
            return default if value is None or value == "" else value

        origins = get("TRIPWIRE_CORS_ORIGINS", "*") or "*"
        return cls(
            store_backend=(get("TRIPWIRE_STORE", "falkordb") or "falkordb").strip().lower(),
            store_fallback=_as_bool(get("TRIPWIRE_STORE_FALLBACK"), True),
            state_path=get("TRIPWIRE_STATE_PATH", "data/graph.json") or "data/graph.json",
            falkor_host=get("FALKOR_HOST", "localhost") or "localhost",
            falkor_port=_as_int(get("FALKOR_PORT"), 6379),
            falkor_username=get("FALKOR_USERNAME"),
            falkor_password=get("FALKOR_PASSWORD"),
            falkor_graph=get("FALKOR_GRAPH", "tripwire") or "tripwire",
            falkor_socket_timeout=_as_float(get("FALKOR_SOCKET_TIMEOUT"), 15.0),
            llm_provider=(get("LLM_PROVIDER", "none") or "none").strip().lower(),
            llm_model=get("LLM_MODEL", "") or "",
            llm_api_key=get("LLM_API_KEY"),
            llm_base_url=get("LLM_BASE_URL"),
            llm_timeout=_as_float(get("LLM_TIMEOUT"), 30.0),
            llm_max_output_tokens=_as_int(get("LLM_MAX_OUTPUT_TOKENS"), 1500),
            max_propagation_depth=_as_int(get("TRIPWIRE_MAX_PROPAGATION_DEPTH"), 3),
            verified_confidence_floor=_as_float(get("TRIPWIRE_VERIFIED_CONFIDENCE_FLOOR"), 0.6),
            api_host=get("TRIPWIRE_API_HOST", "127.0.0.1") or "127.0.0.1",
            api_port=_as_int(get("TRIPWIRE_API_PORT"), 8000),
            cors_origins=tuple(item.strip() for item in origins.split(",") if item.strip()) or ("*",),
            log_level=(get("TRIPWIRE_LOG_LEVEL", "INFO") or "INFO").upper(),
            log_json=_as_bool(get("TRIPWIRE_LOG_JSON"), False),
            seed_on_startup=_as_bool(get("TRIPWIRE_SEED_ON_STARTUP"), False),
            environment=get("TRIPWIRE_ENV", "development") or "development",
        )

    # ------------------------------------------------------------- accessors
    @property
    def llm_enabled(self) -> bool:
        """True when a live LLM path is configured and usable."""
        return self.llm_provider not in ("", "none", "off", "disabled") and bool(self.llm_api_key)

    def falkor_options(self) -> dict[str, Any]:
        """Keyword arguments for :class:`tripwire.core.falkor_store.FalkorGraphStore`."""
        return {
            "host": self.falkor_host,
            "port": self.falkor_port,
            "username": self.falkor_username,
            "password": self.falkor_password,
            "graph": self.falkor_graph,
            "socket_timeout": self.falkor_socket_timeout,
        }

    def public_summary(self) -> dict[str, Any]:
        """Configuration summary safe to expose over the API (no secrets)."""
        return {
            "store_backend": self.store_backend,
            "store_fallback": self.store_fallback,
            "state_path": self.state_path,
            "falkordb": {
                "host": self.falkor_host,
                "port": self.falkor_port,
                "graph": self.falkor_graph,
                "username": self.falkor_username,
                "password_configured": bool(self.falkor_password),
            },
            "llm": {
                "provider": self.llm_provider,
                "model": self.llm_model,
                "enabled": self.llm_enabled,
                "api_key_configured": bool(self.llm_api_key),
            },
            "limits": {
                "max_propagation_depth": self.max_propagation_depth,
                "verified_confidence_floor": self.verified_confidence_floor,
            },
            "environment": self.environment,
        }


def load_settings(env: Optional[Mapping[str, str]] = None, dotenv_path: str = ".env") -> Settings:
    """Load settings, consulting a local ``.env`` file when present."""
    if env is None:
        try:
            from dotenv import load_dotenv  # type: ignore

            load_dotenv(dotenv_path, override=False)
        except Exception:  # noqa: BLE001 - dotenv is optional
            load_dotenv_file(dotenv_path)
    return Settings.from_env(env)

"""Optional LLM integration: structured extraction and semantic comparison.

Two capabilities are provided, both optional:

1. :class:`LLMExtractor` - structured extraction of candidate knowledge from a
   source record.
2. :meth:`HttpLLMClient.compare_facts` - semantic comparison used by
   :func:`tripwire.core.contradictions.find_contradictions` to add nuance to a
   rule-detected conflict.

Discipline that applies to both (spec S5/S6)
--------------------------------------------
* The model is asked for **JSON only**, and its output is validated by
  :func:`tripwire.ingest.base.validate_extraction` before anything is written.  A
  malformed reply raises :class:`LLMResponseError` and the pipeline falls back to
  the deterministic extractor.
* Extracted claims are recorded with ``verified=False``.  The LLM never promotes a
  claim to verified truth, and a semantic verdict can only *soften* an automatic
  rule verdict (see ``contradictions.find_contradictions``), never confirm one.
* Every failure mode degrades instead of crashing: a missing key raises
  :class:`LLMUnavailableError`, and the deterministic engine keeps working.

Transport
---------
Uses ``httpx`` (already a dependency).  ``transport`` can be injected, which is how
the client is unit-tested against a mock transport without any network access or
credential.  **The live provider path is therefore implemented and
request-shape-tested, but was not exercised against a real provider in this
environment** - there is no API key configured here.
"""

from __future__ import annotations

import json
import logging
import re
from abc import ABC, abstractmethod
from typing import Any, Mapping, Optional

from ..config import Settings
from ..core.errors import LLMResponseError, LLMUnavailableError
from .base import ExtractionResult, KnowledgeExtractor, SourceRecord, validate_extraction

logger = logging.getLogger("tripwire.ingest.llm")

__all__ = [
    "LLMClient",
    "HttpLLMClient",
    "LLMExtractor",
    "build_llm_client",
    "EXTRACTION_SYSTEM_PROMPT",
    "COMPARISON_SYSTEM_PROMPT",
    "EXTRACTION_JSON_SCHEMA",
]

#: JSON schema the extractor asks the model to satisfy.  Kept in the prompt (and
#: in the response_format hint) so the request is self-describing.
EXTRACTION_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "entities": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "label": {
                        "type": "string",
                        "enum": [
                            "Person", "Team", "System", "Project", "Decision",
                            "Assumption", "Fact", "Message", "Document", "Event", "Alert",
                        ],
                    },
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": ["name"],
            },
        },
        "facts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "subject_label": {"type": "string"},
                    "attribute": {"type": "string"},
                    "value": {},
                    "statement": {"type": "string"},
                    "confidence": {"type": "number"},
                    "verified": {"type": "boolean"},
                    "valid_from": {"type": "string"},
                    "valid_to": {"type": "string"},
                    "source_span": {"type": "string"},
                },
                "required": ["subject", "attribute", "value"],
            },
        },
        "assumptions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "statement": {"type": "string"},
                    "subject": {"type": "string"},
                    "confidence": {"type": "number"},
                    "source_span": {"type": "string"},
                },
                "required": ["statement"],
            },
        },
        "decisions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "statement": {"type": "string"},
                    "subject": {"type": "string"},
                    "confidence": {"type": "number"},
                    "source_span": {"type": "string"},
                },
                "required": ["statement"],
            },
        },
    },
    "required": ["entities", "facts"],
}

EXTRACTION_SYSTEM_PROMPT = (
    "You extract candidate business knowledge from a single source record for a "
    "decision-provenance graph.\n"
    "Rules:\n"
    "1. Reply with JSON only, matching this schema exactly: "
    f"{json.dumps(EXTRACTION_JSON_SCHEMA, separators=(',', ':'))}\n"
    "2. Extract ONLY what the record actually asserts. Never infer, generalise or "
    "complete missing information.\n"
    "3. Prefer entities that already exist in the provided list of known entities; "
    "reuse their canonical names verbatim.\n"
    "4. For every fact give a single-valued `attribute` (snake_case) and the exact "
    "`value` asserted. Copy the supporting sentence into `source_span`.\n"
    "5. Set `confidence` to your genuine uncertainty (0..1). Leave `verified` false: "
    "you are proposing candidates, not establishing truth.\n"
    "6. If the record asserts nothing extractable, return empty arrays. Do not invent."
)

COMPARISON_SYSTEM_PROMPT = (
    "You compare two claims about the same subject and report their logical relation.\n"
    "Reply with JSON only: "
    '{"relation": "contradicts|adds_new|different_time|unrelated|ambiguous", '
    '"confidence": <0..1>, "reason": "<one sentence>"}.\n'
    "Choose `different_time` when the claims describe different real-world periods, "
    "`adds_new` when the new claim adds information without conflicting, `ambiguous` "
    "when the prior state is itself inconsistent, and `unrelated` when they concern "
    "different attributes or subjects. Do not assume the new claim is correct."
)

_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


class LLMClient(ABC):
    """Minimal LLM interface used by ingestion and contradiction comparison."""

    name: str = "llm"

    @abstractmethod
    def complete_json(
        self,
        system: str,
        user: str,
        *,
        max_tokens: Optional[int] = None,
        schema_hint: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        """Return a validated JSON object from the model.

        Raises
        ------
        LLMUnavailableError
            The provider is not configured or not reachable.
        LLMResponseError
            The reply was not usable JSON.
        """

    @abstractmethod
    def compare_facts(self, old_claim: Any, new_claim: Any) -> dict[str, Any]:
        """Compare two :class:`~tripwire.core.contradictions.FactClaim` objects."""


def extract_json_object(text: str) -> dict[str, Any]:
    """Pull a JSON object out of a model reply.

    Tolerates markdown fences and leading prose, which models emit routinely, but
    raises :class:`LLMResponseError` rather than guessing when no object is present.
    """
    if not isinstance(text, str) or not text.strip():
        raise LLMResponseError("the model returned an empty response")
    candidate = text.strip()
    fenced = _JSON_FENCE.search(candidate)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        start, end = candidate.find("{"), candidate.rfind("}")
        if start == -1 or end <= start:
            raise LLMResponseError(
                "the model response contained no JSON object",
                details={"preview": text[:300]},
            )
        try:
            parsed = json.loads(candidate[start : end + 1])
        except json.JSONDecodeError as exc:
            raise LLMResponseError(
                f"the model response was not valid JSON: {exc}",
                details={"preview": text[:300]},
            ) from exc
    if not isinstance(parsed, dict):
        raise LLMResponseError("the model response was valid JSON but not an object")
    return parsed


class HttpLLMClient(LLMClient):
    """OpenAI-compatible chat-completions client.

    Works with any provider exposing ``POST {base_url}/chat/completions``
    (OpenAI, Azure OpenAI-compatible gateways, vLLM, Ollama, LM Studio).  The API
    key is sent in an ``Authorization`` header and is never logged.
    """

    name = "http"

    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        base_url: str = "https://api.openai.com/v1",
        timeout: float = 30.0,
        max_tokens: int = 1500,
        transport: Any = None,
    ) -> None:
        if not api_key:
            raise LLMUnavailableError(
                "no LLM API key configured; set LLM_API_KEY or leave LLM_PROVIDER=none "
                "to use the deterministic extractor"
            )
        if not model:
            raise LLMUnavailableError("no LLM model configured; set LLM_MODEL")
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = float(timeout)
        self.max_tokens = int(max_tokens)
        self._api_key = api_key
        self._transport = transport

    # ------------------------------------------------------------------ request
    def _post(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """POST a chat-completions request and return the parsed body."""
        try:
            import httpx
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise LLMUnavailableError(
                "the 'httpx' package is required for the live LLM path"
            ) from exc

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        try:
            with httpx.Client(timeout=self.timeout, transport=self._transport) as client:
                response = client.post(
                    f"{self.base_url}/chat/completions",
                    headers=headers,
                    json=dict(payload),
                )
        except Exception as exc:  # noqa: BLE001 - network failures must degrade
            raise LLMUnavailableError(
                f"LLM request failed: {exc}", details={"provider_url": self.base_url}
            ) from exc
        if response.status_code >= 400:
            raise LLMUnavailableError(
                f"LLM provider returned HTTP {response.status_code}",
                details={"provider_url": self.base_url, "status": response.status_code},
            )
        try:
            return response.json()
        except Exception as exc:  # noqa: BLE001
            raise LLMResponseError(f"LLM provider returned a non-JSON body: {exc}") from exc

    def _message_text(self, body: Mapping[str, Any]) -> str:
        """Extract the assistant message text from a chat-completions body."""
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            raise LLMResponseError(
                "LLM response contained no choices", details={"keys": sorted(body.keys())}
            )
        message = choices[0].get("message") if isinstance(choices[0], Mapping) else None
        if not isinstance(message, Mapping):
            raise LLMResponseError("LLM response choice had no message object")
        content = message.get("content")
        if isinstance(content, list):
            # Some gateways return content parts.
            content = "".join(
                str(part.get("text", "")) for part in content if isinstance(part, Mapping)
            )
        if not isinstance(content, str):
            raise LLMResponseError("LLM response message had no text content")
        return content

    # --------------------------------------------------------------- operations
    def complete_json(
        self,
        system: str,
        user: str,
        *,
        max_tokens: Optional[int] = None,
        schema_hint: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        """Request a JSON object from the model."""
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
            "max_tokens": int(max_tokens or self.max_tokens),
        }
        if schema_hint is not None:
            # Ask for a JSON object explicitly; the schema itself travels in the
            # system prompt so providers without structured-output support still work.
            payload["response_format"] = {"type": "json_object"}
        body = self._post(payload)
        return extract_json_object(self._message_text(body))

    def compare_facts(self, old_claim: Any, new_claim: Any) -> dict[str, Any]:
        """Ask the model how a new claim relates to an earlier one."""
        user = json.dumps(
            {
                "earlier_claim": {
                    "subject": getattr(old_claim, "subject_name", None),
                    "attribute": getattr(old_claim, "attribute", None),
                    "value": getattr(old_claim, "value", None),
                    "valid_from": getattr(old_claim, "valid_from", None),
                    "valid_to": getattr(old_claim, "valid_to", None),
                    "source": getattr(old_claim, "source_id", None),
                },
                "new_claim": {
                    "subject": getattr(new_claim, "subject_name", None),
                    "attribute": getattr(new_claim, "attribute", None),
                    "value": getattr(new_claim, "value", None),
                    "valid_from": getattr(new_claim, "valid_from", None),
                    "valid_to": getattr(new_claim, "valid_to", None),
                    "source": getattr(new_claim, "source_id", None),
                },
            },
            indent=1,
        )
        return self.complete_json(COMPARISON_SYSTEM_PROMPT, user, max_tokens=300)


class LLMExtractor(KnowledgeExtractor):
    """Structured extraction through an :class:`LLMClient`, validated before use."""

    name = "llm"

    def __init__(self, client: LLMClient, *, known_entities: Optional[list[str]] = None) -> None:
        self.client = client
        self.known_entities = list(known_entities or [])

    def extract(self, record: SourceRecord) -> ExtractionResult:
        """Extract candidate knowledge, validating the model's JSON reply."""
        user = self._prompt(record)
        raw = self.client.complete_json(
            EXTRACTION_SYSTEM_PROMPT,
            user,
            schema_hint=EXTRACTION_JSON_SCHEMA,
        )
        result = validate_extraction(raw, extractor=self.name)
        result.llm_used = True
        # The model proposes; it never verifies.
        for claim in (*result.facts, *result.assumptions, *result.decisions):
            claim.verified = False
            claim.review_status = "NEEDS_REVIEW"
        if not result.claim_count and not result.entities:
            result.warnings.append(
                "The LLM reported nothing extractable from this record; no knowledge "
                "was written."
            )
        return result

    def _prompt(self, record: SourceRecord) -> str:
        """Build the extraction prompt for one record."""
        entities_block = (
            "\n".join(f"- {name}" for name in self.known_entities[:200])
            or "(the graph currently has no entities)"
        )
        return (
            f"SOURCE SYSTEM: {record.source_system}\n"
            f"DOCUMENT TYPE: {record.doc_type or 'message'}\n"
            f"EXTERNAL ID: {record.external_id}\n"
            f"AUTHOR: {record.author or 'unknown'}\n"
            f"TIMESTAMP: {record.timestamp or 'unknown'}\n"
            f"CHANNEL: {record.channel or 'n/a'}\n"
            f"TITLE: {record.title}\n"
            "KNOWN ENTITIES (reuse these exact names when they appear):\n"
            f"{entities_block}\n\n"
            "RECORD TEXT:\n"
            '"""\n'
            f"{record.text[:8000]}\n"
            '"""\n'
        )


def build_llm_client(settings: Settings) -> Optional[LLMClient]:
    """Build the configured LLM client, or ``None`` when no LLM is configured.

    Returning ``None`` (rather than raising) is what lets the engine treat the LLM
    as a genuinely optional dependency (spec S16).
    """
    provider = (settings.llm_provider or "none").strip().lower()
    if provider in ("", "none", "off", "disabled"):
        return None
    if provider not in ("openai", "openai_compatible", "openai-compatible", "compatible", "azure"):
        raise LLMUnavailableError(
            f"unsupported LLM_PROVIDER {settings.llm_provider!r}; supported values are "
            "'none' and 'openai_compatible'",
            details={"provider": settings.llm_provider},
        )
    if not settings.llm_api_key:
        raise LLMUnavailableError(
            "LLM_PROVIDER is set but LLM_API_KEY is missing; set the key in the "
            "environment (never in source control) or use LLM_PROVIDER=none"
        )
    return HttpLLMClient(
        model=settings.llm_model or "gpt-4o-mini",
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url or "https://api.openai.com/v1",
        timeout=settings.llm_timeout,
        max_tokens=settings.llm_max_output_tokens,
    )

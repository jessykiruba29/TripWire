<#
.SYNOPSIS
    Start the Tripwire API locally with uvicorn.

.DESCRIPTION
    Reads the same environment variables as the application (TRIPWIRE_*), echoes
    which graph backend will be used, then runs `uvicorn tripwire.api.app:app`.
    With the default backend (falkordb) and no reachable server, Tripwire logs a
    warning and falls back to the JSON store - so this works with zero setup.

.PARAMETER Store
    Override the backend for this run: memory | json | falkordb.

.PARAMETER BindHost
    Bind host (default: $env:TRIPWIRE_API_HOST or 127.0.0.1).

.PARAMETER Port
    Bind port (default: $env:TRIPWIRE_API_PORT or 8000).

.PARAMETER NoReload
    Disable auto-reload (reload is on by default for local development).

.EXAMPLE
    ./scripts/run_local.ps1 -Store memory
#>
[CmdletBinding()]
param(
    [ValidateSet("memory", "json", "falkordb")]
    [string]$Store,

    [string]$BindHost,

    [int]$Port = 0,

    [switch]$NoReload
)

$ErrorActionPreference = "Stop"

if ($Store) { $env:TRIPWIRE_STORE = $Store }
if (-not $env:TRIPWIRE_STORE) { $env:TRIPWIRE_STORE = "falkordb" }

if (-not $BindHost) {
    if ($env:TRIPWIRE_API_HOST) { $BindHost = $env:TRIPWIRE_API_HOST } else { $BindHost = "127.0.0.1" }
}
if ($Port -le 0) {
    if ($env:TRIPWIRE_API_PORT) { $Port = [int]$env:TRIPWIRE_API_PORT } else { $Port = 8000 }
}

if ($env:TRIPWIRE_STATE_PATH) { $statePath = $env:TRIPWIRE_STATE_PATH } else { $statePath = "data/graph.json" }

Write-Host "Tripwire local API" -ForegroundColor Cyan
Write-Host ("  graph backend : {0}" -f $env:TRIPWIRE_STORE)
Write-Host ("  state file    : {0} (JSON store / fallback)" -f $statePath)
Write-Host ("  listening on  : http://{0}:{1}" -f $BindHost, $Port)
if ($env:TRIPWIRE_STORE -eq "falkordb") {
    Write-Host "  note: if FalkorDB is unreachable, Tripwire warns and falls back to JSON." -ForegroundColor DarkYellow
}
if ($env:TRIPWIRE_STORE -eq "memory") {
    Write-Host "  note: the in-memory store is ephemeral - state is lost on exit." -ForegroundColor DarkYellow
}
Write-Host "  docs          : http://{0}:{1}/docs" -f $BindHost, $Port

$uvicornArgs = @("tripwire.api.app:app", "--host", $BindHost, "--port", $Port)
if (-not $NoReload) { $uvicornArgs += "--reload" }

python -m uvicorn @uvicornArgs

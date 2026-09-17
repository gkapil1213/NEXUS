[CmdletBinding()]
param([string]$RepoRoot = (Get-Location).Path)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$audit = Join-Path $RepoRoot '_phase137_audit'
New-Item -ItemType Directory -Force -Path $audit | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out   = Join-Path $audit "phase137-context-$stamp.txt"

$files = @(
    'src/core/remote-execution-manager.ts',
    'src/core/dispatch-service.ts',
    'src/core/worker-gateway.ts',
    'src/core/worker-agent.ts',
    'src/core/execution-engine.ts',
    'src/core/execution-store.ts',
    'src/core/worker-transport-messages.ts',
    'scripts/test-phase137-cancellation-timeout.ts'
)

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Phase 137 context $stamp")
$lines.Add("Repo: $RepoRoot")
$lines.Add("")

foreach ($f in $files) {
    $path = Join-Path $RepoRoot $f
    $lines.Add("===== FILE: $f =====")
    if (Test-Path $path) {
        $lines.Add((Get-Content -Raw -Path $path))
    } else {
        $lines.Add("MISSING: $path")
    }
    $lines.Add("")
}

$lines | Out-File -FilePath $out -Encoding utf8
Write-Host "Wrote $out"

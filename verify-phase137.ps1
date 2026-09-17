[CmdletBinding()]
param([string]$RepoRoot = (Get-Location).Path)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Push-Location $RepoRoot
try {
    Write-Host "== typecheck =="
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }

    Write-Host "== Phase 137 focused =="
    $phase137Out = npx tsx scripts/test-phase137-cancellation-timeout.ts 2>&1
    $phase137Out | Out-Host

    $joined = ($phase137Out -join "`n")
    if ($joined -notmatch 'Phase 137 results:\s+76 passed,\s+0 failed') {
        throw "Phase 137 did not reach 76/76"
    }

    Write-Host "== Full regression =="
    $scripts = @(
        'scripts/test-phase132-ci-reconciliation.ts',
        'scripts/test-phase133-scheduler.ts',
        'scripts/test-phase134-durable-ci-ownership.ts',
        'scripts/test-phase135-ci-reconciliation-integrity.ts',
        'scripts/test-phase136-execution-recovery.ts',
        'scripts/test-phase137-cancellation-timeout.ts'
    )
    foreach ($s in $scripts) {
        Write-Host "Running $s"
        npx tsx $s
        if ($LASTEXITCODE -ne 0) { throw "$s failed" }
    }

    Write-Host "== Build =="
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed" }

    Write-Host "== Diff check =="
    git diff --check
    if ($LASTEXITCODE -ne 0) { throw "git diff --check failed" }

    Write-Host "== Status =="
    git status --short
    git diff --stat

    Write-Host "All Phase 137 checks passed."
} finally {
    Pop-Location
}

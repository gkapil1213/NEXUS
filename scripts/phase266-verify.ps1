# scripts/phase266-verify.ps1
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\pc\NEXUS'
Set-Location $root
$report = Join-Path $root 'phase266-verification-report.txt'
Remove-Item $report -ErrorAction SilentlyContinue

# Pre-flight: warn if DATABASE_URL is unset (PG parity will BLOCK, not FAIL)
if (-not $env:DATABASE_URL) {
    Write-Host "`nWARNING: DATABASE_URL not set. PG parity tests will report BLOCKED, not FAIL." -ForegroundColor Yellow
    Write-Host "         Set DATABASE_URL for full coverage, or set NEXUS_VERIFY_REQUIRE_PG=1 to fail on blocked." -ForegroundColor Yellow
}

function Run-Step([string]$label, [string]$cmd) {
  Write-Host "`n===== $label =====" -ForegroundColor Cyan
  Write-Host "`$ $cmd" -ForegroundColor DarkGray
  $out = & powershell -NoProfile -Command $cmd 2>&1
  $code = $LASTEXITCODE
  $out | ForEach-Object { Write-Host $_ }
  Add-Content -Path $report -Value "`n===== $label ====="
  Add-Content -Path $report -Value "cmd: $cmd"
  Add-Content -Path $report -Value "exit: $code"
  Add-Content -Path $report -Value ($out -join "`n")
  return $code
}

$codes = [ordered]@{}
$codes['tsc']       = Run-Step 'tsc --noEmit'          'npx tsc --noEmit'
$codes['phase144']  = Run-Step 'phase144'              'npx tsx scripts/test-phase144-durable-recovery-operations.ts'
$codes['phase157']  = Run-Step 'phase157'              'npx tsx scripts/test-phase157-recovery-operation-idempotency.ts'
$codes['phase178']  = Run-Step 'phase178'              'npx tsx scripts/test-phase178-recovery-operations-control.ts'
$codes['phase197']  = Run-Step 'phase197'              'npx tsx scripts/test-phase197-stall-recovery.ts'
$codes['phase198']  = Run-Step 'phase198'              'npx tsx scripts/test-phase198-ownership.ts'
$codes['phase199']  = Run-Step 'phase199'              'npx tsx scripts/test-phase199-recovery-operation-reclaim.ts'
$codes['phase264']  = Run-Step 'phase264'              'npx tsx scripts/test-phase264-retry-eligibility.ts'
$codes['phase265']  = Run-Step 'phase265'              'npx tsx scripts/test-phase265-recovery-reconciliation-integrity.ts'
$codes['phase269a'] = Run-Step 'phase269 failure-injection' 'npx tsx scripts/test-phase269-failure-injection.ts'
$codes['phase269b'] = Run-Step 'phase269 observability'     'npx tsx scripts/test-phase269-recovery-observability.ts'
$codes['phase266']  = Run-Step 'phase266'              'npx tsx scripts/test-phase266-recovery-reconciliation-concurrency.ts'
$codes['phase270a'] = Run-Step 'phase270 crash-restart'  'npx tsx scripts/test-phase270-crash-restart-recovery.ts'
$codes['phase270b'] = Run-Step 'phase270 shutdown'       'npx tsx scripts/test-phase270-postgres-shutdown-reconciliation.ts'
$codes['phase270c'] = Run-Step 'phase270 server-restart' 'npx tsx scripts/test-phase270-server-restart.ts'
$codes['phase271'] = Run-Step 'phase271 event redaction' 'npx tsx scripts/test-phase271-event-redaction.ts'
$codes['diffcheck'] = Run-Step 'git diff --check'      'git diff --check'

Write-Host "`n===== SUMMARY =====" -ForegroundColor Green
$codes.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-10} exit={1}" -f $_.Key, $_.Value) }
Add-Content -Path $report -Value "`n===== SUMMARY ====="
$codes.GetEnumerator() | ForEach-Object { Add-Content -Path $report -Value ("{0} exit={1}" -f $_.Key, $_.Value) }
Write-Host "`nReport written to $report"

$failed = @($codes.GetEnumerator() | Where-Object { $_.Value -ne 0 })
if ($failed.Count -gt 0) {
    Write-Host "`nFAILURE GATE: $($failed.Count) step(s) failed." -ForegroundColor Red
    exit 1
}

# Strict PostgreSQL gate: require actual PostgreSQL execution when requested.
if ($env:NEXUS_VERIFY_REQUIRE_PG -eq "1") {
    if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
        Write-Host "`nPG REQUIRED: DATABASE_URL is not set." -ForegroundColor Red
        exit 1
    }

    $reportText = Get-Content $report -Raw -ErrorAction Stop

    # Narrow patterns: [BLOCKED] markers, BLOCKED: N counts > 0, NOT EXECUTED: N > 0.
    # Does NOT match "BLOCKED: 0", narrative "BLOCKED <text>", or "NOT EXECUTED: 0".
    $blockedLines = @(
        $reportText -split "`r?`n" |
        Where-Object {
            $_ -match '^\s*\[BLOCKED\]' -or
            $_ -match '^\s*BLOCKED:\s*[1-9]\d*\s*$' -or
            $_ -match '^\s*NOT EXECUTED\s*:\s*[1-9]'
        }
    )

    if ($blockedLines.Count -gt 0) {
        Write-Host "`nPG REQUIRED: blocked/not-executed checks detected:" -ForegroundColor Red
        $blockedLines | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
        exit 1
    }
}

Write-Host "`nFAILURE GATE: all registered steps returned exit 0." -ForegroundColor Green
exit 0
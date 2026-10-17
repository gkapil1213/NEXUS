# scripts/phase268-verify.ps1
# PHASE268_APPLIED
$ErrorActionPreference = 'Continue'
Set-Location C:\Users\pc\NEXUS
$report = ".\artifacts\phase268\phase268-verification-report.txt"
Remove-Item $report -ErrorAction SilentlyContinue

function Run-Step([string]$label, [string]$cmd) {
  Write-Host "`n===== $label =====" -ForegroundColor Cyan
  Write-Host "`$ $cmd"
  $o = & powershell -NoProfile -Command $cmd 2>&1
  $c = $LASTEXITCODE
  $o | ForEach-Object { Write-Host $_ }
  Write-Host "exit: $c" -ForegroundColor Yellow
  Add-Content -Path $report -Value "`n===== $label ====="
  Add-Content -Path $report -Value "cmd: $cmd"
  Add-Content -Path $report -Value "exit: $c"
  Add-Content -Path $report -Value ($o -join "`n")
  return $c
}

$codes = [ordered]@{}
$codes['tsc']                = Run-Step 'tsc --noEmit'                'npx tsc --noEmit'
$codes['phase265']           = Run-Step 'phase265 regression'         'npx tsx scripts/test-phase265-recovery-reconciliation-integrity.ts'
$codes['phase266']           = Run-Step 'phase266 regression'         'npx tsx scripts/test-phase266-recovery-reconciliation-concurrency.ts'
$codes['phase267-crash']     = Run-Step 'phase267 crash regression'   'npm run test:phase267'
$codes['phase267-shutdown']  = Run-Step 'phase267 shutdown regression' 'npm run test:phase267:shutdown'
$codes['phase268-races']     = Run-Step 'phase268 races'              'npx tsx scripts/test-phase268-recovery-races.ts'
$codes['phase268-audit']     = Run-Step 'phase268 audit boundary'     'npx tsx scripts/test-phase268-audit-boundary.ts'
$codes['phase268-shutdown']  = Run-Step 'phase268 shutdown parity'    'npx tsx scripts/test-phase268-shutdown-parity.ts'
$codes['diffcheck']          = Run-Step 'git diff --check HEAD'       'git diff --check HEAD'

Write-Host "`n===== SUMMARY =====" -ForegroundColor Green
$codes.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-22} exit={1}" -f $_.Key, $_.Value) }
Add-Content -Path $report -Value "`n===== SUMMARY ====="
$codes.GetEnumerator() | ForEach-Object { Add-Content -Path $report -Value ("{0} exit={1}" -f $_.Key, $_.Value) }
Write-Host "`nReport: $report" -ForegroundColor Green

$failed = @($codes.GetEnumerator() | Where-Object { $_.Value -ne 0 })
if ($failed.Count -gt 0) {
  Write-Host "FAIL: one or more verification steps returned nonzero exit codes." -ForegroundColor Red
  exit 1
}

Write-Host "PASS: all verification steps returned exit code 0." -ForegroundColor Green
exit 0

# scripts/phase267-verify.ps1
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\pc\NEXUS'
Set-Location $root
$report = Join-Path $root 'phase267-verification-report.txt'
Remove-Item $report -ErrorAction SilentlyContinue

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
$codes['tsc']        = Run-Step 'tsc --noEmit'                'npx tsc --noEmit'
$codes['phase144']   = Run-Step 'phase144'                    'npx tsx scripts/test-phase144-durable-recovery-operations.ts'
$codes['phase198']   = Run-Step 'phase198'                    'npx tsx scripts/test-phase198-ownership.ts'
$codes['phase265']   = Run-Step 'phase265'                    'npx tsx scripts/test-phase265-recovery-reconciliation-integrity.ts'
$codes['phase266']   = Run-Step 'phase266'                    'npx tsx scripts/test-phase266-recovery-reconciliation-concurrency.ts'
$codes['phase267a']  = Run-Step 'phase267 crash-restart'      'npx tsx scripts/test-phase267-crash-restart-recovery.ts'
$codes['phase267b']  = Run-Step 'phase267 shutdown-reconcile' 'npx tsx scripts/test-phase267-shutdown-reconciliation.ts'
$codes['shutdown']   = Run-Step 'graceful-shutdown'           'npx tsx scripts/test-graceful-shutdown.ts'
$codes['diffcheck']  = Run-Step 'git diff --check'            'git diff --check'

Write-Host "`n===== SUMMARY =====" -ForegroundColor Green
$codes.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-12} exit={1}" -f $_.Key, $_.Value) }
Add-Content -Path $report -Value "`n===== SUMMARY ====="
$codes.GetEnumerator() | ForEach-Object { Add-Content -Path $report -Value ("{0} exit={1}" -f $_.Key, $_.Value) }
Write-Host "`nReport written to $report"

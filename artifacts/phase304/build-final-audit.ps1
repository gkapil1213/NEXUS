# Phase 304d: Final Audit Reconciliation. ASCII-only, no backticks in content.
$ErrorActionPreference = "Stop"
$utf8 = [System.Text.UTF8Encoding]::new($false)

$repoRoot = "C:\Users\pc\NEXUS"
$artifacts = Join-Path $repoRoot "artifacts\phase304"
$outPath = Join-Path $artifacts "phase304d-final-audit-reconciliation.md"

Write-Host "Phase 304d: loading all Phase 304 artifacts..."

$inventory  = Get-Content (Join-Path $artifacts "scripts-inventory.md") -Raw
$evidence   = Get-Content (Join-Path $artifacts "phase304b-evidence-review.md") -Raw
$dependency = Get-Content (Join-Path $artifacts "phase304c-dependency-verification.md") -Raw

# Extract classification counts
$classCounts = @{}
foreach ($m in [regex]::Matches($inventory, '\|\s*(ACTIVE_TEST|DORMANT_TEST|CHILD_HELPER|PHASE_RUNNER|ACTIVE_UTILITY|BACKUP|DEBUG_SCRATCH|EVIDENCE|PROTECTED_RISK|UNKNOWN)\s*\|\s*(\d+)\s*\|')) {
  $classCounts[$m.Groups[1].Value] = [int]$m.Groups[2].Value
}
$totalClassified = 0
foreach ($c in $classCounts.Values) { $totalClassified += $c }

# Extract dependency summary from the Summary section only
$summaryMatch = [regex]::Match(
  $dependency,
  '(?ms)^## Summary\s*\r?\n(?<body>.*?)(?=^## |\z)'
)

if (-not $summaryMatch.Success) {
  throw "Dependency Summary section not found."
}

$depSummary = @{}

foreach ($m in [regex]::Matches(
  $summaryMatch.Groups["body"].Value,
  '(?m)^\|\s*(PASS|FAIL|BLOCKED|NOT EXECUTED)\s*\|\s*(\d+)\s*\|'
)) {
  $depSummary[$m.Groups[1].Value] = [int]$m.Groups[2].Value
}

foreach ($status in @("PASS","FAIL","BLOCKED","NOT EXECUTED")) {
  if (-not $depSummary.ContainsKey($status)) {
    throw "Missing dependency status: $status"
  }
}

$depTotal = 0
foreach ($status in @("PASS","FAIL","BLOCKED","NOT EXECUTED")) {
  $depTotal += $depSummary[$status]
}

# Evidence reconciliation
$evidenceCount = ([regex]::Matches($evidence, '(?m)^### ')).Count

$evidenceCategoryTotal =
  [int]$classCounts["UNKNOWN"] +
  [int]$classCounts["DORMANT_TEST"] +
  [int]$classCounts["BACKUP"] +
  [int]$classCounts["DEBUG_SCRATCH"]

# Inspect safe-runner source and inventory classifications
$runnerPath = Join-Path $repoRoot "scripts\run-safe-regression.ts"
$runnerSource = Get-Content $runnerPath -Raw

$allowList = @(
  [regex]::Matches(
    $runnerSource,
    '(?m)^\s*\{\s*file:\s*"([^"]+)"'
  ) | ForEach-Object { $_.Groups[1].Value }
)

$protectedRiskPaths = @(
  [regex]::Matches(
    $inventory,
    '(?m)^\|\s*`([^`]+)`\s*\|\s*PROTECTED_RISK\s*\|'
  ) | ForEach-Object { $_.Groups[1].Value }
)

$protectedRiskNames = @(
  $protectedRiskPaths | ForEach-Object { Split-Path $_ -Leaf }
)

$allowListOverlap = @(
  $allowList | Where-Object { $protectedRiskNames -contains $_ }
)

# Five evidence-based reconciliation checks
$recon1 = ($totalClassified -eq 564)

$recon2 = (
  $evidenceCount -eq 172 -and
  $evidenceCount -eq $evidenceCategoryTotal
)

$recon3 = ($depTotal -eq 1279)
$recon4 = ($depSummary["FAIL"] -eq 0)

$recon5 = (
  $allowList.Count -eq 4 -and
  $protectedRiskPaths.Count -eq 18 -and
  $allowListOverlap.Count -eq 0
)

if (-not ($recon1 -and $recon2 -and $recon3 -and $recon4 -and $recon5)) {
  throw "Reconciliation failed. Report generation blocked."
}

# Protected-state metadata only. Never read protected JSON contents.
$stateFiles = @(
  "release-state.json",
  "approval-state.json",
  "rollback-state.json",
  "release-manifest.json"
)

$stateStatus = @()

foreach ($sf in $stateFiles) {
  $full = Join-Path $repoRoot $sf

  if (Test-Path -LiteralPath $full -PathType Leaf) {
    $item = Get-Item -LiteralPath $full

    $stateStatus += [PSCustomObject]@{
      File = $sf
      Length = $item.Length
      LastWriteTime = $item.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
    }
  }
}

# Build report
$sb = New-Object System.Text.StringBuilder
$now = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")

$null = $sb.AppendLine("# Phase 304 - Final Audit Reconciliation")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Generated: $now")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("This closing report consolidates the four Phase 304 sub-phases.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("**Scope note:** Phase 304 included static inspection and safe regression execution. Three allow-listed tests passed; one optional test was NOT EXECUTED.")
$null = $sb.AppendLine("This reconciliation generator inspects protected-state file metadata only. It does not read or modify protected-state contents.")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("## 1. Executive Audit Summary")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("The Phase 304 audit examined the scripts/ directory (564 files) to determine")
$null = $sb.AppendLine("what is active, dormant, obsolete, dangerous, duplicated, or uncertain.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("| Phase | Scope | Status |")
$null = $sb.AppendLine("|---|---|---|")
$null = $sb.AppendLine("| 304 preliminary | Initial finding | Complete |")
$null = $sb.AppendLine("| 304a | Classification (564 files) | Complete |")
$null = $sb.AppendLine("| 304b | Evidence review (172 candidates) | Complete |")
$null = $sb.AppendLine("| 304c | Dependency verification (1279 checks) | Complete |")
$null = $sb.AppendLine("| 304d | Final reconciliation (this report) | Complete |")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("**Overall disposition:** No file approved for deletion. No file archived.")
$null = $sb.AppendLine("All 172 candidates remain untouched and require explicit human review before action.")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("## 2. Phase 304a - Inventory Reconciliation")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Total files classified: **$totalClassified**")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("| Classification | Count |")
$null = $sb.AppendLine("|---|---:|")
$order = @("ACTIVE_TEST","DORMANT_TEST","CHILD_HELPER","PHASE_RUNNER","ACTIVE_UTILITY","BACKUP","DEBUG_SCRATCH","EVIDENCE","PROTECTED_RISK","UNKNOWN")
foreach ($k in $order) {
  $v = if ($classCounts.ContainsKey($k)) { $classCounts[$k] } else { 0 }
  $null = $sb.AppendLine("| $k | $v |")
}
$null = $sb.AppendLine("| **Total** | **$totalClassified** |")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Reconciliation: classification total equals 564 files. PASS.")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("## 3. Phase 304b - Evidence and Retention Review")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Files reviewed: **$evidenceCount**")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Breakdown: UNKNOWN=$($classCounts['UNKNOWN']) + DORMANT_TEST=$($classCounts['DORMANT_TEST']) + BACKUP=$($classCounts['BACKUP']) + DEBUG_SCRATCH=$($classCounts['DEBUG_SCRATCH'])")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("**Retention policy:** No file is recommended for deletion or archiving.")
$null = $sb.AppendLine("All labels are triage signals, not decisions.")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("## 4. Phase 304c - Dependency Verification")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Total checks: **$depTotal**")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("| Status | Count |")
$null = $sb.AppendLine("|---|---:|")
$null = $sb.AppendLine("| PASS | $($depSummary['PASS']) |")
$null = $sb.AppendLine("| FAIL | $($depSummary['FAIL']) |")
$null = $sb.AppendLine("| BLOCKED | $($depSummary['BLOCKED']) |")
$null = $sb.AppendLine("| NOT EXECUTED | $($depSummary['NOT EXECUTED']) |")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("## 5. Confirmed Source Correction - boot-once.ts")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("File: **scripts/boot-once.ts**")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Change: import path corrected from one-dot-slash to two-dot-slash.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("- Before: import from dot-slash-src-slash-core-slash-kernel")
$null = $sb.AppendLine("- After: import from dot-dot-slash-src-slash-core-slash-kernel")
$null = $sb.AppendLine("- Resolved target: src/core/kernel.ts exists")
$null = $sb.AppendLine("- Named export: NexusKernel verified present")
$null = $sb.AppendLine("- Verification: target path and named export were checked separately. Root tsconfig excludes scripts/, so tsc -p . does not validate this file.")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("## 6. Outstanding BLOCKED Child-Process Checks")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("The dependency report classifies six child-process checks as BLOCKED.")
$null = $sb.AppendLine("Static inspection did not establish runtime availability or behavior for those commands.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("- npx (Node package executor)")
$null = $sb.AppendLine("- node (Node runtime)")
$null = $sb.AppendLine("- docker (container runtime)")
$null = $sb.AppendLine("- git (version control)")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("**Limitation:** Static reference inspection does not establish whether these commands are available or what they would do at runtime.")
$null = $sb.AppendLine("An execution-based verification phase would be required to resolve these.")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("## 7. Protected-State Safeguards")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("The reconciliation generator used Test-Path and Get-Item to inspect metadata. It did not read protected-state file contents.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("| File | Length (bytes) | LastWriteTime |")
$null = $sb.AppendLine("|---|---:|---|")
foreach ($s in $stateStatus) {
  $null = $sb.AppendLine("| $($s.File) | $($s.Length) | $($s.LastWriteTime) |")
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("No conclusion about modification during the entire Phase 304 period is inferred from LastWriteTime alone.")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("## 8. Safe Regression Allow-List")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("The Phase 304 safe runner (scripts/run-safe-regression.ts) allows exactly four tests:")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("1. test-phase303-kernel-boot-failure.ts")
$null = $sb.AppendLine("2. test-phase302-dispatch-run-details.ts")
$null = $sb.AppendLine("3. test-phase301-bridge-lifecycle.ts")
$null = $sb.AppendLine("4. test-phase301-startrun-honesty.ts")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("**Excluded risky runners (8):**")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("- run-security-regression.ts (aggregate, invokes PROTECTED_RISK scripts)")
$null = $sb.AppendLine("- run-operations-regression.ts (aggregate, invokes PROTECTED_RISK scripts)")
$null = $sb.AppendLine("- test-release-flow.ts (writes release-state.json)")
$null = $sb.AppendLine("- test-approval-protection.ts (writes approval-state.json)")
$null = $sb.AppendLine("- test-approval-artifact-binding.ts (writes approval-state.json)")
$null = $sb.AppendLine("- test-rollback-safety.ts (writes rollback-state.json)")
$null = $sb.AppendLine("- test-tamper-detection.ts (Docker registry, signing)")
$null = $sb.AppendLine("- test-fail-safe.ts (release/approval services)")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Filename-level reconciliation: four configured entries; zero filename overlaps with the 18 PROTECTED_RISK inventory entries. This is not a runtime safety proof.")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("**Observed safe-runner result:** PASS=3, FAIL=0, BLOCKED=0, NOT EXECUTED=1. The optional bridge lifecycle test was NOT EXECUTED.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("The runner exit code of 2 reflects the NOT EXECUTED result; it is not an all-tests-passed result.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## 9. Known Limitations of Regex-Based Static Analysis")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("The Phase 304 audit used regex-based pattern matching. It cannot:")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("- Resolve dynamic imports (import with computed path)")
$null = $sb.AppendLine("- Resolve TypeScript path aliases or tsconfig paths")
$null = $sb.AppendLine("- Detect imports inside template literals or string concatenation")
$null = $sb.AppendLine("- Distinguish actual imports from imports mentioned in comments")
$null = $sb.AppendLine("- Parse JSX or TSX files correctly")
$null = $sb.AppendLine("- Verify external binary presence (npx, node, docker, git)")
$null = $sb.AppendLine("- Analyze runtime behavior")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("These limitations are acceptable for a static audit. A full AST-based analysis")
$null = $sb.AppendLine("would resolve some, but not all, of these. Execution-based verification")
$null = $sb.AppendLine("is required for the BLOCKED child-process items.")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("## 10. Final Action Register")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("### Verified")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("- 1,273 dependency checks PASS")
$null = $sb.AppendLine("- 0 FAIL after boot-once.ts correction")
$null = $sb.AppendLine("- No byte-identical duplicate test files were found by the Phase 304c byte-comparison check; semantic duplication was not assessed")
$null = $sb.AppendLine("- Protected-state filename references are static matches only; they do not prove runtime reads or writes")
$null = $sb.AppendLine("- Safe-runner filenames were compared with PROTECTED_RISK inventory filenames; zero overlaps were found")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("### Blocked (6)")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Six external binary invocations cannot be verified statically:")
$null = $sb.AppendLine("npx, node, docker, git. Requires execution to resolve.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("### Not Executed")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("The dependency summary records 0 NOT EXECUTED and 6 BLOCKED. These are static verification classifications, not proof that all runtime checks were performed.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("### Requiring Human Review")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("- 42 UNKNOWN files (purpose unclear from static analysis)")
$null = $sb.AppendLine("- 112 DORMANT_TEST files (heuristic classification; human review required)")
$null = $sb.AppendLine("- 217 PHASE_RUNNER files (one-off phase scripts, disposition pending)")
$null = $sb.AppendLine("- 10 BACKUP files (retention review; no deletion approved)")
$null = $sb.AppendLine("- 8 DEBUG_SCRATCH files (retention review; no deletion approved)")
$null = $sb.AppendLine("- 18 PROTECTED_RISK files (never auto-execute, never delete without per-file approval)")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("---")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("**Audit artifacts:**")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("- scripts-inventory.md (Phase 304a, 564 files)")
$null = $sb.AppendLine("- phase304b-evidence-review.md (Phase 304b, 172 files)")
$null = $sb.AppendLine("- phase304c-dependency-verification.md (Phase 304c, 1279 checks)")
$null = $sb.AppendLine("- phase304d-final-audit-reconciliation.md (this report)")
$null = $sb.AppendLine("")

[IO.File]::WriteAllText($outPath, $sb.ToString(), $utf8)
Write-Host "final audit written: $outPath"
Write-Host "  size: $((Get-Item $outPath).Length) bytes"
Write-Host "  total classified: $totalClassified"
Write-Host "  evidence entries: $evidenceCount"
Write-Host "  dependency checks: $depTotal"
Write-Host "  reconciliation: recon1=$recon1 recon2=$recon2 recon3=$recon3 recon4=$recon4 recon5=$recon5"
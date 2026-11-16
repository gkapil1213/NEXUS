# Phase 304b: read-only evidence review generator.
# Reads the UNKNOWN, DORMANT_TEST, BACKUP, DEBUG_SCRATCH files from the inventory.
# Produces artifacts/phase304/phase304b-evidence-review.md
# NEVER executes any script. NEVER modifies any file. NEVER touches state files.
$ErrorActionPreference = "Stop"

$repoRoot = "C:\Users\pc\NEXUS"
$scriptsDir = Join-Path $repoRoot "scripts"
$inventoryPath = Join-Path $repoRoot "artifacts\phase304\scripts-inventory.md"
$outPath = Join-Path $repoRoot "artifacts\phase304\phase304b-evidence-review.md"

Write-Host "Phase 304b: loading inventory..."
$inv = [IO.File]::ReadAllText($inventoryPath)

# Extract rows from full inventory table: | `scripts/foo.ts` | CLASS | ...
$rowPattern = [regex]'\|\s*`(scripts/[^`]+)`\s*\|\s*(ACTIVE_TEST|DORMANT_TEST|CHILD_HELPER|PHASE_RUNNER|ACTIVE_UTILITY|BACKUP|DEBUG_SCRATCH|EVIDENCE|PROTECTED_RISK|UNKNOWN)\s*\|'
$fileRows = [regex]::Matches($inv, $rowPattern)
$filesByClass = @{ UNKNOWN = @(); DORMANT_TEST = @(); BACKUP = @(); DEBUG_SCRATCH = @() }
foreach ($m in $fileRows) {
  $path = $m.Groups[1].Value
  $cls = $m.Groups[2].Value
  if ($filesByClass.ContainsKey($cls)) { $filesByClass[$cls] += $path }
}
Write-Host "  UNKNOWN: $($filesByClass['UNKNOWN'].Count)"
Write-Host "  DORMANT_TEST: $($filesByClass['DORMANT_TEST'].Count)"
Write-Host "  BACKUP: $($filesByClass['BACKUP'].Count)"
Write-Host "  DEBUG_SCRATCH: $($filesByClass['DEBUG_SCRATCH'].Count)"

function Get-FileContent([string]$relative) {
  $full = Join-Path $repoRoot $relative
  if (-not (Test-Path $full)) { return "" }
  try { return [IO.File]::ReadAllText($full) } catch { return "" }
}

function Get-PurposeFromComments([string]$content) {
  if (-not $content) { return "" }
  $lines = $content -split "\r?\n"
  $comment = @()
  foreach ($l in ($lines | Select-Object -First 10)) {
    if ($l -match '^\s*//\s*(.+)$') { $comment += $matches[1] }
    elseif ($l -match '^\s*/\*+\s*(.+?)\s*\*+/') { $comment += $matches[1] }
    elseif ($l -match '^\s*\*\s*(.+)$') { $comment += $matches[1] }
    elseif ($l.Trim() -eq "" -and $comment.Count -gt 0) { break }
  }
  return ($comment -join " ").Trim()
}

function Get-ImportList([string]$content) {
  if (-not $content) { return @() }
  $imports = @()
  # import ... from "module"
  $importRx = [regex]'import\s+[^;]*?\s+from\s+"([^"]+)"'
  foreach ($m in $importRx.Matches($content)) { $imports += $m.Groups[1].Value }
  $importRx2 = [regex]"import\s+[^;]*?\s+from\s+'([^']+)'"
  foreach ($m in $importRx2.Matches($content)) { $imports += $m.Groups[1].Value }
  # require("module")
  $reqRx = [regex]'require\(\s*"([^"]+)"\s*\)'
  foreach ($m in $reqRx.Matches($content)) { $imports += $m.Groups[1].Value }
  $reqRx2 = [regex]"require\(\s*'([^']+)'\s*\)"
  foreach ($m in $reqRx2.Matches($content)) { $imports += $m.Groups[1].Value }
  return ($imports | Sort-Object -Unique)
}

function Test-PhaseArtifacts([string]$phase) {
  if (-not $phase) { return @() }
  $found = @()
  $a = Join-Path $repoRoot "artifacts\phase$phase"
  if (Test-Path $a) { $found += "artifacts/phase$phase/" }
  $d = Join-Path $repoRoot "docs\phase$phase"
  if (Test-Path $d) { $found += "docs/phase$phase/" }
  return $found
}

# Build doc corpus
$docBuilder = New-Object System.Text.StringBuilder
foreach ($dir in @("docs", "artifacts", ".github")) {
  $full = Join-Path $repoRoot $dir
  if (Test-Path $full) {
    Get-ChildItem $full -File -Recurse -Include "*.md", "*.yml", "*.yaml" -ErrorAction SilentlyContinue | ForEach-Object {
      try { $null = $docBuilder.AppendLine([IO.File]::ReadAllText($_.FullName)) } catch { }
    }
  }
}
$docCorpus = $docBuilder.ToString()

$sb = New-Object System.Text.StringBuilder
$now = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
$null = $sb.AppendLine("# Phase 304b - Evidence-Based Review")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Generated: $now")
$null = $sb.AppendLine("This report is READ-ONLY. No script was executed. No file was modified or deleted.")
$null = $sb.AppendLine("All recommendations are advisory only.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Scope: 42 UNKNOWN + 112 DORMANT_TEST + 10 BACKUP + 8 DEBUG_SCRATCH = 172 files reviewed.")
$null = $sb.AppendLine("")

$null = $sb.AppendLine("## Section 1: UNKNOWN files (42) - purpose discovery")
$null = $sb.AppendLine("")
foreach ($rel in ($filesByClass['UNKNOWN'] | Sort-Object)) {
  $content = Get-FileContent $rel
  $name = Split-Path $rel -Leaf
  $purpose = Get-PurposeFromComments $content
  $imports = Get-ImportList $content
  $phase = ""
  if ($name -match 'phase(\d+[a-z]?)') { $phase = $matches[1] }
  $phaseArt = Test-PhaseArtifacts $phase
  $mentioned = $docCorpus -match [regex]::Escape($name)
  
  $rec = "REVIEW_FURTHER"
  if ($name -match '\.bak$|\.backup$|\.phase\d+-') { $rec = "BACKUP_REVIEW_REQUIRED" }
  elseif ($imports.Count -eq 0 -and $content.Length -lt 1000) { $rec = "SMALL_SCRIPT_REVIEW" }
  elseif ($phase -and $phaseArt.Count -gt 0) { $rec = "PHASE_ARTIFACT_EXISTS" }
  
  $null = $sb.AppendLine("### $name")
  $null = $sb.AppendLine("- **Path**: scripts/$name")
  $importCount = $imports.Count
  $importList = if ($importCount -gt 0) { ($imports | Select-Object -First 5) -join ", " } else { "(none)" }
  $null = $sb.AppendLine("- **Purpose (from comments)**: $(if ($purpose) { $purpose } else { '(none)' })")
  $null = $sb.AppendLine("- **Imports (first 5)**: $importList")
  $null = $sb.AppendLine("- **Phase**: $(if ($phase) { $phase } else { '(none)' })")
  $phaseArtList = if ($phaseArt.Count -gt 0) { $phaseArt -join ", " } else { "(none)" }
  $null = $sb.AppendLine("- **Phase artifacts**: $phaseArtList")
  $null = $sb.AppendLine("- **Mentioned in docs**: $mentioned")
  $null = $sb.AppendLine("- **Recommendation**: $rec")
  $null = $sb.AppendLine("")
}

$null = $sb.AppendLine("## Section 2: DORMANT_TEST files (112) - wire-up candidates")
$null = $sb.AppendLine("")
foreach ($rel in ($filesByClass['DORMANT_TEST'] | Sort-Object)) {
  $content = Get-FileContent $rel
  $name = Split-Path $rel -Leaf
  $imports = Get-ImportList $content
  $phase = ""
  if ($name -match 'phase(\d+[a-z]?)') { $phase = $matches[1] }
  $phaseArt = Test-PhaseArtifacts $phase
  $mentionsKernel = $content -match 'NexusKernel|openEngine|CONFIG\.'
  $requiresEnv = $content -match 'process\.env\.'
  $isBackup = $name -match '\.bak$|\.backup$|\.phase\d+-'
  
  $rec = "WIRE_UP_CANDIDATE"
  if ($isBackup) { $rec = "POSSIBLE_DUPLICATE_REQUIRES_COMPARISON" }
  elseif ($imports.Count -eq 0) { $rec = "LOW_CONTENT_REQUIRES_REVIEW" }
  elseif ($phaseArt.Count -gt 0) { $rec = "WIRE_UP_PHASE_HAS_ARTIFACTS" }
  
  $null = $sb.AppendLine("### $name")
  $null = $sb.AppendLine("- **Path**: scripts/$name")
  $null = $sb.AppendLine("- **Phase**: $(if ($phase) { $phase } else { '(none)' })")
  $phaseArtList = if ($phaseArt.Count -gt 0) { $phaseArt -join ", " } else { "(none)" }
  $null = $sb.AppendLine("- **Phase artifacts**: $phaseArtList")
  $importCount = $imports.Count
  $importList = if ($importCount -gt 0) { ($imports | Select-Object -First 5) -join ", " } else { "(none)" }
  $null = $sb.AppendLine("- **Imports (first 5)**: $importList")
  $null = $sb.AppendLine("- **Boots kernel**: $mentionsKernel  **Requires env**: $requiresEnv")
  $null = $sb.AppendLine("- **Recommendation**: $rec")
  $null = $sb.AppendLine("")
}

$null = $sb.AppendLine("## Section 3: BACKUP and DEBUG_SCRATCH (18) - retention review")
$null = $sb.AppendLine("")
$combined = @($filesByClass['BACKUP']) + @($filesByClass['DEBUG_SCRATCH']) | Sort-Object -Unique
foreach ($rel in $combined) {
  $name = Split-Path $rel -Leaf
  $full = Join-Path $repoRoot $rel
  $size = if (Test-Path $full) { (Get-Item $full).Length } else { 0 }
  
  $origName = ""
  if ($name -match '^(.+)\.(before|pre|bak|backup|phase\d+)') { $origName = $matches[1] }
  
  $origExists = $false
  if ($origName) {
    $origPath = Join-Path $scriptsDir $origName
    $origExists = Test-Path $origPath
  }
  
  $rec = "REVIEW_FURTHER"
  if ($name -match '^debug-|^diagnose-|^diag-') { $rec = "ARCHIVE_REVIEW_REQUIRED" }
  elseif ($origExists) { $rec = "POSSIBLE_ORIGINAL_EXISTS" }
  elseif ($origName) { $rec = "POSSIBLE_ORIGINAL_NOT_FOUND" }
  
  $null = $sb.AppendLine("### $name")
  $null = $sb.AppendLine("- **Path**: scripts/$name")
  $null = $sb.AppendLine("- **Size**: $size bytes")
  $null = $sb.AppendLine("- **Appears to back up**: $(if ($origName) { $origName } else { '(not determinable)' })")
  $null = $sb.AppendLine("- **Original still exists**: $origExists")
  $null = $sb.AppendLine("- **Recommendation**: $rec")
  $null = $sb.AppendLine("")
}

$null = $sb.AppendLine("## Summary")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("**No file is approved or recommended for deletion or archiving. All 172 entries require human review before any action. Recommendation labels are heuristic triage signals, not verified decisions.**")
$null = $sb.AppendLine("")
$u = $filesByClass['UNKNOWN'].Count
$d = $filesByClass['DORMANT_TEST'].Count
$b = $filesByClass['BACKUP'].Count
$s = $filesByClass['DEBUG_SCRATCH'].Count
$null = $sb.AppendLine("- UNKNOWN: $u files")
$null = $sb.AppendLine("- DORMANT_TEST: $d files")
$null = $sb.AppendLine("- BACKUP: $b files")
$null = $sb.AppendLine("- DEBUG_SCRATCH: $s files")
$null = $sb.AppendLine("- Total: $($u + $d + $b + $s) files reviewed")

[IO.File]::WriteAllText($outPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
Write-Host "evidence review written: $outPath"
Write-Host "  size: $((Get-Item $outPath).Length) bytes"
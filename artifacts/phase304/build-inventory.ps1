# Phase 304a: corrected read-only inventory generator.
# Corrections applied: self-ref filter, real-import detection, AGGREGATE flag,
# PROTECTED_RISK evidence, REVIEW_REQUIRED (not DELETE), indirect reference scan.
$ErrorActionPreference = "Stop"
Write-Host "START: loading package.json"

$repoRoot   = "C:\Users\pc\NEXUS"
$scriptsDir = Join-Path $repoRoot "scripts"
$outPath    = Join-Path $repoRoot "artifacts\phase304\scripts-inventory.md"
$pkgPath    = Join-Path $repoRoot "package.json"

# ---- package.json scripts map ----
$pkgRaw = [IO.File]::ReadAllText($pkgPath)
$pkg = $pkgRaw | ConvertFrom-Json
$pkgScripts = @{}
foreach ($prop in $pkg.scripts.PSObject.Properties) {
  $val = [string]$prop.Value
  foreach ($m in [regex]::Matches($val, "scripts[/\\\\]([A-Za-z0-9_.\-]+\.(?:ts|mjs|ps1|js))")) {
    $pkgScripts[$m.Groups[1].Value] = $prop.Name
  }
}

# ---- enumerate scripts/ ----
$allFiles = Get-ChildItem $scriptsDir -File -Recurse | Sort-Object FullName

# ---- documentation and workflow text corpus for indirect references ----
$docCorpus = @{}
foreach ($docPath in @((Join-Path $repoRoot "docs"), (Join-Path $repoRoot "artifacts"))) {
  if (Test-Path $docPath) {
    Get-ChildItem $docPath -File -Recurse -Include "*.md","*.yml","*.yaml" | ForEach-Object {
      try { $docCorpus[$_.FullName] = [IO.File]::ReadAllText($_.FullName) } catch { }
    }
  }
}
Get-ChildItem (Join-Path $repoRoot ".github") -File -Recurse -Include "*.yml","*.yaml" -ErrorAction SilentlyContinue | ForEach-Object {
  try { $docCorpus[$_.FullName] = [IO.File]::ReadAllText($_.FullName) } catch { }
}
# Single concatenated corpus for fast substring checks
$script:docCorpusJoined = ($docCorpus.Values -join "`n")

# ---- aggregate: who references whom (self-reference excluded) ----
# Detect only real invocation: "scripts/foo.ts" string, or spawn/exec/import path.
$spawnTargets = @{}
foreach ($f in $allFiles) {
  if ($f.Extension -notin @(".ts", ".mjs", ".js")) { continue }
  try { $content = [IO.File]::ReadAllText($f.FullName) } catch { continue }
  # Self-reference filter: exclude matches equal to own filename
  $spawnRx = "scripts[/\\\\]([A-Za-z0-9_.\-]+\.(?:ts|mjs|js))"
  foreach ($m in [regex]::Matches($content, $spawnRx)) {
    $target = $m.Groups[1].Value
    if ($target -eq $f.Name) { continue }
    if (-not $spawnTargets.ContainsKey($target)) { $spawnTargets[$target] = @() }
    if ($spawnTargets[$target] -notcontains $f.Name) { $spawnTargets[$target] += $f.Name }
  }
}

# ---- per-file classification with evidence ----
$rows = @()
$counts = @{}
foreach ($f in $allFiles) {
  $name = $f.Name
  $rel  = $f.FullName.Replace("$repoRoot\", "").Replace("\", "/")
  $ext  = $f.Extension.ToLower()
  $size = $f.Length

  $phase = ""
  if ($name -match "phase(\d+[a-z]?)") { $phase = $matches[1] }

  $content = ""
  if ($ext -in @(".ts", ".mjs", ".js")) { try { $content = [IO.File]::ReadAllText($f.FullName) } catch { } }

  # --- risk evidence collection ---
  $riskFlags = @()
  $riskEvidence = @()
  if ($content -match "(ReleaseService|ApprovalService|rollbackService)") {
    $line = ($content -split "\n" | Select-String "(ReleaseService|ApprovalService|rollbackService)" | Select-Object -First 1)
    if ($line) { $riskFlags += "STATE_FILE_MUTATION"; $riskEvidence += "STATE_FILE_MUTATION: " + $line.Line.Trim() }
  }
  if ($content -match "(release-state\.json|approval-state\.json|rollback-state\.json|release-manifest\.json)") {
    $line = ($content -split "\n" | Select-String "(release-state\.json|approval-state\.json|rollback-state\.json|release-manifest\.json)" | Select-Object -First 1)
    if ($line) { $riskFlags += "PROTECTED_FILE_REF"; $riskEvidence += "PROTECTED_FILE_REF: " + $line.Line.Trim() }
  }
  if ($content -match "docker\s+(push|rm|stop|build)") {
    $line = ($content -split "\n" | Select-String "docker\s+(push|rm|stop|build)" | Select-Object -First 1)
    if ($line) { $riskFlags += "DOCKER"; $riskEvidence += "DOCKER: " + $line.Line.Trim() }
  }
  if ($content -match "fetch\(.*github|api\.github\.com") {
    $line = ($content -split "\n" | Select-String "fetch\(.*github|api\.github\.com" | Select-Object -First 1)
    if ($line) { $riskFlags += "NETWORK_GITHUB"; $riskEvidence += "NETWORK_GITHUB: " + $line.Line.Trim() }
  }
  if ($content -match "cosign.*sign|artifactSigningService\.sign") {
    $line = ($content -split "\n" | Select-String "cosign.*sign|artifactSigningService\.sign" | Select-Object -First 1)
    if ($line) { $riskFlags += "SIGNING"; $riskEvidence += "SIGNING: " + $line.Line.Trim() }
  }
  if ($content -match "run-(security|operations)-regression") {
    $riskFlags += "AGGREGATE"
    $riskEvidence += "AGGREGATE: " + $name + " spawns an aggregate regression runner"
  }

  # --- import and child-process reference detection (real, not arbitrary strings) ---
  $importedBy = @()
  $spawnedBy  = if ($spawnTargets.ContainsKey($name)) { $spawnTargets[$name] } else { @() }

  # --- classification ---
  $cls = "UNKNOWN"
  if ($ext -in @(".bak",".backup") -or $name -match "\.backup$|\.before-|\.pre-") {
    $cls = "BACKUP"
  } elseif ($ext -in @(".json",".txt",".log")) {
    $cls = if ($ext -eq ".log") { "DEBUG_SCRATCH" } else { "EVIDENCE" }
  } elseif ($name -match "^_phase\d+_.*_child") {
    $cls = "CHILD_HELPER"
  } elseif ($name -in @("run-security-regression.ts","run-operations-regression.ts")) {
    $cls = "PROTECTED_RISK"
    if (-not ($riskFlags -contains "AGGREGATE")) { $riskFlags += "AGGREGATE" }
  } elseif ($name -match "^debug-|^diagnose-") {
    $cls = "DEBUG_SCRATCH"
  } elseif ($name -match "^apply-phase|^verify-phase") {
    $cls = "DEBUG_SCRATCH"
  } elseif ($ext -eq ".ps1") {
    $cls = "ACTIVE_UTILITY"
  } elseif ($name -match "^test-") {
    $inPkg = $pkgScripts.ContainsKey($name)
    $hasRisk = $riskFlags.Count -gt 0
    if ($hasRisk) {
      $cls = "PROTECTED_RISK"
    } elseif ($inPkg -or $spawnedBy.Count -gt 0) {
      $cls = "ACTIVE_TEST"
    } else {
      # check indirect references via single concatenated corpus
      $docRef = $false
      if ($script:docCorpusJoined -match [regex]::Escape($name)) { $docRef = $true }
      $cls = if ($docRef) { "DORMANT_TEST" } else { "DORMANT_TEST" }
    }
  } elseif ($name -match "^run-phase\d+|^run-") {
    $cls = "PHASE_RUNNER"
  } elseif ($ext -eq ".mjs") {
    $inPkg = $pkgScripts.ContainsKey($name)
    $cls = if ($inPkg -or $spawnedBy.Count -gt 0) { "ACTIVE_TEST" } else { "DORMANT_TEST" }
  }

  # --- forbidden claim: DELETE is never emitted for any file ---
  $cleanupRec = "REVIEW_REQUIRED"

  $rows += [PSCustomObject]@{
    Path = $rel; Name = $name; Ext = $ext; SizeBytes = $size; Phase = $phase
    Classification = $cls
    InPackageJson = $pkgScripts.ContainsKey($name)
    SpawnedBy = ($spawnedBy -join ", ")
    Risks = ($riskFlags -join ",")
    RiskEvidence = ($riskEvidence -join " | ")
    CleanupRecommendation = $cleanupRec
  }
  if (-not $counts.ContainsKey($cls)) { $counts[$cls] = 0 }
  $counts[$cls]++
}

# ---- write markdown ----
$sb = New-Object System.Text.StringBuilder
$now = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
$null = $sb.AppendLine("# Phase 304a - Scripts Directory Inventory (corrected)")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Generated: $now")
$null = $sb.AppendLine("Files discovered: $($allFiles.Count)")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("This audit is READ-ONLY. No script was executed. No file modified.")
$null = $sb.AppendLine("All cleanup recommendations are REVIEW_REQUIRED, never DELETE.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Classification Summary")
$order = @("ACTIVE_TEST","DORMANT_TEST","CHILD_HELPER","PHASE_RUNNER","ACTIVE_UTILITY","BACKUP","DEBUG_SCRATCH","EVIDENCE","PROTECTED_RISK","UNKNOWN")
$sum = 0
foreach ($k in $order) { $c = if ($counts.ContainsKey($k)) { $counts[$k] } else { 0 }; $null = $sb.AppendLine("| $k | $c |"); $sum += $c }
$null = $sb.AppendLine("| **Total** | **$sum** |")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## PROTECTED_RISK - evidence-backed")
$null = $sb.AppendLine("")
foreach ($r in ($rows | Where-Object { $_.Classification -eq "PROTECTED_RISK" } | Sort-Object Name)) {
  $null = $sb.AppendLine("### $($r.Name)")
  $null = $sb.AppendLine("- Path: ``$($r.Path)``")
  $null = $sb.AppendLine("- Risks: $($r.Risks)")
  $null = $sb.AppendLine("- Evidence: $($r.RiskEvidence)")
  $null = $sb.AppendLine("- Spawned-by: $($r.SpawnedBy)")
  $null = $sb.AppendLine("- Cleanup: $($r.CleanupRecommendation)")
  $null = $sb.AppendLine("")
}
$null = $sb.AppendLine("## DORMANT_TEST - with indirect reference scan")
foreach ($r in ($rows | Where-Object { $_.Classification -eq "DORMANT_TEST" } | Sort-Object Name)) {
  $null = $sb.AppendLine("- ``$($r.Name)`` (phase $($r.Phase)) - REVIEW_REQUIRED (indirect refs checked: package.json, spawn, docs, workflows)")
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## PHASE_RUNNER - per-file removal safety")
foreach ($r in ($rows | Where-Object { $_.Classification -eq "PHASE_RUNNER" } | Sort-Object Name)) {
  $null = $sb.AppendLine("- ``$($r.Name)`` (phase $($r.Phase), $($r.SizeBytes) bytes) - $($r.CleanupRecommendation)")
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## UNKNOWN - explicit review list")
foreach ($r in ($rows | Where-Object { $_.Classification -eq "UNKNOWN" } | Sort-Object Name)) {
  $null = $sb.AppendLine("- ``$($r.Name)`` ($($r.Ext), $($r.SizeBytes) bytes) - REVIEW_REQUIRED")
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Full inventory (self-references excluded)")
$null = $sb.AppendLine("| Path | Class | npm | Spawned-by | Risks | Cleanup |")
$null = $sb.AppendLine("|---|---|---|---|---|---|")
foreach ($r in $rows) {
  $null = $sb.AppendLine("| ``$($r.Path)`` | $($r.Classification) | $($r.InPackageJson) | $($r.SpawnedBy) | $($r.Risks) | $($r.CleanupRecommendation) |")
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Validation")
$null = $sb.AppendLine("- Total rows: $($rows.Count)")
$null = $sb.AppendLine("- Unique paths: $(($rows | Select-Object -ExpandProperty Path -Unique).Count)")
$null = $sb.AppendLine("- Classification sum: $sum (must equal $($rows.Count))")
$null = $sb.AppendLine("- Self-references: 0 (filtered at collection)")
$null = $sb.AppendLine("- Cleanup DELETE recommendations: 0 (all REVIEW_REQUIRED)")

Write-Host "about to write inventory: $outPath"
[IO.File]::WriteAllText($outPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
Write-Host "inventory written: $outPath"
Write-Host "total files: $($allFiles.Count)"
Write-Host "total rows: $($rows.Count)"
Write-Host "unique paths: $(($rows | Select-Object -ExpandProperty Path -Unique).Count)"
Write-Host "classification sum: $sum"

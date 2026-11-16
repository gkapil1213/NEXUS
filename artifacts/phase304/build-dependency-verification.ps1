# Phase 304c: dependency and reference verification.
# READ-ONLY. No scripts executed. No files modified. No state files touched.
# Produces artifacts/phase304/phase304c-dependency-verification.md
$ErrorActionPreference = "Stop"

$repoRoot = "C:\Users\pc\NEXUS"
$scriptsDir = Join-Path $repoRoot "scripts"
$evidencePath = Join-Path $repoRoot "artifacts\phase304\phase304b-evidence-review.md"
$outPath = Join-Path $repoRoot "artifacts\phase304\phase304c-dependency-verification.md"

Write-Host "Phase 304c: loading Phase 304b evidence..."
$evidence = [IO.File]::ReadAllText($evidencePath)

# Extract the 172 reviewed files from "### filename" sections
$fileHeaders = [regex]::Matches($evidence, '(?m)^### (.+)$')
$reviewedFiles = @()
foreach ($m in $fileHeaders) {
  $name = $m.Groups[1].Value.Trim()
  $reviewedFiles += $name
}
Write-Host "  Files in evidence report: $($reviewedFiles.Count)"

# Helper functions
function Get-FileText([string]$relative) {
  $full = Join-Path $repoRoot $relative
  if (-not (Test-Path $full)) { return "" }
  try { return [IO.File]::ReadAllText($full) } catch { return "" }
}

function Test-FileExists([string]$relative) {
  return Test-Path (Join-Path $repoRoot $relative)
}

function Resolve-ImportPath([string]$fromFile, [string]$importSpec) {
  # Returns: @{ status = PASS|FAIL|BLOCKED|NOT_EXECUTED; resolvedTo = "path"; reason = "..." }
  if ($importSpec.StartsWith("./") -or $importSpec.StartsWith("../")) {
    $baseDir = Split-Path $fromFile -Parent
    $candidate = Join-Path $baseDir $importSpec
    # Normalize
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $candidate))
    $relativeToRepo = $candidate.Replace($repoRoot, "").TrimStart("\").Replace("\", "/")
    $exts = @("", ".ts", ".mjs", ".js", ".tsx", "/index.ts", "/index.mjs", "/index.js")
    foreach ($ext in $exts) {
      $tryPath = $relativeToRepo + $ext
      if (Test-Path (Join-Path $repoRoot $tryPath)) {
        return @{ status = "PASS"; resolvedTo = $tryPath; reason = "resolved" }
      }
    }
    return @{ status = "FAIL"; resolvedTo = ""; reason = "import '$importSpec' from '$fromFile' not found" }
  }
  # Node builtin or npm package
  if ($importSpec -match "^node:") { return @{ status = "PASS"; resolvedTo = "(node builtin)"; reason = "node: builtin" } }
  if ($importSpec -in @("fs","path","crypto","util","os","stream","events","net","tls","dns","http","https","url","worker_threads","readline","child_process","assert","buffer","querystring")) {
    return @{ status = "PASS"; resolvedTo = "(node builtin)"; reason = "node builtin" }
  }
  # npm package
  $pkgRoot = Join-Path $repoRoot "node_modules"
  $pkgName = $importSpec.Split("/")[0]
  if ($importSpec.StartsWith("@")) { $pkgName = ($importSpec.Split("/") | Select-Object -First 2) -join "/" }
  if (Test-Path (Join-Path $pkgRoot $pkgName)) {
    return @{ status = "PASS"; resolvedTo = "node_modules/$pkgName"; reason = "npm package present" }
  }
  return @{ status = "FAIL"; resolvedTo = ""; reason = "npm package '$pkgName' not installed" }
}

function Test-BinaryOrFile([string]$cmd, [string[]]$args) {
  # If first arg looks like scripts/foo.ts, verify it exists
  foreach ($a in $args) {
    if ($a -match "scripts[/\\]([A-Za-z0-9_.\-]+\.(?:ts|mjs|js|ps1))") {
      $rel = "scripts/" + $matches[1]
      if (Test-Path (Join-Path $repoRoot $rel)) {
        return @{ status = "PASS"; target = $rel; reason = "target file exists" }
      }
      return @{ status = "FAIL"; target = $rel; reason = "target file missing" }
    }
  }
  # Otherwise external binary
  return @{ status = "BLOCKED"; target = $cmd; reason = "external binary, cannot verify without execution" }
}

# ---- Per-file analysis ----
$results = @()
$importResults = @{ PASS = 0; FAIL = 0; BLOCKED = 0; NOT_EXECUTED = 0 }
$spawnResults = @{ PASS = 0; FAIL = 0; BLOCKED = 0; NOT_EXECUTED = 0 }
$ps1Results = @{ PASS = 0; FAIL = 0; BLOCKED = 0; NOT_EXECUTED = 0 }
$protectedHits = @()

foreach ($fname in $reviewedFiles) {
  # Try to find the actual file path — could be in scripts/
  $rel = "scripts/$fname"
  if (-not (Test-Path (Join-Path $repoRoot $rel))) {
    # Try without scripts/ prefix
    if (Test-Path (Join-Path $repoRoot $fname)) { $rel = $fname } else { continue }
  }
  $content = Get-FileText $rel
  if (-not $content) { continue }

  # --- TypeScript imports ---
  $importMatches = [regex]::Matches($content, "import\s+[^;]*?\s+from\s+[""']([^""']+)[""']")
  foreach ($im in $importMatches) {
    $spec = $im.Groups[1].Value
    $res = Resolve-ImportPath $rel $spec
    $importResults[$res.status] = $importResults[$res.status] + 1
    $results += [PSCustomObject]@{
      File = $rel
      Check = "IMPORT"
      Detail = "$spec -> $($res.resolvedTo) ($($res.reason))"
      Status = $res.status
    }
  }

  # --- spawn/exec calls ---
  $spawnMatches = [regex]::Matches($content, "(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*[""']([^""']+)[""']\s*,\s*\[([^\]]*)\]")
  foreach ($sm in $spawnMatches) {
    $cmd = $sm.Groups[1].Value
    $argsRaw = $sm.Groups[2].Value
    $argsArray = @()
    foreach ($am in [regex]::Matches($argsRaw, "[""']([^""']+)[""']")) {
      $argsArray += $am.Groups[1].Value
    }
    $res = Test-BinaryOrFile $cmd $argsArray
    $spawnResults[$res.status] = $spawnResults[$res.status] + 1
    $results += [PSCustomObject]@{
      File = $rel
      Check = "SPAWN"
      Detail = "$cmd $($argsArray -join ' ') -> $($res.target) ($($res.reason))"
      Status = $res.status
    }
  }

  # --- PowerShell references ---
  $ps1Matches = [regex]::Matches($content, "scripts[/\\]([A-Za-z0-9_.\-]+\.ps1)")
  foreach ($pm in $ps1Matches) {
    $ps1Name = $pm.Groups[1].Value
    $ps1Rel = "scripts/$ps1Name"
    if (Test-Path (Join-Path $repoRoot $ps1Rel)) {
      $ps1Results["PASS"] = $ps1Results["PASS"] + 1
      $results += [PSCustomObject]@{ File = $rel; Check = "PS1"; Detail = $ps1Rel; Status = "PASS" }
    } else {
      $ps1Results["FAIL"] = $ps1Results["FAIL"] + 1
      $results += [PSCustomObject]@{ File = $rel; Check = "PS1"; Detail = "$ps1Rel missing"; Status = "FAIL" }
    }
  }

  # --- Protected state files ---
  $stateMatches = [regex]::Matches($content, "(release-state\.json|approval-state\.json|rollback-state\.json|release-manifest\.json)")
  if ($stateMatches.Count -gt 0) {
    $unique = ($stateMatches | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique) -join ", "
    $protectedHits += [PSCustomObject]@{ File = $rel; StateFiles = $unique }
  }
}

# --- package.json chain verification ---
$pkgRaw = Get-FileText "package.json"
$pkg = $pkgRaw | ConvertFrom-Json
$pkgChainResults = @()
foreach ($prop in $pkg.scripts.PSObject.Properties) {
  $val = [string]$prop.Value
  foreach ($m in [regex]::Matches($val, "scripts[/\\]([A-Za-z0-9_.\-]+\.(?:ts|mjs|js|ps1))")) {
    $referenced = "scripts/" + $m.Groups[1].Value
    $exists = Test-Path (Join-Path $repoRoot $referenced)
    $pkgChainResults += [PSCustomObject]@{
      ScriptName = $prop.Name
      Referenced = $referenced
      Exists = $exists
    }
  }
}
$pkgFailCount = @($pkgChainResults | Where-Object { -not $_.Exists }).Count
$pkgPassCount = @($pkgChainResults | Where-Object { $_.Exists }).Count

# --- Duplicate test detection by content hash ---
$suspectedDupes = @()
$dormantTests = $results | Where-Object { $_.Check -eq "IMPORT" } | Select-Object -ExpandProperty File -Unique
$allTests = Get-ChildItem $scriptsDir -Filter "test-*.ts" -File | Select-Object -ExpandProperty Name
$hashMap = @{}
foreach ($t in $allTests) {
  $full = Join-Path $scriptsDir $t
  $h = (Get-FileHash $full -Algorithm SHA256).Hash
  if (-not $hashMap.ContainsKey($h)) { $hashMap[$h] = @() }
  $hashMap[$h] += $t
}
$confirmedDupes = @()
foreach ($kv in $hashMap.GetEnumerator()) {
  if ($kv.Value.Count -gt 1) {
    $confirmedDupes += [PSCustomObject]@{ Hash = $kv.Key; Files = $kv.Value }
  }
}

# --- Summary counts ---
$totalChecks = $results.Count + $pkgChainResults.Count
$passCount = $importResults["PASS"] + $spawnResults["PASS"] + $ps1Results["PASS"] + $pkgPassCount
$failCount = $importResults["FAIL"] + $spawnResults["FAIL"] + $ps1Results["FAIL"] + $pkgFailCount
$blockedCount = $importResults["BLOCKED"] + $spawnResults["BLOCKED"] + $ps1Results["BLOCKED"]
$neCount = $importResults["NOT_EXECUTED"] + $spawnResults["NOT_EXECUTED"] + $ps1Results["NOT_EXECUTED"]

# --- Write report ---
$sb = New-Object System.Text.StringBuilder
$now = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
$null = $sb.AppendLine("# Phase 304c - Dependency and Reference Verification")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Generated: $now")
$null = $sb.AppendLine("READ-ONLY. No scripts executed. No files modified. No state files accessed.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Summary")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("| Status | Count |")
$null = $sb.AppendLine("|---|---:|")
$null = $sb.AppendLine("| PASS | $passCount |")
$null = $sb.AppendLine("| FAIL | $failCount |")
$null = $sb.AppendLine("| BLOCKED | $blockedCount |")
$null = $sb.AppendLine("| NOT EXECUTED | $neCount |")
$null = $sb.AppendLine("| **Total checks** | **$totalChecks** |")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Files reviewed: $($reviewedFiles.Count)")
$null = $sb.AppendLine("Import checks: $($importResults.Values | Measure-Object -Sum | Select-Object -ExpandProperty Sum)")
$null = $sb.AppendLine("Spawn checks: $($spawnResults.Values | Measure-Object -Sum | Select-Object -ExpandProperty Sum)")
$null = $sb.AppendLine("PowerShell reference checks: $($ps1Results.Values | Measure-Object -Sum | Select-Object -ExpandProperty Sum)")
$null = $sb.AppendLine("package.json chains verified: $($pkgChainResults.Count)")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Check 1: TypeScript imports")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("| Status | Count |")
$null = $sb.AppendLine("|---|---:|")
foreach ($k in @("PASS","FAIL","BLOCKED","NOT_EXECUTED")) {
  $null = $sb.AppendLine("| $k | $($importResults[$k]) |")
}
$null = $sb.AppendLine("")
$failImports = @($results | Where-Object { $_.Check -eq "IMPORT" -and $_.Status -eq "FAIL" })
if ($failImports.Count -gt 0) {
  $null = $sb.AppendLine("### FAILED imports")
  foreach ($fi in $failImports) {
    $null = $sb.AppendLine("- ``$($fi.File)``: $($fi.Detail)")
  }
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Check 2: PowerShell invocations")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("| Status | Count |")
$null = $sb.AppendLine("|---|---:|")
foreach ($k in @("PASS","FAIL")) {
  $null = $sb.AppendLine("| $k | $($ps1Results[$k]) |")
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Check 3: package.json script chains")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("Verified $($pkgChainResults.Count) references in package.json scripts.")
$null = $sb.AppendLine("- PASS (file exists): $pkgPassCount")
$null = $sb.AppendLine("- FAIL (file missing): $pkgFailCount")
if ($pkgFailCount -gt 0) {
  $null = $sb.AppendLine("")
  $null = $sb.AppendLine("### Missing package.json targets")
  foreach ($p in ($pkgChainResults | Where-Object { -not $_.Exists })) {
    $null = $sb.AppendLine("- ``$($p.Referenced)`` (referenced by ``$($p.ScriptName)``)")
  }
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Check 4: Child-process execution paths")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("| Status | Count |")
$null = $sb.AppendLine("|---|---:|")
foreach ($k in @("PASS","FAIL","BLOCKED")) {
  $null = $sb.AppendLine("| $k | $($spawnResults[$k]) |")
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("BLOCKED items are external binaries (npx, node, docker, git) that cannot be verified statically.")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Check 5: Suspected duplicate tests (by content hash)")
$null = $sb.AppendLine("")
if ($confirmedDupes.Count -eq 0) {
  $null = $sb.AppendLine("No byte-identical duplicate test files found.")
} else {
  $null = $sb.AppendLine("Found $($confirmedDupes.Count) content-identical test groups:")
  foreach ($d in $confirmedDupes) {
    $null = $sb.AppendLine("- SHA256 ``$($d.Hash.Substring(0, 12))...``: $($d.Files -join ', ')"
    )
  }
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Check 6: Protected-state access")
$null = $sb.AppendLine("")
if ($protectedHits.Count -eq 0) {
  $null = $sb.AppendLine("No files reference release-state.json, approval-state.json, rollback-state.json, or release-manifest.json.")
} else {
  $null = $sb.AppendLine("| File | State files referenced |")
  $null = $sb.AppendLine("|---|---|")
  foreach ($p in $protectedHits) {
    $null = $sb.AppendLine("| ``$($p.File)`` | $($p.StateFiles) |")
  }
}
$null = $sb.AppendLine("")
$null = $sb.AppendLine("## Check 7: Reconciliation")
$null = $sb.AppendLine("")
$null = $sb.AppendLine("- Files reviewed: $($reviewedFiles.Count)")
$null = $sb.AppendLine("- Total checks: $totalChecks")
$null = $sb.AppendLine("- PASS + FAIL + BLOCKED + NOT_EXECUTED = $($passCount + $failCount + $blockedCount + $neCount)")
$null = $sb.AppendLine("- All checks accounted for: $($totalChecks -eq ($passCount + $failCount + $blockedCount + $neCount))")

[IO.File]::WriteAllText($outPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
Write-Host "verification report written: $outPath"
Write-Host "  size: $((Get-Item $outPath).Length) bytes"
Write-Host "  files reviewed: $($reviewedFiles.Count)"
Write-Host "  total checks: $totalChecks"
Write-Host "  PASS: $passCount"
Write-Host "  FAIL: $failCount"
Write-Host "  BLOCKED: $blockedCount"
Write-Host "  NOT EXECUTED: $neCount"
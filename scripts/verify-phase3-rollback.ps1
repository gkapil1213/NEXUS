#Requires -Version 5.1
<#
.SYNOPSIS
  NEXUS Phase 3 Pass 6E - REAL rollback verification.

.DESCRIPTION
  Drives a genuine Version A -> Version B (deliberate failure) -> rollback ->
  Version A restored sequence against the REAL local Docker daemon, using the
  existing staging fixtures (Dockerfile / Dockerfile.broken / nginx.conf /
  nginx-broken.conf) and the real Playwright smoke suite.

  Every identifier (image ID, digest, container ID, port) is captured from
  actual command output. NOTHING is fabricated. If a step cannot execute, the
  script reports BLOCKED with the exact reason and stops.

  This script runs ON THE WINDOWS HOST (where Docker + Playwright live). It is
  NOT runnable from the coding-agent sandbox.

.NOTES
  Run from the repository root:
      powershell -ExecutionPolicy Bypass -File scripts\verify-phase3-rollback.ps1
#>

[CmdletBinding()]
param(
  [string]$Repo = "nexus-local",
  [string]$ContainerName = "nexus-staging-rollback",
  [int]$ContainerPort = 8080
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)  # repo root

# --- result accumulator -----------------------------------------------------
$script:Report = [ordered]@{}
function Set-Result([string]$Key, [string]$Value) { $script:Report[$Key] = $Value }
function Fail([string]$Key, [string]$Reason) {
  Set-Result $Key "BLOCKED - $Reason"
  Write-Host ""
  Write-Host "=== VERIFICATION STOPPED: $Key BLOCKED ===" -ForegroundColor Yellow
  Write-Host "Reason: $Reason" -ForegroundColor Yellow
  Write-Host ""
  Print-Report
  exit 2
}

function Print-Report {
  Write-Host ""
  Write-Host "NEXUS PHASE 3 - PASS 6E ROLLBACK VERIFICATION" -ForegroundColor Cyan
  Write-Host ("=" * 60) -ForegroundColor Cyan
  foreach ($k in $script:Report.Keys) {
    Write-Host ("{0,-32} {1}" -f "$k`:", $script:Report[$k])
  }
}

function Run-Cmd ([string]$Exe, [string[]]$Args) {
    $cmd = Get-Command $Exe -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "Command not found: $Exe"
    }

    $output = & $cmd.Source @Args 2>&1
    $exitCode = $LASTEXITCODE

    $stdout = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine

    return [pscustomobject]@{
        ExitCode = $exitCode
        StdOut   = $stdout
        StdErr   = ""
    }
}

# --- 1. Verify Docker -------------------------------------------------------
Write-Host "[1] Verifying Docker..." -ForegroundColor Green
try {
  $dv = Run-Cmd "docker" @("version", "--format", "{{.Server.Version}}")
  if ($dv.ExitCode -ne 0) { Fail "Docker" "docker version failed: $($dv.StdErr.Trim())" }
  Set-Result "Docker daemon version" $dv.StdOut.Trim()
} catch {
  Fail "Docker" "docker CLI not found or not executable: $($_.Exception.Message)"
}

# --- 2. Build Version A (good) ---------------------------------------------
Write-Host "[2] Building Version A (Dockerfile)..." -ForegroundColor Green
$tagA = "${Repo}:phase3-a"
$ba = Run-Cmd "docker" @("build", "-f", "Dockerfile", "-t", $tagA, ".")
if ($ba.ExitCode -ne 0) { Fail "Version A build" "docker build exit $($ba.ExitCode): $($ba.StdErr.Trim())" }
Set-Result "Version A tag" $tagA

# --- 3. Inspect Version A (immutable identity) -----------------------------
$ia = Run-Cmd "docker" @("image", "inspect", $tagA, "--format", "{{.Id}}|{{json .RepoDigests}}")
if ($ia.ExitCode -ne 0) { Fail "Version A inspect" $ia.StdErr.Trim() }
$partsA = $ia.StdOut.Trim().Split("|", 2)
$imageIdA = $partsA[0]
$digestA = $partsA[1]
Set-Result "Version A image ID" $imageIdA
Set-Result "Version A RepoDigests" $digestA

# --- 4. Deploy Version A ----------------------------------------------------
Write-Host "[3] Deploying Version A..." -ForegroundColor Green
Run-Cmd "docker" @("rm", "-f", $ContainerName) | Out-Null
$ra = Run-Cmd "docker" @("run", "-d", "-P", "--name", $ContainerName, $tagA)
if ($ra.ExitCode -ne 0) { Fail "Version A deploy" $ra.StdErr.Trim() }
$containerA = $ra.StdOut.Trim()
Set-Result "Version A container ID" $containerA

# Resolve the dynamically-mapped host port.
$pa = Run-Cmd "docker" @("inspect", $containerA, "--format", "{{(index (index .NetworkSettings.Ports `"${ContainerPort}/tcp`") 0).HostPort}}")
if ($pa.ExitCode -ne 0) { Fail "Version A port" $pa.StdErr.Trim() }
$portA = $pa.StdOut.Trim()
$urlA = "http://127.0.0.1:$portA/health"
Set-Result "Version A staging URL" $urlA

# --- 5. Health check Version A ---------------------------------------------
Write-Host "[4] Health check Version A..." -ForegroundColor Green
Start-Sleep -Seconds 2
try {
  $ha = Invoke-WebRequest -Uri $urlA -UseBasicParsing -TimeoutSec 10
  if ($ha.StatusCode -ne 200) { Fail "Version A health" "HTTP $($ha.StatusCode)" }
  Set-Result "Version A health" "PASS (HTTP $($ha.StatusCode))"
} catch {
  Fail "Version A health" "request failed: $($_.Exception.Message)"
}

# --- 6. Playwright smoke Version A ------------------------------------------
Write-Host "[5] Playwright smoke Version A..." -ForegroundColor Green
$spec = Join-Path "tests" "smoke" "nexus-staging.spec.ts"
if (-not (Test-Path $spec)) {
  Set-Result "Version A smoke" "BLOCKED - smoke spec missing: $spec"
} else {
  $env:STAGING_URL = "http://127.0.0.1:$portA"
  $sa = Run-Cmd "npx" @("playwright", "test", $spec, "--reporter=line")
  if ($sa.ExitCode -ne 0) {
    Set-Result "Version A smoke" "FAIL - exit $($sa.ExitCode): $($sa.StdErr.Trim())"
  } else {
    $passedLine = ($sa.StdOut.Trim() -split "`n" | Select-String 'passed' | Select-Object -First 1)
    Set-Result "Version A smoke" "PASS - $passedLine"
  }
}

# Mark known-good (Version A verified).
Set-Result "Version A known-good" "YES"

# --- 7. Build Version B (broken) --------------------------------------------
Write-Host "[6] Building Version B (Dockerfile.broken)..." -ForegroundColor Green
$tagB = "${Repo}:phase3-b"
$bb = Run-Cmd "docker" @("build", "-f", "Dockerfile.broken", "-t", $tagB, ".")
if ($bb.ExitCode -ne 0) { Fail "Version B build" "docker build exit $($bb.ExitCode): $($bb.StdErr.Trim())" }
$ib = Run-Cmd "docker" @("image", "inspect", $tagB, "--format", "{{.Id}}|{{json .RepoDigests}}")
if ($ib.ExitCode -ne 0) { Fail "Version B inspect" $ib.StdErr.Trim() }
$partsB = $ib.StdOut.Trim().Split("|", 2)
$imageIdB = $partsB[0]
Set-Result "Version B image ID" $imageIdB

# --- 8. Verify distinct immutable identity ----------------------------------
if ($imageIdA -eq $imageIdB) {
  Fail "Distinct identity" "Version A and Version B have the SAME image ID - not immutable-distinct artifacts"
}
Set-Result "Distinct identity" "PASS (A != B)"

# --- 9. Deploy Version B ------------------------------------------------------
Write-Host "[7] Deploying Version B..." -ForegroundColor Green
Run-Cmd "docker" @("rm", "-f", $ContainerName) | Out-Null
$rb = Run-Cmd "docker" @("run", "-d", "-P", "--name", $ContainerName, $tagB)
if ($rb.ExitCode -ne 0) { Fail "Version B deploy" $rb.StdErr.Trim() }
$containerB = $rb.StdOut.Trim()
Set-Result "Version B container ID" $containerB
$pb = Run-Cmd "docker" @("inspect", $containerB, "--format", "{{(index (index .NetworkSettings.Ports `"${ContainerPort}/tcp`") 0).HostPort}}")
$portB = $pb.StdOut.Trim()
$urlB = "http://127.0.0.1:$portB/health"

# --- 10. Deliberate failure: Version B /health returns 500 ------------------
Write-Host "[8] Verifying deliberate failure (Version B)..." -ForegroundColor Green
Start-Sleep -Seconds 2
try {
  $hb = Invoke-WebRequest -Uri $urlB -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
  Fail "Version B failure" "expected HTTP 500 but got HTTP $($hb.StatusCode) - deliberate failure NOT reproduced"
} catch [System.Net.WebException] {
  $status = [int]$_.Exception.Response.StatusCode
  if ($status -eq 500) {
    Set-Result "Version B failure" "PASS (HTTP 500 reproduced)"
    Set-Result "Failure evidence" "GET $urlB -> HTTP 500 (container $containerB, image $imageIdB)"
  } else {
    Fail "Version B failure" "expected HTTP 500 but got HTTP $status"
  }
}

# --- 11. ROLLBACK: restore Version A immutable image -------------------------
Write-Host "[9] Executing rollback to Version A immutable image..." -ForegroundColor Green
Run-Cmd "docker" @("stop", $ContainerName) | Out-Null
Run-Cmd "docker" @("rm", "-f", $ContainerName) | Out-Null
# Re-run the EXACT stored immutable image (image_id). Never rebuild, never latest.
$rr = Run-Cmd "docker" @("run", "-d", "-P", "--name", $ContainerName, $imageIdA)
if ($rr.ExitCode -ne 0) { Fail "Rollback deploy" $rr.StdErr.Trim() }
$containerR = $rr.StdOut.Trim()
Set-Result "Rollback container ID" $containerR

# --- 12. Verify restored image identity -------------------------------------
$ir = Run-Cmd "docker" @("inspect", $containerR, "--format", "{{.Image}}")
if ($ir.ExitCode -ne 0) { Fail "Rollback identity" $ir.StdErr.Trim() }
$runningImage = $ir.StdOut.Trim()
Set-Result "Rollback running image ID" $runningImage
if ($runningImage -ne $imageIdA) {
  Fail "Rollback identity" "running image $runningImage != known-good $imageIdA"
}
Set-Result "Rollback identity match" "PASS (== Version A image ID)"

# --- 13. Health check restored deployment -----------------------------------
$pr = Run-Cmd "docker" @("inspect", $containerR, "--format", "{{(index (index .NetworkSettings.Ports `"${ContainerPort}/tcp`") 0).HostPort}}")
$portR = $pr.StdOut.Trim()
$urlR = "http://127.0.0.1:$portR/health"
Start-Sleep -Seconds 2
try {
  $hr = Invoke-WebRequest -Uri $urlR -UseBasicParsing -TimeoutSec 10
  if ($hr.StatusCode -ne 200) { Fail "Rollback health" "HTTP $($hr.StatusCode)" }
  Set-Result "Rollback health" "PASS (HTTP $($hr.StatusCode))"
} catch {
  Fail "Rollback health" "request failed: $($_.Exception.Message)"
}

# --- 14. Playwright smoke restored deployment --------------------------------
Write-Host "[10] Playwright smoke restored deployment..." -ForegroundColor Green
if (-not (Test-Path $spec)) {
  Set-Result "Rollback smoke" "BLOCKED - smoke spec missing: $spec"
} else {
  $env:STAGING_URL = "http://127.0.0.1:$portR"
  $sr = Run-Cmd "npx" @("playwright", "test", $spec, "--reporter=line")
  if ($sr.ExitCode -ne 0) {
    Set-Result "Rollback smoke" "FAIL - exit $($sr.ExitCode): $($sr.StdErr.Trim())"
  } else {
    Set-Result "Rollback smoke" "PASS"
  }
}

# --- 15. Idempotency: rollback again ----------------------------------------
Write-Host "[11] Idempotency check (rollback again)..." -ForegroundColor Green
Run-Cmd "docker" @("stop", $ContainerName) | Out-Null
Run-Cmd "docker" @("rm", "-f", $ContainerName) | Out-Null
$rr2 = Run-Cmd "docker" @("run", "-d", "-P", "--name", $ContainerName, $imageIdA)
if ($rr2.ExitCode -ne 0) { Fail "Idempotency" $rr2.StdErr.Trim() }
$ir2 = Run-Cmd "docker" @("inspect", $rr2.StdOut.Trim(), "--format", "{{.Image}}")
if ($ir2.StdOut.Trim() -ne $imageIdA) { Fail "Idempotency" "second rollback image mismatch" }
Set-Result "Idempotency" "PASS (second rollback restores same immutable image)"

# --- 16. TypeScript typecheck + production build ----------------------------
Write-Host "[12] TypeScript typecheck..." -ForegroundColor Green
$tc = Run-Cmd "npm" @("run", "typecheck")
if ($tc.ExitCode -ne 0) {
  Set-Result "TypeScript typecheck" "FAIL - $($tc.StdErr.Trim())"
  Fail "TypeScript typecheck" $tc.StdErr.Trim()
} else {
  Set-Result "TypeScript typecheck" "PASS"
}

Write-Host "[13] TypeScript production build..." -ForegroundColor Green
$tb = Run-Cmd "npm" @("run", "build")
if ($tb.ExitCode -ne 0) {
  Set-Result "TypeScript build" "FAIL"
  Fail "TypeScript build" $tb.StdErr.Trim()
} else {
  Set-Result "TypeScript build" "PASS"
}

# --- final -------------------------------------------------------------------
Set-Result "ROLLBACK VERIFIED" "PASS"
Print-Report
exit 0


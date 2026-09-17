[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PatchFile,
    [string]$RepoRoot = (Get-Location).Path
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

git -C $RepoRoot apply --check $PatchFile
if ($LASTEXITCODE -ne 0) { throw "Patch does not apply cleanly: $PatchFile" }
git -C $RepoRoot apply $PatchFile
Write-Host "Applied $PatchFile"

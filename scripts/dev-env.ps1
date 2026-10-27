# scripts/dev-env.ps1 ? dot-source: `. .\scripts\dev-env.ps1`
if (Test-Path "$PSScriptRoot\..\.env") {
  Get-Content "$PSScriptRoot\..\.env" | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      Set-Item "Env:\$($matches[1])" ($matches[2].Trim().Trim('"').Trim("'"))
    }
  }
}
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$u = if ($env:DATABASE_URL) { [uri]$env:DATABASE_URL } else { $null }
$mode = $env:NEXUS_PERSISTENCE_MODE
if ($u) {
  Write-Host "dev env: $($u.Scheme)://$($u.UserInfo -split ':')[0]:***@$($u.Host):$($u.Port)$($u.AbsolutePath)  mode=$mode  (utf-8)"
} else {
  Write-Host "dev env: DATABASE_URL unset  mode=$mode  (utf-8)"
}

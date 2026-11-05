# One-time setup (Windows): afterwards a plain `ssh {{USER}}@{{HOST}}` works on this machine.
$d = "$HOME\.ssh"; New-Item -ItemType Directory -Force $d | Out-Null
Invoke-WebRequest https://{{HOST}}/p.ps1 -UseBasicParsing -OutFile "$d\sx-proxy.ps1"
$have = (Test-Path "$d\config") -and (Select-String -Path "$d\config" -Pattern '^Host {{HOST}}$' -Quiet)
if (-not $have) {
  Add-Content "$d\config" ("`nHost {{HOST}}`n  User {{USER}}`n  ProxyCommand powershell -NoProfile -ExecutionPolicy Bypass -File `"$d\sx-proxy.ps1`"`n  ConnectTimeout 15`n  ServerAliveInterval 30`n")
}
"Done. Now run: ssh {{USER}}@{{HOST}}"

# Real end-to-end SSH to {{USER}}@{{HOST}} from Windows PowerShell 5.1+ / PowerShell 7. Needs only the built-in OpenSSH client (ssh.exe).
#   irm {{HOST}}/w | iex
# Writes two temp files (host key + proxy helper) and deletes them on exit. Expected host key fingerprint: {{FINGERPRINT}}
$ErrorActionPreference = 'Stop'
$H = '{{HOST}}'
$U = if ($env:SX_USER) { $env:SX_USER } else { '{{USER}}' }
$ssh = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
if (-not $ssh) { throw 'ssh.exe not found. Install it: Settings > Apps > Optional features > OpenSSH Client.' }
$dir = Join-Path ([IO.Path]::GetTempPath()) ('sow' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir | Out-Null
try {
  $kh = Join-Path $dir 'known_hosts'; $px = Join-Path $dir 'proxy.ps1'
  $cfg = Join-Path $dir 'config'
  [IO.File]::WriteAllText($cfg, '')
  [IO.File]::WriteAllText($kh, "$H {{HOSTKEY}}`n")
  $proxy = @'
{{PROXY_PS1}}
'@
  [IO.File]::WriteAllText($px, $proxy)
  $px = $px.Replace('\', '/')   # Windows PowerShell 5.1 drops backslashes when it passes quoted arguments to ssh.exe
  & $ssh -F $cfg -o "UserKnownHostsFile=$kh" -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 `
    -o PreferredAuthentications=password -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=2 `
    -o ConnectTimeout=20 -o ServerAliveInterval=30 `
    -o "ProxyCommand=powershell -NoProfile -ExecutionPolicy Bypass -File `"$px`"" "$U@$H" @(if ($env:SX_CMD) { $env:SX_CMD })
} finally {
  [IO.Directory]::Delete($dir, $true)
}

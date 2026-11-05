# ssh-over-websocket

**SSH into a machine that has no public IP, through a Cloudflare Tunnel, from a browser, `curl`, or a stock `ssh` client.**

```bash
curl -s ssh.example.com/c | sh      # real ssh, host key pinned, nothing installed
curl -s ssh.example.com | bash     # fast terminal, curl + openssl only
# or open https://ssh.example.com in a browser
```

All three ask for one thing: the account password. No login page, no one-time codes, no client software to install.

## The problem

You want `ssh you@home.example.com` to work from anywhere. Your machine sits behind NAT (campus Wi-Fi, a carrier-grade NAT, a hotel) so nothing on the internet can connect to it. A Cloudflare Tunnel fixes the "nothing can connect in" half: the machine dials out to Cloudflare, and Cloudflare sends requests down that connection. Then you hit the next wall:

| Obstacle | Why |
|---|---|
| Cloudflare does not listen on port 22 | Its shared IPs only accept HTTP(S). |
| Cloudflare routes by hostname | HTTP carries a `Host` header and TLS carries SNI. SSH carries neither, so the edge cannot tell whose server a raw SSH connection is for. |
| Sending SSH to port 443 fails | The edge parses the first bytes (`SSH-2.0-OpenSSH_...`) as HTTP and answers `400 Bad Request`. |
| Cloudflare's own fix needs software on the client | `cloudflared access ssh` or WARP must be installed on every device you connect from, and Access adds a login step. |
| Cloudflare Spectrum forwards raw TCP | It is a paid product. |

So a bare `ssh you@home.example.com` on a device with no setup cannot work without a host that has a public IP. This project removes the setup, not the physics: every route below needs at most one pasted line and installs nothing.

## How it works

```
your device ──HTTPS──> Cloudflare ──tunnel──> ssh-over-websocket ──> sshd (127.0.0.1:22)
```

The trick for real SSH: the client opens a TLS connection and sends a normal WebSocket upgrade request. The server replies `101 Switching Protocols`, then copies raw bytes between that connection and sshd. Cloudflare sees a WebSocket. OpenSSH skips any non-`SSH-` lines before the server banner (RFC 4253 §4.2), so the HTTP response headers do not break the handshake. After that it is an ordinary, end-to-end encrypted SSH session.

## Features

| Feature | What it does |
|---|---|
| `/c` real ssh | Runs your local `ssh` through a `ProxyCommand` generated on the fly, with the server's host key pinned. Writes one temp file and deletes it on exit. |
| `/` browser terminal | xterm.js page; the password goes to the server over HTTPS, which logs into sshd with it. |
| `curl \| bash` terminal | One persistent stream via `openssl s_client`; falls back to plain `curl` if `openssl` is missing. |
| Raw SSH bridge | Any non-`/term`, non-`/raw` WebSocket upgrade is piped straight to sshd, so a configured `ssh` client works unmodified. |
| One-time setup scripts | `/s` (sh) and `/s.ps1` (PowerShell) write a `~/.ssh/config` entry so `ssh user@host` works afterwards. |
| Host key auto-detection | The server reads sshd's ed25519 host key on startup and fills it into `/c`. |
| Abuse limits | 5 failed logins block an IP for 15 minutes; 12 new connections per minute per IP. |

## Installation

Requirements on the machine you want to reach: Node.js 18+, a running `sshd` with password login enabled, and `cloudflared` with a tunnel.

```bash
git clone https://github.com/Sadashii/ssh-over-websocket
cd ssh-over-websocket
npm install
DEFAULT_USER=youruser npm start
```

Add the server to your tunnel's ingress (see [`examples/cloudflared-config.yml`](examples/cloudflared-config.yml)), then create the DNS record and restart the tunnel:

```bash
cloudflared tunnel route dns <tunnel-name> ssh.example.com
```

```yaml
ingress:
  - hostname: ssh.example.com
    service: http://127.0.0.1:7722
  - service: http_status:404
```

Make it start at boot:

| OS | Command |
|---|---|
| Windows (admin shell) | `Register-ScheduledTask -TaskName ssh-over-websocket -User SYSTEM -RunLevel Highest -Trigger (New-ScheduledTaskTrigger -AtStartup) -Action (New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument '"C:\path\to\server.js"' -WorkingDirectory 'C:\path\to')` |
| Linux | Create a systemd service that runs `node server.js` with `Environment=DEFAULT_USER=youruser` (not tested here). |

## Usage

Run from any device. Replace `ssh.example.com` with your hostname.

| Goal | Command | Needs on the client |
|---|---|---|
| Real ssh, nothing installed | `curl -s ssh.example.com/c \| sh` | `sh`, `ssh`, `openssl` |
| Fast terminal | `curl -s ssh.example.com \| bash` | `bash`, `curl`, `openssl` (optional) |
| Browser | open `https://ssh.example.com` | a browser |
| Permanent `ssh user@host` | `curl -fsSL ssh.example.com/s \| sh` once, then `ssh user@ssh.example.com` | `sh`, `ssh`, `openssl` |
| Same, on Windows | `irm ssh.example.com/s.ps1 \| iex` once, then `ssh user@ssh.example.com` | Windows PowerShell 5.1+, OpenSSH client |

Pass a command to `/c` the way you would to `ssh`: `curl -s ssh.example.com/c | sh -s -- uptime`.

Advanced: connect without any script by putting the proxy on the command line.

```bash
ssh -o ProxyCommand="sh -c \"{ printf 'GET / HTTP/1.1\r\nHost: ssh.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'; cat; } | openssl s_client -quiet -connect ssh.example.com:443 -servername ssh.example.com 2>/dev/null\"" user@ssh.example.com
```

## Configuration

Set these as environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7722` | Port the server listens on. |
| `BIND` | `127.0.0.1` | Listen address. Keep it on loopback behind a tunnel. |
| `SSH_HOST` | `127.0.0.1` | Host of the sshd to log into. |
| `SSH_PORT` | `22` | Port of that sshd. |
| `PUBLIC_HOST` | request `Host` header | Hostname written into the client scripts. |
| `DEFAULT_USER` | current OS user | Login name suggested by the scripts and the web page. |
| `SSH_HOSTKEY` | detected from sshd | `ssh-ed25519 AAAA...` line to pin in `/c`. Set it if auto-detection fails. |
| `TRUST_PROXY_IP` | `1` when `BIND` is loopback | Read the client IP from `cf-connecting-ip` / `x-forwarded-for`. |

## Security

| Topic | Detail |
|---|---|
| What protects the account | The account password. Use a long random passphrase (8 diceware words is about 103 bits). |
| Who sees the password | `/c` and the configured `ssh` route are end-to-end encrypted to sshd. The browser terminal and `curl \| bash` send the password to this server (and through Cloudflare), which then logs in. Use `/c` if Cloudflare must not see it. |
| Host key pinning | `/c` rejects any server whose ed25519 key differs from the one sshd presented to this server. You still trust the page that delivered the script. |
| Limits | 5 failed logins block an IP for 15 minutes; 12 new connections per minute per IP. The OS can add its own lockout (Windows: `net accounts /lockoutthreshold:10`). |
| Exposure | The password prompt is reachable by anyone who knows the hostname. Use a dedicated low-privilege account, `AllowUsers`, and `MaxAuthTries 3`. |
| Account power | Whatever the account can do, a stolen password can do. Do not use an administrator account unless you accept that. |

## Limits

| Limit | Detail |
|---|---|
| No bare `ssh user@host` on a fresh device | The client needs a `ProxyCommand`. `/c` supplies one for a single run; `/s` stores one. |
| Latency | Expect about 0.3 s per keystroke round trip through Cloudflare. About 1 in 10 connections stalls ~20 s at the edge; retry. |
| The machine must be online | The tunnel and this server must be running. |
| Resize | The `curl \| bash` terminal sends the window size once, at login. |
| Windows client | Plain Windows needs the PowerShell helper (`/s.ps1`); `/c` needs `sh` (Git Bash or WSL work). |
| Tested with | Windows 11 server (OpenSSH for Windows 9.x, PowerShell 7) behind a Cloudflare Tunnel; clients on Ubuntu (WSL), Git Bash, and Windows PowerShell. |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `503 could not read the local sshd host key` on `/c` | Set `SSH_HOSTKEY`, or check that sshd allows `ssh-ed25519` host keys. |
| `Host key verification failed` | The server's host key changed. Restart this server so it re-reads the key. |
| `HTTP 400` or a hang right after connecting | The request did not reach this server. Check the tunnel ingress and the DNS record. |
| `Login failed` with the right password | Check `AllowUsers`, the account's lockout state, and that `PasswordAuthentication yes` is set. |

## License

MIT

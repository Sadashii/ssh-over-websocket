<div align="center">

# 🔑 ssh-over-websocket

### SSH into a machine behind NAT, through a Cloudflare Tunnel. From a browser, `curl`, or a stock `ssh` client.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](package.json)
[![Stars](https://img.shields.io/github/stars/Sadashii/ssh-over-websocket?style=flat&logo=github)](https://github.com/Sadashii/ssh-over-websocket/stargazers)
[![Issues](https://img.shields.io/github/issues/Sadashii/ssh-over-websocket)](https://github.com/Sadashii/ssh-over-websocket/issues)

<img src="docs/demo.gif" alt="ssh-over-websocket demo" width="720">

```bash
curl -s ssh.example.com/c | sh
```

**One pasted line. One password. A real SSH session to a laptop with no public IP.**

</div>

---

## 😤 The pain

You want `ssh you@home.example.com` to work from anywhere. Your machine sits on campus Wi-Fi, a carrier-grade NAT, or a hotel network, so nothing on the internet can reach it. A Cloudflare Tunnel solves half of that: your machine dials out, and Cloudflare sends requests back down the connection.

Then you hit the wall:

| 🧱 Obstacle | Why it blocks you |
|---|---|
| Cloudflare does not listen on port 22 | Its shared IPs accept HTTP(S) only. |
| Cloudflare routes by hostname | HTTP has a `Host` header and TLS has SNI. SSH has neither, so the edge cannot tell whose server a raw SSH connection is for. |
| SSH to port 443 gets `400 Bad Request` | The edge parses `SSH-2.0-OpenSSH_...` as an HTTP request line and rejects it. |
| The official fix needs client software | `cloudflared access ssh` or WARP must be installed on every device, and Access adds a login step. |
| Spectrum forwards raw TCP | It is a paid product. |

A bare `ssh you@host` on a device with no setup cannot work without a public-IP host. This project removes the setup instead: **every route below needs one pasted line at most and installs nothing.**

## 🆚 How it compares

Pick the tool that fits. Details below are as of writing; check each project for current terms.

| Option | Client needs | Extra host | Cost | Trade-off |
|---|---|---|---|---|
| **ssh-over-websocket** | `curl`/`ssh`/`openssl`, a browser, or PowerShell + `ssh.exe` | None | Free | Latency from the Cloudflare hop; password-based by design; you run one small Node server |
| `cloudflared access ssh` | `cloudflared` installed | None | Free tier | Software on every client; Access login if you use browser-rendered SSH |
| Tailscale | Tailscale app and account | None | Free for personal use | Every device joins your tailnet; the best fit when you control every client |
| wstunnel | A `wstunnel` binary on the client | None | Free | General-purpose and fast; needs its binary on every client |
| VPS + reverse SSH tunnel (autossh) | Plain `ssh -p` | A public-IP server | Server cost | Cleanest result; you rent and secure a machine |
| Cloudflare Spectrum | Plain `ssh` | None | Paid plan | The only way to get a truly bare `ssh user@host`; check current plan and pricing |
| Hosted TCP tunnels (ngrok, bore, ...) | Plain `ssh -p <port>` | Third-party relay | Varies | Your SSH port is exposed on someone else's host |

**Use this project when** you cannot install anything on the client, have no public-IP machine, and already use (or can use) a Cloudflare Tunnel. **Use Tailscale when** you control every device you connect from.

## ✨ Why you will like it

| | Benefit |
|---|---|
| 🔐 | **Password only.** No Google login, no email code, no Cloudflare Access page. Type the password from memory. |
| 🧰 | **Nothing to install on the client.** `curl`, a browser, or the `ssh` you already have. |
| 🔒 | **Real SSH, end to end.** The `/c` route pins the host key and keeps the session encrypted between your client and sshd. |
| 🌐 | **Works behind NAT.** The machine only makes outbound connections. |
| ⚡ | **Fast enough to live in.** About 0.3 s per keystroke round trip through Cloudflare. |
| 🛡️ | **Abuse limits built in.** Failed-login blocking and per-IP connection limits. |
| 🔁 | **One server, four doors.** Browser, `curl \| bash`, `/c`, and a permanent `ssh user@host` setup. |

## 🚀 Quick start (under 30 seconds)

On the machine you want to reach:

```bash
git clone https://github.com/Sadashii/ssh-over-websocket && cd ssh-over-websocket
npm install
DEFAULT_USER=youruser npm start
```

Route your tunnel to it (`examples/cloudflared-config.yml`), then connect from anywhere:

```bash
curl -s ssh.example.com/c | sh      # real ssh, host key pinned
curl -s ssh.example.com | bash      # fast terminal
# or open https://ssh.example.com in a browser
```

> **Prerequisites:** Node.js 18+, a running `sshd` with password login, and a `cloudflared` tunnel with a DNS record for your hostname (`cloudflared tunnel route dns <tunnel> ssh.example.com`).

Run it at boot:

| OS | Command |
|---|---|
| Windows (admin shell) | `Register-ScheduledTask -TaskName ssh-over-websocket -User SYSTEM -RunLevel Highest -Trigger (New-ScheduledTaskTrigger -AtStartup) -Action (New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument '"C:\path\to\server.js"' -WorkingDirectory 'C:\path\to')` |
| Linux | A systemd service that runs `node server.js` with `Environment=DEFAULT_USER=youruser` (not tested here). |

## 🧠 How it works

```
your device ──HTTPS──▶ Cloudflare ──tunnel──▶ ssh-over-websocket ──▶ sshd (127.0.0.1:22)
```

The client opens a TLS connection and sends a normal WebSocket upgrade request. The server answers `101 Switching Protocols`, then copies raw bytes between that connection and sshd. Cloudflare sees a WebSocket. OpenSSH skips any non-`SSH-` lines before the server banner (RFC 4253 §4.2), so the HTTP response headers do not break the handshake. After that it is an ordinary SSH session.

### The four doors

| Route | Command | Client needs |
|---|---|---|
| Real ssh, nothing installed | `curl -s ssh.example.com/c \| sh` | `sh`, `ssh`, `openssl` |
| Fast terminal | `curl -s ssh.example.com \| bash` | `bash`, `curl`, `openssl` (optional) |
| Browser | open `https://ssh.example.com` | a browser |
| Permanent `ssh user@host` | `curl -fsSL ssh.example.com/s \| sh` once | `sh`, `ssh`, `openssl` |
| Real ssh on Windows, nothing installed | `irm ssh.example.com/w \| iex` | PowerShell 5.1+ or 7, built-in `ssh.exe` |
| Permanent `ssh user@host` on Windows | `irm ssh.example.com/s.ps1 \| iex` once | PowerShell 5.1+, OpenSSH client |

Pass a command to `/c` like you would to `ssh`: `curl -s ssh.example.com/c | sh -s -- uptime`.

<details>
<summary><b>No script at all: one ssh command</b></summary>

```bash
ssh -o ProxyCommand="sh -c \"{ printf 'GET / HTTP/1.1\r\nHost: ssh.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'; cat; } | openssl s_client -quiet -connect ssh.example.com:443 -servername ssh.example.com 2>/dev/null\"" user@ssh.example.com
```

</details>

### Configuration

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
| `ALLOWED_USERS` | any | Comma-separated logins this server will attempt on the browser, `curl` and `/raw` routes. Keep `AllowUsers` in sshd too: the raw SSH bridge never reads the username. |
| `WEB_LOGIN` | `1` | Set `0` to disable every route where this server handles the password (`/term`, `/raw`, `/t/*`). Only the end-to-end routes (`/c`, `/w`, `/s`) remain, and Cloudflare never sees the password. |

### Security model

| Topic | Detail |
|---|---|
| What protects the account | The account password. Use a long random passphrase; 8 diceware words is about 103 bits. |
| Who sees the password | `/c` and the configured `ssh` route are end-to-end encrypted to sshd. The browser terminal and `curl \| bash` send the password to this server, through Cloudflare, which then logs in. Use `/c` if Cloudflare must not see it. |
| Host key pinning | `/c` rejects any server whose ed25519 key differs from the one sshd presented to this server. You still trust the page that delivered the script. |
| Limits | 5 failed logins block an IP for 15 minutes; 12 new connections per minute per IP. Add an OS lockout too (Windows: `net accounts /lockoutthreshold:10`). |
| Exposure | Anyone who knows the hostname can reach the password prompt. Use a dedicated low-privilege account, `AllowUsers`, and `MaxAuthTries 3`. |
| Account power | A stolen password can do whatever the account can do. Avoid administrator accounts unless you accept that. |

### Threat model

| Question | Answer |
|---|---|
| Who can attempt a login? | Anyone who knows the hostname. The prompt is public. |
| What stops guessing? | A strong passphrase, sshd `MaxAuthTries`, the OS account lockout, and this server's per-IP block (5 failures, 15 minutes) and rate limit (12 connections per minute). Behind a shared NAT or proxy, one address can lock out everyone behind it. |
| What does a stolen password give? | Everything that account can do. Use a dedicated low-privilege account, not an administrator. |
| What if the proxy is hostile? | `/c` and `/w` pin the host key, so a proxy cannot impersonate your sshd. It can still see metadata and block traffic. On the browser and `curl \| bash` routes it sees the password. |
| What if the script host is hostile? | You pipe a script from that host into `sh`. Whoever controls the server or the hostname controls what runs on your client. Read the script first: `curl -s ssh.example.com/c`. |
| Hardest setting | `WEB_LOGIN=0` plus `ALLOWED_USERS` plus key-only sshd for everything except the account you use. |

### Honest limits

| Limit | Detail |
|---|---|
| No bare `ssh user@host` on a fresh device | The client needs a `ProxyCommand`. `/c` supplies one for a single run; `/s` stores one. |
| Latency | About 0.3 s per keystroke round trip. Roughly 1 in 10 connections stalls ~20 s at the Cloudflare edge; retry. |
| The machine must be online | The tunnel and this server must be running. |
| Resize | The `curl \| bash` terminal sends the window size once, at login. |
| Windows client | Use `irm .../w \| iex`. `/c` needs `sh` (Git Bash or WSL work). |
| Not tested | macOS clients and servers; Linux servers behind a real Cloudflare Tunnel (tested locally only). Reports welcome. |
| Tested with | Windows 11 server (OpenSSH for Windows 9.x, PowerShell 7) behind a Cloudflare Tunnel; Ubuntu 26.04 server (OpenSSH 10.2) from a fresh clone, locally; clients on Ubuntu (WSL), Git Bash, PowerShell 7, and Windows PowerShell 5.1. |

### Troubleshooting

| Symptom | Fix |
|---|---|
| `503 could not read the local sshd host key` on `/c` | Set `SSH_HOSTKEY`, or check that sshd offers `ssh-ed25519` host keys. |
| `Host key verification failed` | The server's host key changed. Restart this server so it re-reads the key. |
| `HTTP 400` or a hang right after connecting | The request did not reach this server. Check the tunnel ingress and the DNS record. |
| `Login failed` with the right password | Check `AllowUsers`, the account's lockout state, and `PasswordAuthentication yes`. |

## 🧪 Development

```bash
npm install
npm test        # unit and route tests, no network or sshd needed
```

## 🗺️ Roadmap

Ideas, not promises. Star the repo to follow along.

- [x] Browser terminal with password login
- [x] Real SSH over a fake WebSocket upgrade (`ProxyCommand`)
- [x] One-line `curl | sh` with host key pinning
- [x] Host key auto-detection
- [x] Failed-login blocking and connection-rate limits
- [x] Windows one-liner that needs no `sh` or `openssl`
- [x] `ALLOWED_USERS` and `WEB_LOGIN=0` hardening switches
- [x] Automated tests (`npm test`)
- [ ] Terminal resize for the `curl | bash` route
- [ ] systemd unit and Windows service installer
- [ ] Optional TOTP second factor on the web routes
- [ ] File transfer (`scp`/`sftp`) one-liners
- [ ] Docker image
- [ ] Demo GIF and a hosted walkthrough

## ⭐ Help it grow

If this saved you from buying a VPS, **give it a star**. It takes one click and helps other people stuck behind NAT find it.

- ⭐ **[Star the repo](https://github.com/Sadashii/ssh-over-websocket)** to follow the roadmap
- 🐛 **[Open an issue](https://github.com/Sadashii/ssh-over-websocket/issues)** when something breaks on your setup
- 🔧 **Send a pull request** for anything on the roadmap
- 📣 **Share it** with the friend who keeps asking how you reach your home server

## 📄 License

[MIT](LICENSE)

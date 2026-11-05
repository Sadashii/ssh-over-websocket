#!/usr/bin/env bash
# Interactive shell over HTTPS:  curl -s {{HOST}} | bash
# Fast path (needs openssl): one persistent stream via a fake WebSocket upgrade.
# Fallback (curl only): output streams down one GET, keystrokes go up as short POSTs.
# The password is checked by the server's sshd, but it passes through the server (and any proxy in front of it).
HOST="${SX_HOST:-{{HOST}}}"
U="${SX_USER:-{{USER}}}"
if [ -n "$SX_PASS" ]; then P="$SX_PASS"; else read -rsp "password for $U: " P </dev/tty; echo >&2; fi
SZ=$(stty size </dev/tty 2>/dev/null); C=${SZ#* }; R=${SZ% *}; C=${C:-80}; R=${R:-24}
SAVED=$(stty -g </dev/tty)

if command -v openssl >/dev/null 2>&1; then
  CRED=$(printf '%s:%s' "$U" "$P" | base64 | tr -d '\n'); unset P
  trap 'stty "$SAVED" </dev/tty 2>/dev/null; echo' EXIT
  stty raw -echo min 0 time 1 </dev/tty
  # feeder: handshake + login line, then keystrokes (dd returns as soon as a key arrives; we kill the loop at the end
  # so no keystroke is left stolen after the session closes)
  exec 3< <( printf 'GET /raw HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n%s %s %s\n' "$HOST" "$C" "$R" "$CRED"
             while :; do dd bs=1024 count=1 2>/dev/null </dev/tty; done )
  FEED=$!
  # skip the HTTP 101 response headers (up to the blank line), then pass bytes straight to the terminal
  openssl s_client -quiet -connect "$HOST:443" -servername "$HOST" <&3 2>/dev/null |
    { while IFS= read -r l; do [ "$l" = $'\r' ] && break; done; cat; }
  kill "$FEED" 2>/dev/null
  exit 0
fi

H="https://$HOST"
ID=$(curl -fsS -X POST -u "$U:$P" "$H/t/new?cols=$C&rows=$R") || { echo "login failed" >&2; exit 1; }
unset P
T=$(mktemp)
cleanup() { stty "$SAVED" </dev/tty 2>/dev/null; kill "$OUT" 2>/dev/null; rm -f "$T"; echo; }
trap cleanup EXIT
curl -sN "$H/t/out/$ID" &
OUT=$!
stty raw -echo min 0 time 3 </dev/tty
while kill -0 "$OUT" 2>/dev/null; do
  dd bs=4096 count=1 of="$T" 2>/dev/null </dev/tty
  [ -s "$T" ] && curl -sS --data-binary @"$T" -H 'Content-Type: application/octet-stream' "$H/t/in/$ID" >/dev/null 2>&1
done

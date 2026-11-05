#!/bin/sh
# Real end-to-end SSH to {{USER}}@{{HOST}}. Installs nothing (one temp file, deleted on exit); the server's host key is pinned.
#   curl -s {{HOST}}/c | sh
# Needs: sh, ssh, openssl.  Expected host key fingerprint: {{FINGERPRINT}}
H={{HOST}}
KH=$(mktemp) || exit 1
trap 'rm -f "$KH"' EXIT INT TERM
echo "$H {{HOSTKEY}}" > "$KH"
PC="sh -c \"{ printf 'GET / HTTP/1.1\\r\\nHost: $H\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n'; cat; } | openssl s_client -quiet -connect $H:443 -servername $H 2>/dev/null\""
ssh -F /dev/null -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 \
    -o PreferredAuthentications=password -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=2 \
    -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ProxyCommand="$PC" "${SX_USER:-{{USER}}}@$H" "$@" </dev/tty

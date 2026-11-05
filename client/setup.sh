#!/bin/sh
# One-time setup: afterwards a plain `ssh {{USER}}@{{HOST}}` works on this machine.
set -e
D="$HOME/.ssh"; mkdir -p "$D"; chmod 700 "$D"
curl -fsSL https://{{HOST}}/p.sh -o "$D/sx-proxy.sh"
chmod 700 "$D/sx-proxy.sh"
if ! grep -q '^Host {{HOST}}$' "$D/config" 2>/dev/null; then
  cat >> "$D/config" <<EOC

Host {{HOST}}
  User {{USER}}
  ProxyCommand sh $D/sx-proxy.sh
  ConnectTimeout 15
  ServerAliveInterval 30
EOC
  chmod 600 "$D/config"
fi
echo "Done. Now run: ssh {{USER}}@{{HOST}}"

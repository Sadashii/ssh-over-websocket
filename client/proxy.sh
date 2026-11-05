#!/bin/sh
# ProxyCommand helper: raw SSH over a fake WebSocket upgrade via {{HOST}} (stock sh + openssl only).
{ printf 'GET / HTTP/1.1\r\nHost: {{HOST}}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'; cat; } | openssl s_client -quiet -connect {{HOST}}:443 -servername {{HOST}} 2>/dev/null

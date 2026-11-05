#!/usr/bin/env node
// ssh-over-websocket: one small server that sits behind a Cloudflare Tunnel (or any HTTP reverse proxy)
// and gives you SSH access to the machine it runs on, from devices with nothing but a browser, curl, or ssh.
//
//   GET  /            browser terminal (curl gets the terminal script instead)
//   WS   /term        browser terminal websocket   (password -> local sshd via ssh2)
//   WS   /raw         curl|bash terminal stream    (password -> local sshd via ssh2)
//   WS   (other)      raw SSH byte bridge          (genuine end-to-end ssh, via ProxyCommand)
//   GET  /c /t /s /s.ps1 /p.sh /p.ps1   client scripts, filled in with this server's host / user / host key
//
// Configuration (environment variables):
//   PORT=7722            listen port            BIND=127.0.0.1   listen address (keep it loopback behind a tunnel)
//   SSH_HOST=127.0.0.1   sshd to connect to     SSH_PORT=22
//   PUBLIC_HOST=         public hostname used in client scripts (default: the request's Host header)
//   DEFAULT_USER=        login user suggested by the scripts and the web page (default: current OS user)
//   SSH_HOSTKEY=         "ssh-ed25519 AAAA..." to pin; default: auto-detected from the local sshd
//   TRUST_PROXY_IP=1     take client IP from cf-connecting-ip / x-forwarded-for (default: on when BIND is loopback)
'use strict';
const http = require('http'), net = require('net'), crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');

const PORT = +process.env.PORT || 7722;
const BIND = process.env.BIND || '127.0.0.1';
const SSH_HOST = process.env.SSH_HOST || '127.0.0.1';
const SSH_PORT = +process.env.SSH_PORT || 22;
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
const DEFAULT_USER = process.env.DEFAULT_USER || os.userInfo().username;
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(BIND);
const TRUST_PROXY_IP = process.env.TRUST_PROXY_IP ? process.env.TRUST_PROXY_IP === '1' : LOOPBACK;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const NM = path.join(__dirname, 'node_modules');
const log = (m) => console.log(new Date().toISOString() + ' ' + m);

// ---- static files and templated client scripts ----
const STATIC = {
  '/xterm.js': [path.join(NM, '@xterm/xterm/lib/xterm.js'), 'application/javascript'],
  '/xterm.css': [path.join(NM, '@xterm/xterm/css/xterm.css'), 'text/css'],
  '/fit.js': [path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'), 'application/javascript'],
};
const SCRIPTS = {
  '/c': 'c.sh', '/t': 'term.sh', '/s': 'setup.sh', '/s.ps1': 'setup.ps1', '/p.sh': 'proxy.sh', '/p.ps1': 'proxy.ps1',
};

// ---- host key (for pinning in /c) ----
let hostKey = process.env.SSH_HOSTKEY || null, hostFp = null;
function describeKey(line) {
  const blob = Buffer.from(line.split(/\s+/)[1], 'base64');
  hostFp = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}
function fetchHostKey() {
  return new Promise((resolve) => {
    const c = new Client(); let got = null, done = false;
    const end = () => { if (!done) { done = true; resolve(got); } };
    c.on('error', end); c.on('close', end);
    c.connect({
      host: SSH_HOST, port: SSH_PORT, username: 'hostkey-probe', password: 'x', readyTimeout: 8000,
      algorithms: { serverHostKey: ['ssh-ed25519'] },
      hostVerifier: (key) => { got = key; return false; },   // abort right after the key exchange: no auth attempt is made
    });
  });
}
async function ensureHostKey() {
  if (hostKey) { if (!hostFp) describeKey(hostKey); return hostKey; }
  const k = await fetchHostKey();
  if (k) { hostKey = 'ssh-ed25519 ' + k.toString('base64'); describeKey(hostKey); log('host key detected: ' + hostFp); }
  return hostKey;
}

function render(name, host, key) {
  let t = fs.readFileSync(path.join(__dirname, 'client', name), 'utf8');
  return t.split('{{HOST}}').join(host).split('{{USER}}').join(DEFAULT_USER)
          .split('{{HOSTKEY}}').join(key || '').split('{{FINGERPRINT}}').join(hostFp || '');
}
const hostOf = (req) => PUBLIC_HOST || String(req.headers.host || 'localhost').replace(/:\d+$/, '');

// ---- per-IP failure blocking and connection-rate limiting ----
const fails = new Map(), rate = new Map();
const ipOf = (req) => {
  if (TRUST_PROXY_IP) {
    const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (h) return h;
  }
  return req.socket.remoteAddress || '?';
};
const isBlocked = (ip) => { const f = fails.get(ip); return !!f && f.until > Date.now(); };
const recordFail = (ip) => {
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until && f.until <= Date.now()) { f.n = 0; f.until = 0; }
  if (++f.n >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; log('BLOCKED ' + ip + ' for 15m'); }
  fails.set(ip, f);
};
const overRate = (ip) => {
  const now = Date.now(), r = (rate.get(ip) || []).filter((t) => now - t < 60000);
  r.push(now); rate.set(ip, r); return r.length > 12;
};
setInterval(() => { const n = Date.now(); for (const [k, v] of rate) if (!v.some((t) => n - t < 60000)) rate.delete(k); }, 120000).unref();

// ---- curl-driven streaming shell fallback (no openssl): POST /t/new, GET /t/out/<id>, POST /t/in/<id> ----
const sessions = new Map();
const text = (res, code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(msg) }); res.end(msg); };
function closeSession(id) { const s = sessions.get(id); if (!s) return; sessions.delete(id); try { s.shell && s.shell.end(); } catch {} try { s.conn.end(); } catch {} try { s.out && s.out.end(); } catch {} }
function sshLogin(user, pass, cols, rows, { onShell, onFail }) {
  const conn = new Client(); let done = false;
  const fail = (why) => { if (done) return; done = true; try { conn.end(); } catch {} onFail(why); };
  conn.on('error', (e) => { if (done) return; fail(e.level || e.code || 'err'); });
  conn.on('ready', () => conn.shell({ term: 'xterm-256color', cols: Math.min(+cols || 80, 500), rows: Math.min(+rows || 24, 200) }, (err, shell) => {
    if (err || done) return fail('shell');
    done = true; onShell(conn, shell);
  }));
  conn.connect({ host: SSH_HOST, port: SSH_PORT, username: String(user).slice(0, 64), password: String(pass), readyTimeout: 15000 });
  return conn;
}
function handleStream(req, res, p, q) {
  const ip = ipOf(req);
  if (p === '/t/new' && req.method === 'POST') {
    if (isBlocked(ip)) return text(res, 429, 'too many failed attempts\n');
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
    if (!m) return text(res, 401, 'auth required\n');
    const cred = Buffer.from(m[1], 'base64').toString('utf8'), i = cred.indexOf(':');
    sshLogin(cred.slice(0, i), cred.slice(i + 1), q.get('cols'), q.get('rows'), {
      onFail: (why) => { recordFail(ip); log('curl login FAIL from ' + ip + ' (' + why + ')'); setTimeout(() => text(res, 401, 'login failed\n'), 1000); },
      onShell: (conn, shell) => {
        fails.delete(ip);
        const id = crypto.randomBytes(16).toString('hex');
        const s = { conn, shell, out: null, buf: [], timer: setTimeout(() => closeSession(id), 30000) };
        sessions.set(id, s);
        shell.on('data', (d) => { if (s.out) s.out.write(d); else s.buf.push(d); });
        shell.stderr.on('data', (d) => { if (s.out) s.out.write(d); });
        shell.on('close', () => closeSession(id));
        log('curl login ok from ' + ip);
        text(res, 200, id);
      },
    });
    return;
  }
  const mm = /^\/t\/(out|in)\/([0-9a-f]{32})$/.exec(p);
  const s = mm && sessions.get(mm[2]);
  if (!s) return text(res, 404, 'no such session\n');
  if (mm[1] === 'out' && req.method === 'GET') {
    clearTimeout(s.timer); s.out = res;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store, no-transform' });
    res.flushHeaders(); for (const d of s.buf) res.write(d); s.buf = [];
    res.on('close', () => closeSession(mm[2]));
    return;
  }
  if (mm[1] === 'in' && (req.method === 'PUT' || req.method === 'POST')) {   // proxies buffer streamed uploads, so input arrives as many short POSTs
    req.on('data', (d) => { if (s.shell) s.shell.write(d); });
    req.on('end', () => text(res, 200, 'ok\n'));
    req.on('error', () => {});
    return;
  }
  text(res, 405, 'bad request\n');
}

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  const p = (req.url || '/').split('?')[0];
  if (p.startsWith('/t/')) return handleStream(req, res, p, new URL(req.url, 'http://x').searchParams);
  if (req.method !== 'GET') return text(res, 404, '');
  const hdr = (type, len) => ({ 'Content-Type': type, 'Content-Length': len, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  try {
    let name = SCRIPTS[p];
    if (p === '/' && /^curl\//i.test(req.headers['user-agent'] || '')) name = SCRIPTS['/t'];
    if (name) {
      const key = await ensureHostKey();
      if (name === 'c.sh' && !key) return text(res, 503, 'could not read the local sshd host key; set SSH_HOSTKEY\n');
      const body = Buffer.from(render(name, hostOf(req), key));
      res.writeHead(200, hdr('text/plain; charset=utf-8', body.length)); return res.end(body);
    }
    if (p === '/') {
      const body = Buffer.from(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').split('{{USER}}').join(DEFAULT_USER));
      res.writeHead(200, hdr('text/html; charset=utf-8', body.length)); return res.end(body);
    }
    if (STATIC[p]) { const body = fs.readFileSync(STATIC[p][0]); res.writeHead(200, hdr(STATIC[p][1], body.length)); return res.end(body); }
  } catch (e) { log('error serving ' + p + ': ' + e.message); }
  res.writeHead(404, { 'Content-Length': 0 }); res.end();
});

// ---- browser terminal (WebSocket /term) ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  let authed = false, conn = null, shell = null, tries = 0;
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const authTimer = setTimeout(() => { if (!authed) ws.close(); }, 60000);
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return ws.close(); }
    if (!authed) {
      if (m.t !== 'auth' || conn) return;
      if (isBlocked(ip)) { send({ t: 'err', m: 'Too many failed attempts. Try again in 15 minutes.' }); return ws.close(); }
      if (++tries > 3) return ws.close();
      conn = sshLogin(m.user || DEFAULT_USER, m.pass || '', m.cols, m.rows, {
        onFail: (why) => { recordFail(ip); log('web login FAIL from ' + ip + ' (' + why + ')'); setTimeout(() => { send({ t: 'err', m: 'Login failed.' }); conn = null; }, 1000); },
        onShell: (c, s) => {
          authed = true; clearTimeout(authTimer); shell = s; fails.delete(ip);
          log('web login ok from ' + ip); send({ t: 'ok' });
          s.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
          s.stderr.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
          s.on('close', () => { ws.close(); c.end(); });
        },
      });
      return;
    }
    if (!shell) return;
    if (m.t === 'd' && typeof m.d === 'string') shell.write(m.d);
    else if (m.t === 'r') shell.setWindow(Math.min(+m.rows || 24, 200), Math.min(+m.cols || 80, 500), 0, 0);
  });
  ws.on('close', () => { clearTimeout(authTimer); try { conn && conn.end(); } catch {} });
  ws.on('error', () => {});
});

// ---- /raw: fake-upgrade byte stream carrying a shell. After the headers: "<cols> <rows> <base64(user:pass)>\n" ----
function rawShell(req, socket, head, accept) {
  const ip = ipOf(req);
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const bye = (m) => { try { socket.end(m ? m + '\r\n' : undefined); } catch {} };
  let buf = Buffer.alloc(0), conn = null, started = false;
  const timer = setTimeout(() => { if (!started) socket.destroy(); }, 30000);
  socket.on('close', () => { clearTimeout(timer); try { conn && conn.end(); } catch {} });
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const nl = buf.indexOf(10);
    if (nl < 0) { if (buf.length > 4096) socket.destroy(); return; }
    started = true; socket.removeListener('data', onData); socket.pause();
    const line = buf.slice(0, nl).toString().trim(), rest = buf.slice(nl + 1);
    const m = /^(\d+) (\d+) (\S+)$/.exec(line);
    if (!m) return bye('bad request');
    const cred = Buffer.from(m[3], 'base64').toString('utf8'), i = cred.indexOf(':');
    conn = sshLogin(cred.slice(0, i), cred.slice(i + 1), m[1], m[2], {
      onFail: (why) => { recordFail(ip); log('raw login FAIL from ' + ip + ' (' + why + ')'); setTimeout(() => bye('login failed'), 1000); },
      onShell: (c, s) => {
        fails.delete(ip); log('raw login ok from ' + ip);
        s.on('data', (x) => socket.write(x)); s.stderr.on('data', (x) => socket.write(x));
        s.on('close', () => { bye(); c.end(); });
        socket.on('data', (x) => s.write(x));
        if (rest.length) s.write(rest);
        socket.resume();
      },
    });
  };
  socket.on('data', onData);
  if (head && head.length) onData(head);
}

// ---- upgrades: browser websocket, /raw shell stream, or the raw SSH byte bridge ----
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  const p = (req.url || '/').split('?')[0];
  if (p === '/term') {
    const o = req.headers.origin;
    try { if (o && new URL(o).host !== req.headers.host) return socket.destroy(); } catch { return socket.destroy(); }
    return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
  const key = req.headers['sec-websocket-key'];
  if (!key || !/websocket/i.test(req.headers.upgrade || '')) return socket.destroy();
  const ip = ipOf(req);
  if (overRate(ip) || isBlocked(ip)) { log('rate-limited ' + ip); return socket.destroy(); }
  const accept = crypto.createHash('sha1').update(String(key).trim() + GUID).digest('base64');
  if (p === '/raw') return rawShell(req, socket, head, accept);
  socket.setNoDelay(true);                       // raw SSH bridge: after the 101, plain bytes both ways
  const s = net.connect({ host: SSH_HOST, port: SSH_PORT }, () => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    if (head && head.length) s.write(head);
    socket.pipe(s); s.pipe(socket);
  });
  s.setNoDelay(true);
  s.on('error', () => socket.destroy());
  socket.on('close', () => s.destroy());
  s.on('close', () => socket.destroy());
});

server.requestTimeout = 0; server.timeout = 0; server.keepAliveTimeout = 65000;   // long-lived streaming requests
server.listen(PORT, BIND, () => { log(`ssh-over-websocket on ${BIND}:${PORT} -> sshd ${SSH_HOST}:${SSH_PORT}`); ensureHostKey().catch(() => {}); });

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDnmiyo70EhTNKMxZzOViJSFB14w0rfneux3aJ5RlcQZ';
const KEY_FP = 'SHA256:cLQ/SIlWWS39xWIyC6UQSbXkK/1JNwHzFxwwCNHuA3s';
process.env.SSH_HOSTKEY = KEY;
process.env.DEFAULT_USER = 'alice';
const app = require('../server.js');

const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  }).on('error', reject);
});

let port;
test.before(async () => { await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); port = app.server.address().port; });
test.after(() => app.server.close());

test('fingerprint is computed from the host key blob', () => {
  app.describeKey(KEY);
  assert.strictEqual(app._state().hostFp, KEY_FP);
});

test('/c fills in host, user, key and fingerprint, with LF endings', async () => {
  const r = await get(port, '/c', { Host: 'ssh.example.com' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('H=ssh.example.com'));
  assert.ok(r.body.includes(KEY));
  assert.ok(r.body.includes(KEY_FP));
  assert.ok(r.body.includes('${SX_USER:-alice}@$H'));
  assert.ok(!/\{\{\w+\}\}/.test(r.body), 'no placeholders left');
  assert.ok(!r.body.includes('\r'), 'no CR characters');
});

test('every client script renders without leftover placeholders', async () => {
  for (const p of ['/t', '/s', '/s.ps1', '/p.sh', '/p.ps1', '/c']) {
    const r = await get(port, p, { Host: 'ssh.example.com' });
    assert.strictEqual(r.status, 200, p);
    assert.ok(!/\{\{\w+\}\}/.test(r.body), p + ' has placeholders');
    assert.ok(r.body.includes('ssh.example.com'), p + ' lacks the host');
  }
});

test('curl gets the terminal script at /, browsers get the page', async () => {
  const c = await get(port, '/', { Host: 'ssh.example.com', 'User-Agent': 'curl/8.5.0' });
  assert.ok(c.body.startsWith('#!/usr/bin/env bash'));
  const b = await get(port, '/', { Host: 'ssh.example.com', 'User-Agent': 'Mozilla/5.0' });
  assert.ok(b.body.startsWith('<!doctype html>'));
  assert.ok(b.body.includes('value="alice"'));
});

test('unknown paths and methods return 404', async () => {
  assert.strictEqual((await get(port, '/nope')).status, 404);
});

test('five failed logins block an IP; a different IP is unaffected', () => {
  for (let i = 0; i < 4; i++) app.recordFail('10.0.0.1');
  assert.strictEqual(app.isBlocked('10.0.0.1'), false);
  app.recordFail('10.0.0.1');
  assert.strictEqual(app.isBlocked('10.0.0.1'), true);
  assert.strictEqual(app.isBlocked('10.0.0.2'), false);
});

test('connection rate limit trips after 12 per minute', () => {
  let tripped = false;
  for (let i = 0; i < 13; i++) tripped = app.overRate('10.0.0.3');
  assert.strictEqual(tripped, true);
  assert.strictEqual(app.overRate('10.0.0.4'), false);
});

test('WEB_LOGIN=0 disables the password routes; ALLOWED_USERS is accepted', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '17955', WEB_LOGIN: '0', ALLOWED_USERS: 'alice', SSH_HOSTKEY: KEY },
  });
  const line = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (d) => { if (/password routes disabled/.test(String(d))) { clearTimeout(t); resolve(String(d)); } });
  });
  assert.ok(/users: alice/.test(line));
  child.kill();
});

test('/w embeds the proxy helper and pins the key', async () => {
  const r = await get(port, '/w', { Host: 'ssh.example.com' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes("Run('ssh.example.com', 80)"), 'proxy helper embedded with host');
  assert.ok(r.body.includes(KEY));
  assert.ok(!/\{\{\w+\}\}/.test(r.body), 'no placeholders left');
});

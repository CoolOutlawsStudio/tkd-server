'use strict';
const { spawn } = require('child_process'), path = require('path'), WebSocket = require('ws');
const ROOT = path.join(__dirname, '..');
const ORIGIN = 'https://cooloutlawsstudio.github.io';
let pass = 0, fail = 0;
function check(c, name, extra) { if (c) pass++; else fail++; console.log('  ' + (c ? 'PASS' : 'FAIL') + ' ' + name + (extra != null ? ' (' + extra + ')' : '')); return c; }
function summary(label) { console.log(label + ': ' + pass + ' passed, ' + fail + ' failed'); if (fail) process.exitCode = 1; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what); }
// spawn server.js as a child (so SIGTERM is real). opts.prefix e.g. ['taskset','-c','3']
function spawnServer(env, opts) {
  opts = opts || {};
  const cmd = opts.prefix ? opts.prefix[0] : process.execPath;
  const args = opts.prefix ? opts.prefix.slice(1).concat([process.execPath, 'server.js']) : ['server.js'];
  const child = spawn(cmd, args, { cwd: ROOT, env: Object.assign({ PATH: process.env.PATH, ALLOW_NO_ORIGIN: '1' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  child.out = '';
  const onData = (d) => { child.out += d; if (opts.echo) process.stdout.write('    [srv] ' + d); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  return child;
}
async function getJson(port, p, headers) {
  const res = await fetch('http://127.0.0.1:' + port + p, { headers: headers || {} });
  return { status: res.status, headers: res.headers, body: await res.json() };
}
function connect(port, o) {
  o = o || {};
  const ws = new WebSocket('ws://127.0.0.1:' + port + (o.path || '/arena'), { headers: o.origin === null ? {} : { Origin: o.origin || ORIGIN } });
  ws.msgs = []; ws.counts = {};
  ws.on('message', (d) => { const m = JSON.parse(String(d)); m._rx = Date.now(); if (!o.noKeep || m.type !== 'frame') ws.msgs.push(m); ws.counts[m.type] = (ws.counts[m.type] || 0) + 1; if (o.onMsg) o.onMsg(m); });
  ws.opened = new Promise((r, j) => { ws.on('open', r); ws.on('error', j); ws.on('unexpected-response', (req, res) => j(new Error('HTTP ' + res.statusCode))); });
  ws.closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  if (o.hello !== false) ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, epochSeen: null })));
  return ws;
}
module.exports = { check, summary, sleep, waitFor, spawnServer, getJson, connect, ROOT, ORIGIN };

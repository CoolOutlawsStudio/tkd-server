#!/usr/bin/env node
// TKD-Net Arena server (owner: Moneyman). One process trains the two Arena fighters forever and streams the live
// match to every connected page over WebSocket (protocol: ARENA-SERVER-CONTRACT.md, section 6).
//   main thread  : HTTP (/health, /state), WebSocket /arena, fan-out, persistence schedule, shutdown
//   worker thread: lib/arena-host.js -> the UNCHANGED browser worker vendor/arena-worker.js (+ arena-sim/rl/store)
// Node >= 18, one dependency (ws). Config is env only (README.md).
'use strict';
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const { Worker } = require('worker_threads');
const { WebSocketServer } = require('ws');
const { createPersistence } = require('./lib/persistence');

const SERVER_VERSION = '1.0.0', PROTOCOL = 1;
const VENDOR = path.join(__dirname, 'vendor');

function num(v, d) { const n = Number(v); return v != null && v !== '' && isFinite(n) ? n : d; }
function config(env) {
  return {
    port: num(env.PORT, 8080), bind: env.BIND || '0.0.0.0',
    adminToken: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16 ? env.ADMIN_TOKEN : null,
    origins: (env.ALLOWED_ORIGINS || 'https://cooloutlawsstudio.github.io,https://tkd-net.netlify.app').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    allowNoOrigin: env.ALLOW_NO_ORIGIN !== '0',
    maxViewers: num(env.MAX_VIEWERS, 100), frameHz: Math.min(30, Math.max(1, num(env.FRAME_HZ, 15))),
    saveEveryMs: num(env.SAVE_EVERY_S, 60) * 1000, poolEveryMs: num(env.POOL_SAVE_EVERY_S, 600) * 1000,
    seed: num(env.ARENA_SEED, 1) >>> 0, vizMs: num(env.VIZ_MS, 1000), heartbeatMs: num(env.HEARTBEAT_S, 20) * 1000,
    historyRounds: num(env.HISTORY_ROUNDS, 100), historyElo: num(env.HISTORY_ELO, 120),
    workerHeapMb: num(env.WORKER_HEAP_MB, 512), memLogMs: num(env.MEM_LOG_S, 60) * 1000,
    hostName: env.SERVER_NAME || env.RENDER_SERVICE_NAME || env.FLY_APP_NAME || os.hostname(),
    shutdownMs: num(env.SHUTDOWN_TIMEOUT_S, 20) * 1000, watchdogMs: num(env.WATCHDOG_S, 30) * 1000,
    deflate: env.WS_DEFLATE !== '0', learnMs: 1000 / Math.max(0.01, num(env.LEARN_HZ, 1)), roundMsgs: env.ROUND_MSGS === 'live' ? 'live' : 'all',
    frameBufferLimit: 64 * 1024, hardBufferLimit: 2 * 1024 * 1024, quiet: env.QUIET === '1'
  };
}
function sha8File(f) { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 8); } catch (e) { return null; } }
function iso(t) { return t ? new Date(t).toISOString() : null; }
function plain(v, depth) { // typed arrays -> rounded plain arrays (JSON), recursively (viz)
  if (depth > 8 || v == null) return v;
  if (ArrayBuffer.isView(v)) return Array.from(v, (x) => Math.round(x * 1e4) / 1e4);
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k], depth + 1); return o; }
  return v;
}

function start(env, opts) {
  opts = opts || {};
  const C = config(env);
  const log = (...a) => { if (!C.quiet) console.log(new Date().toISOString(), ...a); };
  const P = createPersistence(env, { fetch: opts.fetch });
  const files = {};
  ['arena-sim.js', 'arena-rl.js', 'arena-worker.js', 'arena-store.js'].forEach((n) => { files[n] = sha8File(path.join(VENDOR, n)); });
  const S = {
    bootId: crypto.randomBytes(6).toString('hex'), startedAt: Date.now(), state: 'waking', since: Date.now(), message: 'starting',
    kv: {}, dirtyState: false, dirtyPool: false, lastPoolUpload: 0, worker: null, workerAlive: false, lastWorkerMsg: 0, restarts: 0,
    workerEpoch: 0, workerEpochMin: 0, awaitReady: false, ready: null, status: null, stats: null, lastElo: null, lastSavedRemote: null,
    lastFrame: null, frameSentAt: 0, frameTimer: null, frameSeq: 0, recentRounds: [], recentElo: [], lastLearnSent: [0, 0],
    localSaveWaiters: [], saving: null, shuttingDown: false, lastResetAt: 0, booted: null, mem: { rssMB: null, workerHeapMB: null, at: null },
    restoredInfo: null, bytesOutClosed: 0, framesSent: 0, framesDropped: 0, vizSeq: 0, clients: new Set(), restartTimer: null, backoffMs: 5000
  };

  // ------------------------------------------------------------ server info / hello
  function rounds() { return S.stats ? S.stats.rounds : (S.kv.meta && S.kv.meta.coach ? S.kv.meta.coach.rounds | 0 : (S.ready ? S.ready.rounds : 0)); }
  function trainSeconds() { return S.stats ? S.stats.trainSeconds : (S.kv.meta && S.kv.meta.coach ? Math.round(S.kv.meta.coach.trainSeconds || 0) : 0); }
  function serverInfo() {
    return { host: C.hostName, bootId: S.bootId, startedAt: iso(S.startedAt), uptime: Math.round((Date.now() - S.startedAt) / 1000),
      state: S.state, since: iso(S.since), message: S.message || null, trainSeconds: trainSeconds(), rounds: rounds(),
      viewers: S.clients.size, maxViewers: C.maxViewers, frameHz: C.frameHz, restarts: S.restarts, epoch: P.resets,
      persistence: P.state(), version: { server: SERVER_VERSION, protocol: PROTOCOL, files, rl: S.booted && S.booted.rlVersion, sim: S.booted && S.booted.simName },
      memory: S.mem };
  }
  function helloMsg(extra) { const i = serverInfo(); return Object.assign({ type: 'hello', protocol: PROTOCOL, state: i.state, since: i.since, message: i.message, rounds: i.rounds, viewers: i.viewers, persistence: i.persistence, version: i.version, epoch: P.resets, server: i }, extra || {}); }
  function setState(state, message) {
    const changed = state !== S.state || (message || null) !== (S.message || null);
    if (state !== S.state) S.since = Date.now();
    S.state = state; S.message = message || null;
    if (changed) { log('state', state, message || ''); broadcast(helloMsg({ change: true })); }
  }

  // ------------------------------------------------------------ fan-out
  function sendRaw(ws, data, isFrame) {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > C.hardBufferLimit) { ws.terminate(); return; } // hopelessly slow: drop the viewer, never the trainer
    if (isFrame && ws.bufferedAmount > C.frameBufferLimit) { ws._tkd.dropped++; S.framesDropped++; return; }
    ws.send(data);
    if (isFrame) S.framesSent++;
  }
  function stamp(m) { m.epoch = P.resets; return m; }
  function broadcast(m, isFrame) {
    if (!S.clients.size) return;
    const data = JSON.stringify(stamp(m));
    for (const ws of S.clients) if (ws._tkd.welcomed) sendRaw(ws, data, isFrame);
  }
  function sendTo(ws, m) { sendRaw(ws, JSON.stringify(stamp(m)), false); }

  function pumpFrame() {
    S.frameTimer = null;
    if (!S.lastFrame || S.lastFrame._sent) return;
    const t = Date.now(), gap = 1000 / C.frameHz;
    if (t - S.frameSentAt < gap) { S.frameTimer = setTimeout(pumpFrame, gap - (t - S.frameSentAt)); return; }
    S.frameSentAt = t; S.lastFrame._sent = true;
    const f = S.lastFrame;
    broadcast({ type: 'frame', round: f.round, t: f.t, state: f.state, seq: ++S.frameSeq }, true);
  }

  function historyMsg() {
    const h = S.kv.history || { rounds: [], elo: [] };
    const rs = (h.rounds || []).slice(), es = (h.elo || []).slice();
    const lastR = rs.length ? rs[rs.length - 1].round : -1, lastE = es.length ? es[es.length - 1].rounds : -1;
    S.recentRounds.forEach((r) => { if (r.round > lastR) rs.push(r); });
    S.recentElo.forEach((e) => { if (e.rounds > lastE) es.push(e); });
    return { type: 'history', replay: true, rounds: rs.slice(-C.historyRounds), elo: es.slice(-C.historyElo) };
  }
  function welcome(ws) {
    ws._tkd.welcomed = true;
    sendTo(ws, helloMsg());
    if (S.ready) sendTo(ws, Object.assign({}, S.ready, { replay: true, server: serverInfo() }));
    if (S.status) sendTo(ws, Object.assign({}, S.status, { replay: true }));
    if (S.ready) sendTo(ws, historyMsg());
    if (S.lastElo) sendTo(ws, Object.assign({}, S.lastElo, { replay: true }));
    if (S.stats) sendTo(ws, Object.assign({}, S.stats, { replay: true, server: serverInfo() }));
    if (S.lastSavedRemote) sendTo(ws, Object.assign({}, S.lastSavedRemote, { replay: true }));
    if (S.lastFrame) sendTo(ws, { type: 'frame', round: S.lastFrame.round, t: S.lastFrame.t, state: S.lastFrame.state, seq: S.frameSeq, replay: true });
  }

  // ------------------------------------------------------------ worker thread
  function spawnWorker() {
    S.ready = null; S.status = null; S.awaitReady = false; S.workerEpochMin = 0; S.workerEpoch = 0;
    const seedKv = {}; for (const k of ['brains', 'pool', 'history', 'meta']) if (S.kv[k]) seedKv[k] = S.kv[k];
    const w = new Worker(path.join(__dirname, 'lib', 'arena-host.js'), {
      workerData: { vendorDir: VENDOR, seedKv }, resourceLimits: { maxOldGenerationSizeMb: C.workerHeapMb }
    });
    S.worker = w; S.workerAlive = true; S.lastWorkerMsg = Date.now();
    w.on('message', (m) => { if (S.worker === w) onWorkerMessage(m); });
    w.on('error', (e) => { log('worker error', e && e.stack || e); });
    w.on('exit', (code) => {
      if (S.worker !== w) return;
      S.workerAlive = false;
      if (!S.shuttingDown) { log('worker exited with code', code); scheduleRestart('trainer stopped (exit ' + code + ')'); }
    });
    w.postMessage({ type: 'start', seed: C.seed, speed: 1, practice: true, fresh: false });
  }
  function scheduleRestart(why) {
    if (S.shuttingDown || S.restartTimer) return;
    setState('paused', why + '; restarting in ' + Math.round(S.backoffMs / 1000) + ' s');
    const w = S.worker; S.worker = null; S.workerAlive = false;
    if (w) w.terminate().catch(() => {});
    S.restartTimer = setTimeout(() => { S.restartTimer = null; S.restarts++; setState('resuming', 'restarting the trainer from the last saved brains'); spawnWorker(); }, S.backoffMs);
    S.backoffMs = Math.min(300000, S.backoffMs * 2);
  }

  function onWorkerMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    S.lastWorkerMsg = Date.now();
    switch (m.type) {
      case '__booted': S.booted = m; return;
      case '__mem': S.mem.workerHeapMB = Math.round(m.heapUsed / 1048576 * 10) / 10; S.mem.workerHeapTotalMB = Math.round(m.heapTotal / 1048576 * 10) / 10; return;
      case '__kv':
        if (S.awaitReady) return; // a write from before an admin reset: never resurrect old brains
        S.kv[m.key] = m.value;
        if (m.key === 'pool') S.dirtyPool = true; else S.dirtyState = true;
        return;
      case '__kvdel': S.kv[m.key] = null; S.dirtyState = true; if (m.key === 'pool') S.dirtyPool = true; return;
    }
    if (typeof m.epoch === 'number') {
      if (m.epoch < S.workerEpochMin) return; // from before an admin reset
      S.workerEpoch = Math.max(S.workerEpoch, m.epoch);
    }
    switch (m.type) {
      case 'ready':
        S.awaitReady = false;
        delete m.epoch; m.mode = 'server'; m.storage = P.mode !== 'memory'; m.persistence = P.mode;
        S.ready = m; S.recentRounds = []; S.recentElo = [];
        broadcast(Object.assign({}, m, { server: serverInfo() }));
        broadcast(historyMsg()); // viewers that connected before ready (or across a reset) get the chart history now
        return;
      case 'status':
        delete m.epoch; m.mode = 'server';
        if (m.state === 'error') { S.status = m; broadcast(Object.assign({}, m)); scheduleRestart('trainer error: ' + (m.message || 'unknown')); return; }
        if (m.message && /IndexedDB unavailable/.test(m.message)) delete m.message; // not true on the server (mem-idb)
        S.status = m;
        if (m.state === 'running') { setState('training', P.mode === 'memory' ? 'training (memory only: nothing survives a restart)' : null); S.backoffMs = 5000; }
        broadcast(Object.assign({}, m));
        return;
      case 'frame':
        delete m.epoch; S.lastFrame = m;
        if (S.clients.size && !S.frameTimer) pumpFrame();
        return;
      case 'round': {
        delete m.epoch;
        S.recentRounds.push({ round: m.round, winner: m.winner, hitsA: m.hits[0], hitsB: m.hits[1], live: m.live, kind: m.kind });
        if (S.recentRounds.length > 500) S.recentRounds.splice(0, S.recentRounds.length - 500);
        if (C.roundMsgs === 'all' || m.live) broadcast(m);
        return;
      }
      case 'learn': {
        delete m.epoch; const f = m.fighter | 0, t = Date.now();
        if (t - S.lastLearnSent[f] >= C.learnMs) { S.lastLearnSent[f] = t; broadcast(m); }
        return;
      }
      case 'elo':
        delete m.epoch; S.lastElo = m;
        S.recentElo.push({ rounds: m.rounds, a: m.a, b: m.b, vsScripted: m.vsScripted, vsPast: m.vsPast, games: m.games, trainSeconds: m.trainSeconds, at: m.at });
        if (S.recentElo.length > 200) S.recentElo.splice(0, S.recentElo.length - 200);
        broadcast(m); return;
      case 'stats':
        delete m.epoch; S.stats = m;
        broadcast(Object.assign({}, m, { server: serverInfo() })); return;
      case 'saved': { // the worker's local save into mem-idb (every ~5 s); remote uploads post their own 'saved'
        const ws = S.localSaveWaiters; S.localSaveWaiters = []; ws.forEach((fn) => fn(m)); return;
      }
      case 'viz':
        delete m.epoch; broadcast(plain(m, 0)); return;
      case 'error':
        delete m.epoch; broadcast(m); return;
      default:
        return; // weights etc. are not exposed
    }
  }

  // ------------------------------------------------------------ persistence schedule
  async function upload(why, o) {
    o = o || {};
    if (P.mode === 'memory') return null;
    if (S.saving) { if (!o.force) return null; try { await S.saving; } catch (e) { /* ignore */ } }
    if (!S.kv.brains && !S.resetMarker) return null; // nothing trained yet (only the sessions counter): don't save
    S.resetMarker = false;
    const withPool = !!S.kv.pool && (o.pool || P.generation.pool === 0 || (S.dirtyPool && Date.now() - S.lastPoolUpload >= C.poolEveryMs));
    const kv = S.kv, coach = kv.meta && kv.meta.coach;
    const meta = { resets: P.resets, rounds: coach ? coach.rounds | 0 : 0, trainSeconds: coach ? Math.round(coach.trainSeconds || 0) : 0, host: C.hostName, bootId: S.bootId, why, files };
    S.dirtyState = false; const hadPoolDirty = S.dirtyPool; if (withPool) S.dirtyPool = false;
    const t0 = Date.now();
    S.saving = P.save(kv, { withPool, meta, timeoutMs: o.timeoutMs });
    try {
      const r = await S.saving;
      if (withPool) S.lastPoolUpload = Date.now();
      S.lastSavedRemote = { type: 'saved', remote: true, persistence: P.mode, generation: r.generation, rounds: meta.rounds, trainSeconds: meta.trainSeconds,
        bytes: r.bytes + r.poolBytes, stateBytes: r.bytes, poolBytes: r.poolBytes, pool: withPool, at: Date.now(), ms: Date.now() - t0, why };
      broadcast(Object.assign({}, S.lastSavedRemote));
      log('saved gen', r.generation, why, 'state', r.bytes, 'B', withPool ? 'pool ' + r.poolBytes + ' B' : '', (Date.now() - t0) + ' ms', 'rounds', meta.rounds);
      return r;
    } catch (e) {
      S.dirtyState = true; if (withPool || hadPoolDirty) S.dirtyPool = true;
      log('save failed (' + why + '):', e.message);
      broadcast({ type: 'status', state: 'running', mode: 'server', message: 'could not save the brains: ' + e.message, practice: true, speed: 1 });
      return null;
    } finally { S.saving = null; }
  }
  function waitLocalSave(ms) {
    return new Promise((res) => { const t = setTimeout(() => res(null), ms); S.localSaveWaiters.push((m) => { clearTimeout(t); res(m); }); });
  }

  // ------------------------------------------------------------ admin reset
  async function adminReset(ws) {
    if (Date.now() - S.lastResetAt < 60000) { sendTo(ws, { type: 'error', code: 'rate', message: 'reset: at most one per minute' }); return; }
    S.lastResetAt = Date.now();
    log('ADMIN RESET from', ws._tkd.ip);
    S.workerEpochMin = S.workerEpoch + 1; S.awaitReady = true;
    S.kv = { meta: S.kv.meta || null }; S.dirtyState = true; S.resetMarker = true; S.dirtyPool = false; S.recentRounds = []; S.recentElo = []; S.lastElo = null; S.stats = null; S.lastFrame = null;
    try { await P.clear(); } catch (e) { log('remote clear failed:', e.message); }
    if (S.worker) S.worker.postMessage({ type: 'reset' });
    broadcast(helloMsg({ change: true, reset: true }));
  }

  // ------------------------------------------------------------ HTTP
  function cors(req, res) {
    const o = (req.headers.origin || '').replace(/\/+$/, '');
    if (o && C.origins.indexOf(o) >= 0) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); res.setHeader('Access-Control-Max-Age', '600'); }
  }
  function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) }); res.end(b); }
  function wsBytesOut() { let b = S.bytesOutClosed; for (const ws of S.clients) { const n = (ws._socket && ws._socket.bytesWritten) || 0; ws._tkd.lastBytes = n; b += n; } return b; }
  function healthy() { return !S.shuttingDown && S.workerAlive && Date.now() - S.lastWorkerMsg < C.watchdogMs; }
  const server = http.createServer((req, res) => {
    cors(req, res);
    const p = (req.url || '/').split('?')[0];
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
    if (p === '/health') { const ok = healthy() || S.state === 'waking' || S.state === 'resuming'; json(res, ok ? 200 : 503, { ok, state: S.state, uptime: Math.round((Date.now() - S.startedAt) / 1000), version: SERVER_VERSION }); return; }
    if (p === '/state') {
      const e = S.lastElo;
      json(res, 200, { server: serverInfo(), elo: e ? { rounds: e.rounds, a: e.a, b: e.b, se: e.se, anchors: e.anchors, at: e.at } : null,
        stats: S.stats ? { roundsPerSec: S.stats.roundsPerSec, stepsPerSec: S.stats.stepsPerSec, liveRounds: S.stats.liveRounds, practiceRounds: S.stats.practiceRounds, wins: S.stats.wins, updates: S.stats.updates, droppedTrajectories: S.stats.droppedTrajectories } : null,
        live: S.lastFrame ? { round: S.lastFrame.round, t: S.lastFrame.t } : null, framesSent: S.framesSent, framesDropped: S.framesDropped, restored: S.restoredInfo,
        net: { wsBytesOut: wsBytesOut(), deflate: C.deflate, frameHz: C.frameHz, vizMs: C.vizMs, learnHz: Math.round(1000 / C.learnMs * 100) / 100, roundMsgs: C.roundMsgs } });
      return;
    }
    if (p === '/') { json(res, 200, { name: 'tkd-arena-server', ws: '/arena', health: '/health', state: '/state', protocol: PROTOCOL }); return; }
    json(res, 404, { error: 'not found' });
  });

  // ------------------------------------------------------------ WebSocket /arena
  // permessage-deflate with context takeover: consecutive frames are near-identical JSON, so the wire size drops ~5-8x
// (measured: test/bandwidth.js). Costs ~0.1 ms CPU per message per viewer. WS_DEFLATE=0 turns it off.
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: C.deflate ? { threshold: 128, zlibDeflateOptions: { level: 6, memLevel: 7 }, concurrencyLimit: 4 } : false });
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url || '').split('?')[0], origin = (req.headers.origin || '').replace(/\/+$/, '');
    const bad = (code, msg) => { socket.write('HTTP/1.1 ' + code + ' ' + msg + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); socket.destroy(); };
    if (p !== '/arena') return bad(404, 'Not Found');
    if (S.shuttingDown) return bad(503, 'Service Unavailable');
    if (origin ? C.origins.indexOf(origin) < 0 : !C.allowNoOrigin) return bad(403, 'Forbidden');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });
  function onConnection(ws, req) {
    ws._tkd = { ip: (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(), alive: true, dropped: 0, welcomed: false, bucket: 20, bucketAt: Date.now() };
    if (S.clients.size >= C.maxViewers) {
      ws.send(JSON.stringify({ type: 'error', code: 'full', message: 'server full (' + C.maxViewers + ' viewers): use in-browser mode', epoch: P.resets }));
      ws.close(1013, 'server full'); return;
    }
    S.clients.add(ws);
    ws.on('pong', () => { ws._tkd.alive = true; });
    ws.on('close', () => { S.clients.delete(ws); S.bytesOutClosed += (ws._socket && ws._socket.bytesWritten) || ws._tkd.lastBytes || 0; });
    ws.on('error', () => { S.clients.delete(ws); });
    ws.on('message', (data, isBinary) => {
      const t = Date.now(), k = ws._tkd;
      k.bucket = Math.min(20, k.bucket + (t - k.bucketAt) / 500); k.bucketAt = t; // 2 msgs/s sustained, burst 20
      if (k.bucket < 1) { ws.close(1008, 'too many messages'); return; }
      k.bucket -= 1;
      if (isBinary) return;
      let m; try { m = JSON.parse(String(data)); } catch (e) { return; }
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'hello') {
        if (m.protocol != null && Number(m.protocol) !== PROTOCOL) { sendTo(ws, { type: 'error', code: 'protocol', message: 'server speaks protocol ' + PROTOCOL }); ws.close(4000, 'protocol'); return; }
        if (!k.welcomed) welcome(ws); else sendTo(ws, helloMsg({ reply: true, epochChanged: m.epochSeen != null && Number(m.epochSeen) !== P.resets }));
        return;
      }
      if (m.type === 'ping') { sendTo(ws, { type: 'pong', t: m.t, serverTime: Date.now() }); return; }
      if (m.type === 'reset') {
        const ok = C.adminToken && typeof m.token === 'string' && m.token.length === C.adminToken.length && crypto.timingSafeEqual(Buffer.from(m.token), Buffer.from(C.adminToken));
        if (!ok) { sendTo(ws, { type: 'error', code: 'forbidden', message: 'reset needs the admin token' }); return; }
        adminReset(ws); return;
      }
      sendTo(ws, { type: 'error', code: 'not-accepted', message: "'" + String(m.type).slice(0, 20) + "' is not accepted in server mode: the match is shared, viewers can only watch" });
    });
    // a viewer that never says hello still gets the snapshot (after 1 s)
    setTimeout(() => { if (ws.readyState === 1 && !ws._tkd.welcomed) welcome(ws); }, 1000);
    if (S.lastFrame && !S.frameTimer) S.lastFrame._sent = false;
  }

  // ------------------------------------------------------------ timers
  const timers = [];
  timers.push(setInterval(() => { // heartbeat
    for (const ws of S.clients) { if (!ws._tkd.alive) { ws.terminate(); S.clients.delete(ws); continue; } ws._tkd.alive = false; try { ws.ping(); } catch (e) { /* ignore */ } }
    broadcast(helloMsg({ heartbeat: true }));
  }, C.heartbeatMs));
  timers.push(setInterval(() => { // viz for viewers (1/s)
    if (S.clients.size && S.worker && S.state === 'training') S.worker.postMessage({ type: 'viz', id: 'server-' + (++S.vizSeq) });
  }, C.vizMs));
  timers.push(setInterval(() => { if (S.dirtyState && S.state === 'training') upload('periodic'); }, C.saveEveryMs));
  timers.push(setInterval(() => { // watchdog: a hung trainer is restarted from the last records
    if (S.worker && S.workerAlive && !S.restartTimer && !S.shuttingDown && Date.now() - S.lastWorkerMsg > C.watchdogMs) scheduleRestart('trainer silent for ' + Math.round(C.watchdogMs / 1000) + ' s');
  }, 5000));
  function memLog() {
    const mu = process.memoryUsage();
    S.mem.rssMB = Math.round(mu.rss / 1048576 * 10) / 10; S.mem.mainHeapMB = Math.round(mu.heapUsed / 1048576 * 10) / 10; S.mem.arrayBuffersMB = Math.round(mu.arrayBuffers / 1048576 * 10) / 10; S.mem.at = iso(Date.now());
    if (S.worker) S.worker.postMessage({ type: '__mem' });
    log('mem rss', S.mem.rssMB, 'MB main heap', S.mem.mainHeapMB, 'MB arrayBuffers', S.mem.arrayBuffersMB, 'MB worker heap', S.mem.workerHeapMB, 'MB | viewers', S.clients.size, 'rounds', rounds(), 'trainS', trainSeconds(), 'frames sent/dropped', S.framesSent, '/', S.framesDropped);
  }
  timers.push(setInterval(memLog, C.memLogMs));

  // ------------------------------------------------------------ shutdown
  async function shutdown(sig) {
    if (S.shuttingDown) return S.shutdownP;
    S.shuttingDown = true;
    S.shutdownP = (async () => {
      log('shutdown on', sig);
      const hard = setTimeout(() => { log('shutdown timed out; exiting'); process.exit(1); }, C.shutdownMs);
      hard.unref();
      setState('paused', 'server is restarting: saving the brains');
      if (S.worker && S.workerAlive && S.ready) {
        const p = waitLocalSave(3000);
        S.worker.postMessage({ type: 'pause' }); // pause = stop + save(force) into mem-idb -> '__kv' + 'saved'
        await p;
      }
      if (P.mode !== 'memory') await upload('shutdown ' + sig, { force: true, pool: true, timeoutMs: Math.max(2000, C.shutdownMs - 5000) });
      S.state = 'offline'; S.since = Date.now(); S.message = 'server stopped (' + sig + ')';
      broadcast(helloMsg({ change: true }));
      timers.forEach(clearInterval);
      for (const ws of S.clients) { try { ws.close(1012, 'server restarting'); } catch (e) { /* ignore */ } }
      if (S.worker) await S.worker.terminate().catch(() => {});
      await new Promise((r) => { server.close(() => r()); setTimeout(r, 1000); });
      clearTimeout(hard);
      log('shutdown complete');
    })();
    return S.shutdownP;
  }

  // ------------------------------------------------------------ boot
  const ready = (async () => {
    await new Promise((r) => server.listen(C.port, C.bind, r));
    log('listening on', C.bind + ':' + server.address().port, '| persistence', P.mode, P.where || '', P.reason || '', '| origins', C.origins.join(' '), '| files', JSON.stringify(files));
    try {
      const r = await P.load();
      S.restoredInfo = r.info;
      if (r.kv) { S.kv = r.kv; setState('resuming', 'restoring saved brains (' + r.info + ')'); } else setState('waking', 'starting fresh brains: ' + r.info);
      log('restore:', r.info);
    } catch (e) {
      S.restoredInfo = 'load failed: ' + e.message;
      log('restore FAILED:', e.message, '- starting in memory with fresh brains; saves stay off until a load succeeds');
      P.mode = 'memory'; P.reason = 'load failed (' + e.message + '): running memory-only so stored brains are not overwritten';
      setState('waking', 'could not load saved brains: starting fresh (memory only)');
    }
    spawnWorker();
    memLog();
    return server.address().port;
  })();

  return { ready, shutdown, state: S, config: C, persistence: P, server, serverInfo };
}

module.exports = { start, config };

if (require.main === module) {
  const app = start(process.env);
  const onSig = (sig) => app.shutdown(sig).then(() => process.exit(0), () => process.exit(1));
  process.on('SIGTERM', () => onSig('SIGTERM'));
  process.on('SIGINT', () => onSig('SIGINT'));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
  app.ready.catch((e) => { console.error('failed to start:', e); process.exit(1); });
}

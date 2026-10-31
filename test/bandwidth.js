// Bytes per viewer by message type over N seconds (default 120), and boot-to-training time.
// env CPU_LIMIT (e.g. 0.1) + CPU (core) like soak.js; any extra env (FRAME_HZ, VIZ_MS, ...) is passed to the server.
'use strict';
const U = require('./util');
const SECS = Number(process.argv[2] || 120), LIMIT = Number(process.env.CPU_LIMIT || 0);
(async () => {
  const port = 23000 + Math.floor(Math.random() * 900);
  const pass = {}; for (const k of ['FRAME_HZ', 'VIZ_MS', 'TRAIN_DUTY', 'LEARN_HZ', 'ROUND_MSGS', 'WS_DEFLATE', 'WIRE', 'STATS_MS', 'PRACTICE_ROUND_MS']) if (process.env[k]) pass[k] = process.env[k];
  const t0 = Date.now();
  const srv = U.spawnServer(Object.assign({ PORT: String(port), QUIET: '1' }, pass), LIMIT ? { prefix: ['taskset', '-c', process.env.CPU || '3'] } : {});
  let duty = null;
  if (LIMIT && LIMIT < 1) { const off = Math.round(100 * (1 - LIMIT)); duty = setInterval(() => { try { process.kill(srv.pid, 'SIGSTOP'); setTimeout(() => { try { process.kill(srv.pid, 'SIGCONT'); } catch (e) { /* */ } }, off); } catch (e) { /* */ } }, 100); }
  await U.waitFor(async () => { try { return (await U.getJson(port, '/state')).body.server.state === 'training'; } catch (e) { return false; } }, 60000, 'training');
  console.log('# boot -> training: ' + (Date.now() - t0) + ' ms, cpu ' + (LIMIT || 'unlimited') + ', env ' + JSON.stringify(pass));
  const by = {}, cnt = {}; const gaps = []; let last = 0;
  const ws = U.connect(port, { noKeep: true });
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.replay) return; by[m.type] = (by[m.type] || 0) + d.length; cnt[m.type] = (cnt[m.type] || 0) + 1; if (m.type === 'frame') { const t = Date.now(); if (last) gaps.push(t - last); last = t; } });
  await ws.opened; await U.sleep(2000); const w0 = (await U.getJson(port, '/state')).body.net.wsBytesOut; const ts = Date.now(); for (const k in by) { by[k] = 0; cnt[k] = 0; } gaps.length = 0;
  await U.sleep(SECS * 1000);
  const dt = (Date.now() - ts) / 1000, s = (await U.getJson(port, '/state')).body;
  let tot = 0; for (const k in by) tot += by[k];
  const wire = (s.net.wsBytesOut - w0) / dt;
  console.log('# ON THE WIRE (WebSocket bytes written, deflate ' + s.net.deflate + '): ' + (wire / 1024).toFixed(2) + ' KB/s = ' + (wire * 3600 / 1e6).toFixed(1) + ' MB/hour = ' + (wire * 86400 * 30 / 1e9).toFixed(2) + ' GB/month per viewer connected 24/7; 5 GB/month = ' + (5e9 / wire / 3600).toFixed(0) + ' viewer-hours');
  console.log('type | msgs/s | bytes/s | avg bytes');
  Object.keys(by).sort((a, b) => by[b] - by[a]).forEach((k) => console.log(k + ' | ' + (cnt[k] / dt).toFixed(2) + ' | ' + (by[k] / dt).toFixed(0) + ' | ' + (by[k] / Math.max(1, cnt[k])).toFixed(0)));
  const g = gaps.slice().sort((a, b) => a - b), p = (q) => g[Math.min(g.length - 1, Math.floor(q * g.length))];
  console.log('# JSON payload (before deflate) ' + (tot / dt / 1024).toFixed(1) + ' KB/s payload per viewer = ' + (tot / dt * 3600 / 1e6).toFixed(1) + ' MB/hour = ' + (tot / dt * 86400 * 30 / 1e9).toFixed(1) + ' GB/month if connected 24/7; 5 GB/month = ' + (5e9 / (tot / dt) / 3600).toFixed(0) + ' viewer-hours');
  console.log('# frames ' + (cnt.frame / dt).toFixed(2) + '/s, gap p50 ' + p(0.5) + ' p95 ' + p(0.95) + ' p99 ' + p(0.99) + ' max ' + g[g.length - 1] + ' ms | trainer: rounds/s ' + (s.stats && s.stats.roundsPerSec) + ', steps/s ' + (s.stats && s.stats.stepsPerSec) + ', updates ' + (s.stats && s.stats.updates) + ', live round ' + (s.live && s.live.round) + ' t ' + (s.live && s.live.t) + ' | rss ' + s.server.memory.rssMB + ' MB');
  if (duty) clearInterval(duty); try { process.kill(srv.pid, 'SIGCONT'); } catch (e) { /* */ }
  ws.close(); srv.kill('SIGTERM'); await srv.exited; process.exit();
})().catch((e) => { console.error(e); process.exit(1); });

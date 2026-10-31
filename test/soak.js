// Headless soak: node test/soak.js [minutes=20]   env CPU_LIMIT=0.5 (taskset 1 core + SIGSTOP/SIGCONT duty cycle, like a
// CFS quota of 50 ms per 100 ms), CPU=<core id for taskset>. Runs the server with the fake Supabase (60 s saves),
// 2 viewers attached, logs once a minute: RSS, worker heap, rounds, rounds/s, sim steps/s, PPO updates, Elo vs the
// scripted anchors, frames/s and inter-frame gap p50/p99 at the viewer, saves.
'use strict';
const U = require('./util'), F = require('./fake-supabase');
const MIN = Number(process.argv[2] || 20), LIMIT = Number(process.env.CPU_LIMIT || 0);
const SECRET = require('crypto').randomBytes(32).toString('base64url'), ANON = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"role":"anon"}').toString('base64url') + '.x';
(async () => {
  const fake = await F.startFake({ secretSha256: F.sha(SECRET), anonKey: ANON });
  const port = 21000 + Math.floor(Math.random() * 900);
  const prefix = LIMIT ? ['taskset', '-c', process.env.CPU || '5'] : null;
  const pass = {}; for (const k of ['MALLOC_ARENA_MAX', 'VIZ_MS', 'FRAME_HZ', 'POOL_SAVE_EVERY_S', 'SAVE_EVERY_S', 'WORKER_HEAP_MB']) if (process.env[k]) pass[k] = process.env[k];
  const srv = U.spawnServer(Object.assign({ PORT: String(port), SUPABASE_URL: fake.url, SUPABASE_ANON_KEY: ANON, SERVER_SECRET: SECRET, QUIET: '1' }, pass), prefix ? { prefix } : {});
  let duty = null;
  if (LIMIT && LIMIT < 1) { // duty-cycle limiter (what cpulimit does): run LIMIT*100 ms of every 100 ms
    const on = Math.round(100 * LIMIT), off = 100 - on;
    duty = setInterval(() => { try { process.kill(srv.pid, 'SIGSTOP'); setTimeout(() => { try { process.kill(srv.pid, 'SIGCONT'); } catch (e) { /* gone */ } }, off); } catch (e) { /* gone */ } }, 100);
    void on;
  }
  const st = async () => (await U.getJson(port, '/state')).body;
  await U.waitFor(async () => { try { return (await st()).server.state === 'training'; } catch (e) { return false; } }, 30000, 'training');
  const gaps = []; let lastRx = 0, frames = 0, saves = 0; const elos = [];
  const v1 = U.connect(port, { noKeep: true, onMsg: (m) => {
    if (m.type === 'frame' && !m.replay) { const t = Date.now(); if (lastRx) gaps.push(t - lastRx); lastRx = t; frames++; }
    if (m.type === 'elo' && !m.replay) elos.push(m);
    if (m.type === 'saved' && !m.replay) saves++;
  } });
  const v2 = U.connect(port, { noKeep: true }); await Promise.all([v1.opened, v2.opened]);
  const t0 = Date.now(); let prev = await st(), prevT = Date.now();
  const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  console.log('# soak ' + MIN + ' min, cpu ' + (LIMIT ? LIMIT + ' core (taskset -c ' + (process.env.CPU || '5') + ' + duty cycle)' : 'unlimited (8-core box, shared)') + ', node ' + process.version + ', env ' + JSON.stringify(pass));
  console.log('min | rssMB | workerHeapMB | rounds | rounds/s | steps/s | updates A/B | Elo A / B (last) | frames/s | gap p50/p99 ms | saves');
  for (let m = 1; m <= MIN; m++) {
    await U.sleep(60000 - ((Date.now() - t0) % 60000));
    const s = await st(), dt = (Date.now() - prevT) / 1000, e = elos[elos.length - 1];
    console.log([m, s.server.memory.rssMB, s.server.memory.workerHeapMB, s.server.rounds, ((s.server.rounds - prev.server.rounds) / dt).toFixed(2), s.stats.stepsPerSec,
      s.stats.updates.join('/'), e ? e.a + ' / ' + e.b + ' @' + e.rounds : '-', (frames / dt).toFixed(1), pct(gaps, 0.5) + '/' + pct(gaps, 0.99), saves].join(' | '));
    prev = s; prevT = Date.now(); frames = 0; gaps.length = 0;
  }
  const s = await st();
  console.log('# Elo history (every ~25 rounds): ' + elos.filter((x, i) => i % Math.max(1, Math.floor(elos.length / 12)) === 0 || i === elos.length - 1).map((x) => x.rounds + ':' + x.a + '/' + x.b).join('  '));
  console.log('# anchors ' + (elos.length ? elos[elos.length - 1].anchors.join('/') : '-') + ' | persistence ' + JSON.stringify({ saves: s.server.persistence.saves, failures: s.server.persistence.failures, bytes: s.server.persistence.bytes, poolBytes: s.server.persistence.poolBytes }) + ' | frames sent ' + s.framesSent + ' dropped ' + s.framesDropped + ' | dropped trajectories ' + s.stats.droppedTrajectories);
  if (duty) clearInterval(duty);
  try { process.kill(srv.pid, 'SIGCONT'); } catch (e) { /* */ }
  const tk = Date.now(); srv.kill('SIGTERM'); const ex = await srv.exited;
  console.log('# SIGTERM -> exit ' + JSON.stringify(ex) + ' in ' + (Date.now() - tk) + ' ms; last fake-supabase call ' + JSON.stringify(fake.calls[fake.calls.length - 1]));
  v1.close(); v2.close(); await fake.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });

// Render-style cold start: phase 1 trains RUN_S (default 150) s unlimited with the fake Supabase (300 ms per call),
// SIGTERM; phase 2 restarts at CPU_LIMIT (default 0.1) and times listen -> hello(resuming) -> training, checks the
// resume, and times a SIGTERM save at that CPU. (Render's own ~1 min instance spin-up is not included.)
'use strict';
const U = require('./util'), F = require('./fake-supabase');
const RUN_S = Number(process.env.RUN_S || 150), LIMIT = Number(process.env.CPU_LIMIT || 0.1);
const SECRET = require('crypto').randomBytes(32).toString('base64url'), ANON = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"role":"anon"}').toString('base64url') + '.x';
(async () => {
  const fake = await F.startFake({ secretSha256: F.sha(SECRET), anonKey: ANON, delayMs: 300 });
  const port = 24000 + Math.floor(Math.random() * 900);
  const env = { PORT: String(port), SUPABASE_URL: fake.url, SUPABASE_ANON_KEY: ANON, SERVER_SECRET: SECRET, QUIET: '1', POOL_SAVE_EVERY_S: '3600', VIZ_MS: '5000' };
  let srv = U.spawnServer(env);
  await U.waitFor(async () => { try { return (await U.getJson(port, '/state')).body.server.state === 'training'; } catch (e) { return false; } }, 20000, 'training 1');
  await U.sleep(RUN_S * 1000);
  srv.kill('SIGTERM'); await srv.exited;
  const sizes = fake.rows.map((r) => r.kind + ' gen ' + r.generation + ' ' + r.bytes + ' B').join(', ');
  const savedRounds = Math.max.apply(null, fake.rows.map((r) => r.meta.rounds || 0));
  console.log('# phase 1: ' + RUN_S + ' s unlimited, stored: ' + sizes + ' | rounds ' + savedRounds);
  // phase 2: cold start at LIMIT
  const t0 = Date.now(); const marks = {};
  srv = U.spawnServer(env, { prefix: ['taskset', '-c', process.env.CPU || '4'] });
  const off = Math.round(100 * (1 - LIMIT));
  const duty = setInterval(() => { try { process.kill(srv.pid, 'SIGSTOP'); setTimeout(() => { try { process.kill(srv.pid, 'SIGCONT'); } catch (e) { /* */ } }, off); } catch (e) { /* */ } }, 100);
  await U.waitFor(async () => { try { await U.getJson(port, '/health'); marks.listen = Date.now() - t0; return true; } catch (e) { return false; } }, 60000, 'listen');
  const ws = U.connect(port, { onMsg: (m) => { if (m.type === 'hello' && !marks['hello:' + m.state]) marks['hello:' + m.state] = Date.now() - t0; if (m.type === 'ready' && !marks.ready) { marks.ready = Date.now() - t0; marks.restored = m.restored; marks.rounds = m.rounds; } if (m.type === 'frame' && !m.replay && !marks.frame) marks.frame = Date.now() - t0; } });
  await ws.opened;
  await U.waitFor(() => marks.frame && marks['hello:training'], 60000, 'training 2');
  console.log('# phase 2 cold start at ' + LIMIT + ' CPU (ms since process spawn): ' + JSON.stringify(marks));
  U.check(marks.restored === true && marks.rounds >= savedRounds - 1 && marks.frame < 15000, 'resumed from Supabase and streaming in < 15 s', marks.frame + ' ms');
  await U.sleep(20000);
  const tk = Date.now(); srv.kill('SIGTERM'); const ex = await srv.exited; clearInterval(duty);
  const last = fake.calls.filter((c) => c.fn === 'arena_save').slice(-2);
  U.check(ex.code === 0 && Date.now() - tk < 25000, 'SIGTERM save at ' + LIMIT + ' CPU finishes inside Render\'s 30 s window', (Date.now() - tk) + ' ms, last uploads ' + last.map((c) => c.bytes + ' B').join(' + '));
  ws.close(); await fake.close(); U.summary('coldstart'); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });

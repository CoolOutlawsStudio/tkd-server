// Persistence against the fake Supabase RPC: periodic saves, SIGTERM save, restart-resume (brains, rounds, Elo
// history, sessions), sha fallback to the older generation, wrong secret, service_role refusal, outage tolerance.
'use strict';
const U = require('./util'), F = require('./fake-supabase'), codec = require('../lib/codec');
const SECRET = 'S'.repeat(8) + require('crypto').randomBytes(24).toString('base64url');
const ANON = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url') + '.x';
(async () => {
  const fake = await F.startFake({ secretSha256: F.sha(SECRET), anonKey: ANON });
  const port = 19000 + Math.floor(Math.random() * 900);
  const env = { PORT: String(port), SUPABASE_URL: fake.url, SUPABASE_ANON_KEY: ANON, SERVER_SECRET: SECRET, SAVE_EVERY_S: '5', POOL_SAVE_EVERY_S: '15', QUIET: '0' };
  const up = () => U.waitFor(async () => { try { return (await U.getJson(port, '/health')).status === 200; } catch (e) { return false; } }, 15000, 'health');
  try {
    // ---- run 1: fresh, ~40 s
    let srv = U.spawnServer(env); await up();
    const ws = U.connect(port); await ws.opened;
    await U.waitFor(() => ws.msgs.some((m) => m.type === 'saved' && m.remote), 15000, 'first remote save');
    U.check(ws.msgs[0].state === 'waking' || ws.msgs[0].state === 'training', 'run 1 hello state', ws.msgs[0].state);
    const sv = ws.msgs.find((m) => m.type === 'saved');
    U.check(sv.persistence === 'supabase' && sv.generation >= 1 && sv.pool === true, 'saved{remote, generation, pool on first save}', 'state ' + sv.stateBytes + ' B, pool ' + sv.poolBytes + ' B');
    fake.opts.failNext = 1; // inject one outage: the next save fails, the one after retries
    await U.sleep(35000);
    const st1 = (await U.getJson(port, '/state')).body;
    U.check(st1.server.persistence.failures >= 1 && !st1.server.persistence.lastError, 'an injected outage is survived and retried', 'failures ' + st1.server.persistence.failures + ', saves ' + st1.server.persistence.saves);
    U.check(fake.rows.filter((r) => r.kind === 'state').length === 2, 'only 2 state generations kept', fake.rows.map((r) => r.kind + r.generation).join(','));
    const eloBefore = ws.msgs.filter((m) => m.type === 'elo');
    srv.kill('SIGTERM'); const t0 = Date.now();
    await U.waitFor(() => ws.msgs.some((m) => m.type === 'hello' && m.state === 'offline'), 15000, 'offline hello');
    const close = await ws.closed; const ex = await srv.exited;
    const lastSaved = ws.msgs.filter((m) => m.type === 'saved').pop();
    U.check(/shutdown/.test(lastSaved.why) && lastSaved.pool, 'SIGTERM saved state + pool before exit', 'gen ' + lastSaved.generation + ', rounds ' + lastSaved.rounds + ', ' + (Date.now() - t0) + ' ms to exit');
    U.check(ex.code === 0 && close.code === 1012, 'exit 0, viewers closed with 1012', JSON.stringify(ex) + ' ' + close.code);
    const pausedHello = ws.msgs.find((m) => m.type === 'hello' && m.state === 'paused');
    U.check(!!pausedHello, "'paused' (saving) then 'offline' pushed to viewers");
    const top = fake.rows.filter((r) => r.kind === 'state').sort((a, b) => b.generation - a.generation)[0];
    const dec = codec.decode(top.payload, top.sha256);
    const brainsSz = codec.encode({ brains: dec.records.brains }).bytes;
    console.log('    stored sizes: state', top.bytes, 'B (brains alone', brainsSz, 'B), pool', (fake.rows.find((r) => r.kind === 'pool') || {}).bytes, 'B; meta.coach.rounds', dec.records.meta.coach.rounds, 'sessions', dec.records.meta.sessions);
    // ---- run 2: restart resumes
    srv = U.spawnServer(env); await up();
    const ws2 = U.connect(port); await ws2.opened;
    await U.waitFor(() => ws2.msgs.some((m) => m.type === 'ready') && ws2.msgs.some((m) => m.type === 'stats'), 15000, 'ready 2');
    const rd = ws2.msgs.find((m) => m.type === 'ready'), hist = ws2.msgs.find((m) => m.type === 'history');
    U.check(rd.restored === true && rd.rounds >= lastSaved.rounds, 'restart: brains restored, round count continues', 'saved ' + lastSaved.rounds + ' -> ready.rounds ' + rd.rounds);
    U.check(rd.sessions === dec.records.meta.sessions + 1, 'sessions incremented on restart', rd.sessions);
    U.check(hist && hist.elo.length >= Math.min(eloBefore.length, 2) && hist.elo[0].rounds <= eloBefore[0].rounds, 'Elo history continues across restart', hist.elo.length + ' elo points replayed');
    const e2 = await U.waitFor(() => ws2.msgs.find((m) => m.type === 'elo' && !m.replay), 30000, 'elo 2');
    U.check(e2.rounds > eloBefore[eloBefore.length - 1].rounds, 'new Elo points after the old ones', eloBefore[eloBefore.length - 1].rounds + ' -> ' + e2.rounds);
    const rState = (await U.getJson(port, '/state')).body.server.persistence;
    U.check(rState.loadedGeneration === lastSaved.generation, '/state shows loaded generation', rState.loadedGeneration);
    srv.kill('SIGTERM'); await srv.exited; ws2.close();
    // ---- run 3: newest generation corrupted -> falls back to the older one
    const st = fake.rows.filter((r) => r.kind === 'state').sort((a, b) => b.generation - a.generation);
    st[0].payload = st[0].payload.slice(0, -8) + 'AAAAAAAA';
    srv = U.spawnServer(env); await up();
    const s3 = await U.waitFor(async () => { const b = (await U.getJson(port, '/state')).body; return b.restored ? b : null; }, 10000, 'restored');
    console.log('    restored:', s3.restored, 'loadedGen', s3.server.persistence.loadedGeneration, 'expected', st[1].generation);
    U.check(/rejected: sha256 mismatch/.test(s3.restored) && /fallback/.test(s3.restored) && s3.server.persistence.loadedGeneration === st[1].generation, 'corrupt newest gen -> previous gen restored', s3.restored);
    srv.kill('SIGTERM'); await srv.exited;
    // ---- run 4: wrong secret -> memory only, never overwrites stored brains
    const rowsBefore = JSON.stringify(fake.rows.map((r) => r.generation));
    srv = U.spawnServer(Object.assign({}, env, { SERVER_SECRET: 'x'.repeat(40) })); await up(); await U.sleep(7000);
    const s4 = (await U.waitFor(async () => { const b = (await U.getJson(port, '/state')).body; return b.restored ? b : null; }, 10000, 'restored')).server;
    U.check(s4.persistence.mode === 'memory' && /ARS401/.test(s4.persistence.note || ''), 'wrong secret -> memory-only, reported in /state', s4.persistence.note);
    srv.kill('SIGTERM'); await srv.exited;
    U.check(JSON.stringify(fake.rows.map((r) => r.generation)) === rowsBefore, 'stored brains untouched by the wrong-secret run');
    // ---- run 5: service_role key refused; missing vars -> memory
    const SR = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.x';
    srv = U.spawnServer(Object.assign({}, env, { SUPABASE_ANON_KEY: SR })); await up();
    const s5 = (await U.waitFor(async () => { const b = (await U.getJson(port, '/state')).body; return b.restored ? b : null; }, 10000, 'restored')).server;
    U.check(s5.persistence.mode === 'memory' && /service_role/.test(s5.persistence.note), 'service_role key refused', s5.persistence.note);
    srv.kill('SIGTERM'); await srv.exited;
  } catch (e) { U.check(false, 'exception: ' + e.stack); }
  await fake.close();
  U.summary('test-persist');
  process.exit();
})();

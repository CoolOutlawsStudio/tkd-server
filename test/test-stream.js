// Stream contract: hello first, then ready/status/history; frames ~10/s; round, elo, stats(+server); CORS; origin check;
// viewer messages refused; ping/pong; admin reset guarded; /health, /state.
'use strict';
const U = require('./util');
(async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const srv = U.spawnServer({ PORT: String(port), ADMIN_TOKEN: 'test-admin-token-0123456789', QUIET: '0' });
  try {
    await U.waitFor(async () => { try { return (await U.getJson(port, '/health')).status === 200; } catch (e) { return false; } }, 10000, 'health');
    const ws = U.connect(port);
    await ws.opened;
    await U.waitFor(() => ws.counts.frame >= 5 && ws.counts.elo >= 1, 20000, 'frames+elo');
    const first = ws.msgs[0];
    U.check(first.type === 'hello', 'first message is hello', first.type + ' state=' + first.state);
    U.check(['waking', 'resuming', 'training', 'paused'].indexOf(first.state) >= 0 && first.since && first.version && first.persistence && typeof first.viewers === 'number' && typeof first.rounds === 'number', 'hello has state/since/rounds/viewers/persistence/version');
    U.check(ws.msgs.some((m) => m.type === 'ready' && m.mode === 'server' && m.sim === 'arena-sim.js' && m.stub === false && m.obsDim > 0), 'ready (real sim, mode server)');
    U.check(ws.msgs.some((m) => m.type === 'history' && Array.isArray(m.elo) && m.rounds === undefined), 'history snapshot (WIRE=page: elo only, P1)');
    U.check(ws.msgs.every((m) => typeof m.epoch === 'number'), 'every message carries epoch');
    // frame rate over 10 s
    const f0 = ws.counts.frame, t0 = Date.now(); await U.sleep(10000);
    const fps = (ws.counts.frame - f0) / ((Date.now() - t0) / 1000);
    U.check(fps >= 8.5 && fps <= 15.5, 'frames ~10/s and <= 15/s', fps.toFixed(2) + '/s');
    const fr = ws.msgs.filter((m) => m.type === 'frame').slice(-5);
    U.check(fr.every((m) => m.state && m.state.fighters && m.state.fighters.length === 2 && Array.isArray(m.state.actions)), 'frame.state = sim.state() + actions');
    const ts = fr.map((m) => m.t);
    U.check(ts.every((t, i) => i === 0 || t > ts[i - 1] || t < 0.5), 'frame game time advances', ts.join(','));
    U.check(ws.counts.round > 0 && ws.counts.stats > 0, 'round and stats arrive', JSON.stringify(ws.counts));
    const st = ws.msgs.filter((m) => m.type === 'stats').pop();
    U.check(st.server && st.server.host && st.server.uptime >= 0 && st.server.viewers === 1 && st.server.persistence.mode === 'memory', 'stats.server field', 'viewers ' + st.server.viewers);
    U.check(ws.counts.viz > 0, 'viz broadcast ~1/s', ws.counts.viz);
    const vz = ws.msgs.filter((m) => m.type === 'viz').pop();
    U.check(vz.fighters.length === 2 && Array.isArray(vz.fighters[0].probs) && vz.fighters[0].probs.length > 0, 'viz probs are JSON arrays (WIRE=page: probs only)');
    // ping / not-accepted / reset guard
    ws.send(JSON.stringify({ type: 'ping', t: 123 }));
    ws.send(JSON.stringify({ type: 'pause' }));
    ws.send(JSON.stringify({ type: 'reset', token: 'wrong' }));
    await U.sleep(500);
    U.check(ws.msgs.some((m) => m.type === 'pong' && m.t === 123), 'ping -> pong');
    U.check(ws.msgs.some((m) => m.type === 'error' && m.code === 'not-accepted'), 'pause refused (shared match)');
    U.check(ws.msgs.some((m) => m.type === 'error' && m.code === 'forbidden'), 'reset without admin token refused');
    U.check(ws.msgs.filter((m) => m.type === 'status').every((m) => m.state !== 'paused'), 'viewer could not pause');
    // origin + path checks
    let blocked = null; const bad = U.connect(port, { origin: 'https://evil.example' }); try { await bad.opened; blocked = false; } catch (e) { blocked = e.message; }
    U.check(blocked && /403/.test(blocked), 'foreign Origin refused', blocked);
    let p404 = null; const bp = U.connect(port, { path: '/nope' }); try { await bp.opened; } catch (e) { p404 = e.message; }
    U.check(/404/.test(p404 || ''), 'other ws path 404');
    const nohello = U.connect(port, { hello: false }); await nohello.opened; await U.sleep(1500);
    U.check(nohello.msgs[0] && nohello.msgs[0].type === 'hello', 'client without hello still gets hello snapshot after 1 s'); nohello.close();
    // HTTP
    const h = await U.getJson(port, '/state', { Origin: 'https://tkd-net.netlify.app' });
    U.check(h.status === 200 && h.headers.get('access-control-allow-origin') === 'https://tkd-net.netlify.app', '/state CORS for netlify');
    const h2 = await U.getJson(port, '/state', { Origin: 'https://evil.example' });
    U.check(!h2.headers.get('access-control-allow-origin'), 'no CORS for other origins');
    U.check(h.body.server.rounds > 0 && h.body.elo && h.body.server.version.files['arena-sim.js'] === '6952e844', '/state content', 'rounds ' + h.body.server.rounds + ' elo A ' + h.body.elo.a + ' B ' + h.body.elo.b);
    const hl = await U.getJson(port, '/health');
    U.check(hl.status === 200 && hl.body.ok, '/health ok');
    console.log('    /state bytes', JSON.stringify(h.body).length, '| hello bytes', JSON.stringify(first).length, '| frame bytes', JSON.stringify(fr[0]).length);
    // admin reset
    const r0 = h.body.server.rounds;
    ws.send(JSON.stringify({ type: 'reset', token: 'test-admin-token-0123456789' }));
    await U.waitFor(() => ws.msgs.some((m) => m.type === 'hello' && m.reset), 5000, 'reset hello');
    await U.waitFor(() => ws.msgs.some((m) => m.type === 'ready' && m.epoch === 1 && m.rounds === 0), 5000, 'ready after reset');
    const after = ws.msgs.slice(ws.msgs.findIndex((m) => m.type === 'hello' && m.reset));
    U.check(after.every((m) => m.epoch === 1), 'all messages after reset carry epoch 1');
    await U.sleep(3000);
    const s2 = (await U.getJson(port, '/state')).body.server;
    U.check(s2.rounds < r0 || r0 < 15, 'admin reset restarted the brains', 'rounds ' + r0 + ' -> ' + s2.rounds);
    ws.close();
  } catch (e) { U.check(false, 'exception: ' + e.message); }
  srv.kill('SIGTERM'); const ex = await srv.exited;
  U.check(ex.code === 0, 'SIGTERM exits 0', JSON.stringify(ex));
  if (process.exitCode) console.log(srv.out.split('\n').slice(-30).join('\n'));
  U.summary('test-stream');
})();

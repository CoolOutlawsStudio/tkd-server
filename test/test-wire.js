// F1 (Render does not negotiate permessage-deflate): per-viewer bytes budget and the fields the page reads.
// Render-like env: WS_DEFLATE=0, VIZ_MS=5000; the client offers no compression either. One viewer, 20 s after warm-up.
// Budgets (KB/s per watching viewer, uncompressed, measured 2026-10-30 at 4.29 / 2.52, P6 strike frames included): FRAME_HZ 10 <= 4.8, FRAME_HZ 5 <= 2.9.
'use strict';
const U = require('./util'), WebSocket = require('ws');
const SECS = Number(process.env.WIRE_TEST_S || 20);
function viewer(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/arena', { headers: { Origin: U.ORIGIN }, perMessageDeflate: false });
  ws.rx = 0; ws.last = {}; ws.hb = null;
  ws.on('message', (d) => { ws.rx += d.length; const m = JSON.parse(String(d)); if (!m.replay) ws.last[m.type] = m; if (m.type === 'hello' && m.heartbeat) ws.hb = m; });
  ws.opened = new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, epochSeen: null })));
  return ws;
}
async function run(env) {
  const port = 25000 + Math.floor(Math.random() * 900);
  const srv = U.spawnServer(Object.assign({ PORT: String(port), QUIET: '1', WS_DEFLATE: '0', VIZ_MS: '5000', HEARTBEAT_S: '10' }, env));
  try {
    await U.waitFor(async () => { try { return (await U.getJson(port, '/state')).body.server.state === 'training'; } catch (e) { return false; } }, 30000, 'training');
    const ws = viewer(port); await ws.opened;
    await U.sleep(3000);
    const s0 = (await U.getJson(port, '/state')).body.net, r0 = ws.rx, t0 = Date.now();
    await U.sleep(SECS * 1000);
    const dt = (Date.now() - t0) / 1000, s1 = (await U.getJson(port, '/state')).body.net;
    const out = { wire: (s1.wsBytesOut - s0.wsBytesOut) / dt / 1024, rx: (ws.rx - r0) / dt / 1024, deflate: s1.deflate, mode: s1.wire, last: ws.last, hb: ws.hb };
    ws.close(); return out;
  } finally { srv.kill('SIGTERM'); await srv.exited; }
}
const num = (v) => typeof v === 'number' && isFinite(v);
(async () => {
  try {
    const [p10, p5, full] = await Promise.all([run({ WIRE: 'page', FRAME_HZ: '10' }), run({ WIRE: 'page', FRAME_HZ: '5' }), run({ WIRE: 'full', FRAME_HZ: '10' })]);
    const kb = (x) => x.toFixed(2) + ' KB/s = ' + (x * 1024 * 3600 / 1e6).toFixed(1) + ' MB/h';
    U.check(p10.deflate === false && p10.mode === 'page', 'Render-like: no permessage-deflate, WIRE=page');
    U.check(p10.wire <= 4.8 && p10.rx <= 4.8, 'budget FRAME_HZ 10: <= 4.8 KB/s per viewer', 'wire ' + kb(p10.wire) + ', client ' + kb(p10.rx));
    U.check(p5.wire <= 2.9 && p5.rx <= 2.9, 'budget FRAME_HZ 5: <= 2.9 KB/s per viewer (P6 active frames)', 'wire ' + kb(p5.wire) + ', client ' + kb(p5.rx));
    U.check(full.wire > p10.wire * 2, 'WIRE=full still sends the pre-F1 payloads', 'full ' + kb(full.wire));
    const f = p10.last.frame, st = f && f.state, F = st && st.fighters;
    U.check(f && num(f.seq) && num(f.epoch) && num(st.t) && num(st.step) && num(st.round) && num(st.timeLeft) && Array.isArray(st.score) && Array.isArray(st.wins) && Array.isArray(st.actions), 'frame.state keeps the fields the page reads (t, step, round, timeLeft, score, wins, actions)');
    U.check(F && F.length === 2 && F.every((g) => num(g.x) && num(g.z) && num(g.yaw) && num(g.health) && num(g.stamina) && typeof g.action === 'string'), 'frame fighters keep x, z, yaw, health, stamina, action');
    U.check(F && F.every((g) => g.y === undefined && g.actionId === undefined && g.blockCooldown === undefined), 'unused fighter fields are not sent (WIRE=page)');
    U.check(full.last.frame && full.last.frame.state.fighters[0].actionId !== undefined && full.last.frame.state.mat, 'WIRE=full frame = sim.state() verbatim');
    const v = p10.last.viz; U.check(v && v.fighters.length === 2 && v.fighters.every((x) => Array.isArray(x.probs) && x.probs.length > 0 && x.probs.every(num)) && !v.fighters[0].layers, 'viz = probs only');
    const l = p10.last.learn; U.check(l && num(l.fighter) && num(l.updates) && num(l.entropy) && num(l.approxKl) && num(l.clipFrac), 'learn keeps updates/entropy/approxKl/clipFrac');
    const s = p10.last.stats; U.check(s && num(s.roundsPerSec) && num(s.stepsPerSec) && num(s.trainSeconds) && num(s.practiceRounds) && Array.isArray(s.wins) && s.server && num(s.server.viewers) && num(s.server.watching), 'stats keeps the page fields + server viewers/watching');
    const r = p10.last.round; U.check(r && num(r.round) && typeof r.live === 'boolean' && Array.isArray(r.hits), 'round keeps round/live/winner/hits');
    U.check(p10.hb && p10.hb.server && p10.hb.server.bootId && num(p10.hb.watching) && p10.hb.persistence, 'heartbeat hello keeps bootId, counts, persistence');
    console.log('    per viewer, uncompressed: page@10Hz ' + kb(p10.wire) + ' | page@5Hz ' + kb(p5.wire) + ' | full@10Hz ' + kb(full.wire));
  } catch (e) { U.check(false, 'exception: ' + e.message); }
  U.summary('test-wire');
})();

// Training throughput with 0 vs 5 viewers (phases 0 / 5 / 0, PHASE_S each), and all 5 viewers get identical frames.
'use strict';
const U = require('./util'), crypto = require('crypto');
const PHASE_S = Number(process.env.PHASE_S || 60);
(async () => {
  const port = 20000 + Math.floor(Math.random() * 900);
  const srv = U.spawnServer({ PORT: String(port), QUIET: '1' }, process.env.CPUS ? { prefix: ['taskset', '-c', process.env.CPUS] } : {});
  const st = async () => (await U.getJson(port, '/state')).body;
  async function phase(label) {
    const samples = []; const a = await st(); const t0 = Date.now();
    while (Date.now() - t0 < PHASE_S * 1000) { await U.sleep(2000); const s = await st(); if (s.stats) samples.push(s.stats.stepsPerSec); }
    const b = await st(), dt = (Date.now() - t0) / 1000;
    const r = { label, roundsPerSec: (b.server.rounds - a.server.rounds) / dt, stepsPerSec: samples.reduce((x, y) => x + y, 0) / samples.length, updates: [b.stats.updates[0] - a.stats.updates[0], b.stats.updates[1] - a.stats.updates[1]] };
    console.log('    ' + label + ': rounds/s ' + r.roundsPerSec.toFixed(2) + ', sim steps/s ' + r.stepsPerSec.toFixed(0) + ', PPO updates A/B ' + r.updates.join('/'));
    return r;
  }
  try {
    await U.waitFor(async () => { try { const s = await st(); return s.server.state === 'training' && s.stats; } catch (e) { return false; } }, 20000, 'training');
    await U.sleep(10000); // warm-up
    const p0 = await phase('0 viewers');
    const views = []; for (let i = 0; i < 5; i++) { const ws = U.connect(port, { noKeep: true }); ws.frames = new Map(); ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'frame' && !m.replay) ws.frames.set(m.seq, crypto.createHash('sha1').update(JSON.stringify(m.state)).digest('hex')); }); views.push(ws); }
    await Promise.all(views.map((w) => w.opened));
    const p5 = await phase('5 viewers');
    views.forEach((w) => w.close());
    const p0b = await phase('0 viewers again');
    const seqs = views.map((w) => [...w.frames.keys()]), common = seqs[0].filter((s) => seqs.every((l) => l.includes(s)));
    const same = common.every((s) => views.every((w) => w.frames.get(s) === views[0].frames.get(s)));
    const fps = views.map((w) => (w.frames.size / PHASE_S).toFixed(1));
    U.check(common.length > PHASE_S * 8 && same, '5 viewers got identical frames', common.length + ' common frames, per viewer ' + views.map((w) => w.frames.size).join('/') + ' (' + fps.join('/') + ' /s)');
    const base = (p0.stepsPerSec + p0b.stepsPerSec) / 2, ratio = p5.stepsPerSec / base;
    U.check(ratio > 0.9, 'training speed with 5 viewers within 10% of 0 viewers', (100 * ratio).toFixed(1) + '% of baseline steps/s');
    const s = await st(); console.log('    frames sent', s.framesSent, 'dropped', s.framesDropped, '| rss', s.server.memory.rssMB, 'MB');
  } catch (e) { U.check(false, 'exception: ' + e.stack); }
  srv.kill('SIGTERM'); await srv.exited;
  U.summary('test-viewers');
  process.exit();
})();

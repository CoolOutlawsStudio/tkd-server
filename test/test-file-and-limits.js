// DATA_DIR file persistence (save, keep 2, restart-resume), MAX_VIEWERS, replay snapshot size, and the connect-snapshot
// budget with a FULL Elo history (seeded into the saved state between restarts): WIRE=page < 10 KB, WIRE=full unchanged.
'use strict';
const U = require('./util'), fs = require('fs'), os = require('os'), path = require('path'), codec = require('../lib/codec');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-data-'));
  const port = 22000 + Math.floor(Math.random() * 900);
  const env = { PORT: String(port), DATA_DIR: dir, SAVE_EVERY_S: '4', MAX_VIEWERS: '2', QUIET: '1' };
  const up = () => U.waitFor(async () => { try { const b = (await U.getJson(port, '/state')).body; return b.server.state === 'training' ? b : null; } catch (e) { return false; } }, 20000, 'training');
  let srv = U.spawnServer(env);
  try {
    await up(); await U.sleep(14000);
    let bytes = 0; const a = U.connect(port, { onMsg: (m) => { if (m.replay || m.type === 'hello') bytes += JSON.stringify(m).length; } });
    const b = U.connect(port); await Promise.all([a.opened, b.opened]); await U.sleep(1500);
    console.log('    replay snapshot on connect: ' + bytes + ' B (' + a.msgs.filter((m) => m.replay || m.type === 'hello').map((m) => m.type).join(',') + ')');
    U.check(bytes < 120000, 'replay snapshot bounded', bytes + ' B');
    const c = U.connect(port); await c.opened; const cl = await c.closed;
    U.check(c.msgs[0] && c.msgs[0].code === 'full' && cl.code === 1013, 'viewer over MAX_VIEWERS gets error full + 1013');
    const files = fs.readdirSync(dir).sort();
    U.check(files.filter((f) => /^arena-state-/.test(f)).length === 2 && files.some((f) => /^arena-pool-/.test(f)), 'file backend keeps 2 state gens + pool', files.join(','));
    srv.kill('SIGTERM'); await srv.exited; a.close(); b.close();
    const rounds = (JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).filter((f) => /state/.test(f)).sort((x, y) => Number(y.match(/\d+/)) - Number(x.match(/\d+/)))[0]))).meta.rounds);
    // seed a full Elo history (300 entries, the stored shape) into the newest state generation: the steady state after 15+ min
    const newest = path.join(dir, fs.readdirSync(dir).filter((f) => /^arena-state-/.test(f)).sort((x, y) => Number(y.match(/\d+/)) - Number(x.match(/\d+/)))[0]);
    const row = JSON.parse(fs.readFileSync(newest, 'utf8')), rec = codec.decode(row.payload, row.sha256);
    const seeded = []; for (let i = 0; i < 300; i++) seeded.push({ rounds: 1 + 25 * i, a: 1000 + Math.round(600 * Math.sin(i / 40)) + (i % 3) * 0.5, b: 1100 + 4 * i, vsScripted: [[0.625, 0.5, 0.25], [0.5, 0.375, 0.125]], vsPast: [0.708, 0.5], games: { scripted: [[12, 12, 12], [12, 12, 12]], past: [12, 12] }, trainSeconds: 5 * i, at: 1793429873719 + 5000 * i });
    rec.records.history = { rounds: (rec.records.history && rec.records.history.rounds) || [], elo: seeded };
    const enc = codec.encode(rec); Object.assign(row, { sha256: enc.sha256, bytes: enc.bytes, payload: enc.payload }); fs.writeFileSync(newest, JSON.stringify(row));
    const snapshot = async (p) => { let b = 0, h = null; const v = U.connect(p, { onMsg: (m) => { if (m.replay || m.type === 'hello') { const { _rx, ...raw } = m; b += JSON.stringify(raw).length; if (m.type === 'history' && !h) h = m; } } }); await v.opened; await U.sleep(1500); v.close(); return { bytes: b, h }; };
    srv = U.spawnServer(env); const s2 = await up();
    U.check(s2.server.rounds >= rounds && s2.server.persistence.mode === 'file', 'file backend restart resumes', 'saved rounds ' + rounds + ' -> ' + s2.server.rounds);
    const pg = await snapshot(port), E = pg.h && pg.h.elo, fin = (x) => typeof x === 'number' && isFinite(x);
    U.check(pg.bytes < 10240, 'WIRE=page connect snapshot < 10 KB with a full Elo history', pg.bytes + ' B, history ' + (pg.h ? JSON.stringify(pg.h).length : '?') + ' B, ' + (E ? E.length : '?') + ' points');
    U.check(E && E.length >= 40 && E.length <= 60 && E.every((e) => fin(e.rounds) && fin(e.a) && fin(e.b)) && E.every((e, i) => !i || e.rounds > E[i - 1].rounds), 'history.elo: 40-60 points, each with finite rounds/a/b, rounds ascending');
    const last = seeded[seeded.length - 1], first = seeded[seeded.length - 120];
    U.check(E && E[0].rounds === first.rounds && E[E.length - 1].rounds === last.rounds && E[E.length - 1].a === last.a && E[E.length - 1].b === last.b && E[E.length - 1].at === last.at, 'history.elo keeps the first and the exact last entry (same span as HISTORY_ELO 120)', E && E[0].rounds + '..' + E[E.length - 1].rounds);
    U.check(E && E.slice(0, -1).every((e) => Object.keys(e).join() === 'rounds,a,b') && pg.h.rounds === undefined, 'older points are {rounds, a, b} only; no history.rounds (WIRE=page)');
    srv.kill('SIGTERM'); await srv.exited;
    fs.writeFileSync(newest, JSON.stringify(row)); // SIGTERM saved a newer generation; put the seeded one back on top for WIRE=full
    fs.readdirSync(dir).filter((f) => /^arena-state-/.test(f) && path.join(dir, f) !== newest).forEach((f) => fs.unlinkSync(path.join(dir, f)));
    srv = U.spawnServer(Object.assign({}, env, { WIRE: 'full' })); await up();
    const fu = await snapshot(port), EF = fu.h && fu.h.elo;
    U.check(EF && EF.length === 120 && JSON.stringify(EF) === JSON.stringify(seeded.slice(-120)) && Array.isArray(fu.h.rounds), 'WIRE=full history = the stored entries verbatim (last 120 + rounds)', fu.bytes + ' B snapshot');
  } catch (e) { U.check(false, 'exception: ' + e.stack); }
  srv.kill('SIGTERM'); await srv.exited; fs.rmSync(dir, { recursive: true, force: true });
  U.summary('test-file-and-limits'); process.exit();
})();

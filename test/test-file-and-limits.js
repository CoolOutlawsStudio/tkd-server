// DATA_DIR file persistence (save, keep 2, restart-resume), MAX_VIEWERS, replay snapshot size.
'use strict';
const U = require('./util'), fs = require('fs'), os = require('os'), path = require('path');
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
    srv = U.spawnServer(env); const s2 = await up();
    U.check(s2.server.rounds >= rounds && s2.server.persistence.mode === 'file', 'file backend restart resumes', 'saved rounds ' + rounds + ' -> ' + s2.server.rounds);
  } catch (e) { U.check(false, 'exception: ' + e.stack); }
  srv.kill('SIGTERM'); await srv.exited; fs.rmSync(dir, { recursive: true, force: true });
  U.summary('test-file-and-limits'); process.exit();
})();

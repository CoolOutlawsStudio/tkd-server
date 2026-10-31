// watch on/off (hidden tabs): {type:'watch', on:false} stops frame/viz/learn/round/stats to that socket within 1 s while
// hello/elo/saved keep coming; viewers vs watching counts in hello, server field and /state; bandwidth of a watch-off
// viewer < 0.3 KB/s on the wire; {type:'watch', on:true} replays status + stats + the last frame and resumes.
// Also: saved{ok:true}, the Render origin is in the default ALLOWED_ORIGINS, bad watch args -> error{code:'invalid'}.
'use strict';
const U = require('./util'), fs = require('fs'), os = require('os'), path = require('path');
const HI = ['frame', 'viz', 'learn', 'round', 'stats'];
const OFF_S = Number(process.env.OFF_S || 30);
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-watch-'));
  const port = 24000 + Math.floor(Math.random() * 900);
  const srv = U.spawnServer({ PORT: String(port), DATA_DIR: dir, SAVE_EVERY_S: '5', QUIET: '1' }); // default VIZ_MS/FRAME_HZ/HEARTBEAT
  const st = async () => (await U.getJson(port, '/state')).body;
  try {
    await U.waitFor(async () => { try { return (await st()).server.state === 'training'; } catch (e) { return false; } }, 20000, 'training');
    const a = U.connect(port);
    const b = U.connect(port, { origin: 'https://tkd-net.onrender.com' });
    let rb = null; try { await Promise.all([a.opened, b.opened]); rb = true; } catch (e) { rb = e.message; }
    U.check(rb === true, 'Render origin https://tkd-net.onrender.com accepted by default', rb);
    await U.waitFor(() => a.counts.frame >= 5 && b.counts.frame >= 5 && b.counts.viz >= 1, 15000, 'frames to both');
    const h0 = b.msgs.find((m) => m.type === 'hello');
    U.check(typeof h0.watching === 'number' && typeof h0.server.watching === 'number', 'hello has watching (top level and server)', 'viewers ' + h0.viewers + ' watching ' + h0.watching);
    const s0 = await st();
    U.check(s0.server.viewers === 2 && s0.server.watching === 2, '/state: 2 viewers, 2 watching', s0.server.viewers + '/' + s0.server.watching);
    // bad args
    b.send(JSON.stringify({ type: 'watch', on: 'no' })); await U.sleep(300);
    U.check(b.msgs.some((m) => m.type === 'error' && m.code === 'invalid'), "watch without boolean on -> error{code:'invalid'}");
    // ---- watch off
    const tOff = Date.now(); b.send(JSON.stringify({ type: 'watch', on: false }));
    const ack = await U.waitFor(() => b.msgs.find((m) => m.type === 'hello' && m.reply && m.watch === false && m._rx >= tOff), 2000, 'watch:false ack');
    U.check(ack.viewers === 2 && ack.watching === 1 && ack.server.watching === 1, 'ack hello{reply, watch:false}: viewers 2, watching 1', ack.viewers + '/' + ack.watching);
    const s1 = await st();
    U.check(s1.server.viewers === 2 && s1.server.watching === 1, '/state after off: 2 viewers, 1 watching', s1.server.viewers + '/' + s1.server.watching);
    await U.sleep(1000);
    const t1 = Date.now(), aF = a.counts.frame, bytes0 = b._socket.bytesRead, nMsgs = b.msgs.length;
    await U.sleep(OFF_S * 1000);
    const dt = (Date.now() - t1) / 1000, bw = (b._socket.bytesRead - bytes0) / dt;
    const lateHi = b.msgs.filter((m) => m._rx > tOff + 1000 && HI.indexOf(m.type) >= 0);
    U.check(lateHi.length === 0, 'watch off: no frame/viz/learn/round/stats after 1 s', lateHi.length ? lateHi.map((m) => m.type).join(',') : 'none');
    const offTypes = {}; b.msgs.slice(nMsgs).forEach((m) => { offTypes[m.type] = (offTypes[m.type] || 0) + 1; });
    U.check(offTypes.hello >= 1 && offTypes.elo >= 1, 'watch off still gets hello heartbeat and elo', JSON.stringify(offTypes));
    U.check(bw < 0.3 * 1024, 'watch-off bandwidth < 0.3 KB/s on the wire', (bw / 1024).toFixed(3) + ' KB/s over ' + dt.toFixed(0) + ' s');
    const afps = (a.counts.frame - aF) / dt;
    U.check(afps >= 8.5, 'the other viewer keeps ~10 frames/s', afps.toFixed(2) + '/s');
    U.check(b.msgs.some((m) => m.type === 'saved' && m._rx > tOff) && a.msgs.filter((m) => m.type === 'saved').every((m) => m.ok === true), 'saved reaches watch-off viewer; every saved has ok:true', a.msgs.filter((m) => m.type === 'saved').length + ' saved');
    // ---- watch on
    const tOn = Date.now(); b.send(JSON.stringify({ type: 'watch', on: true }));
    const ack2 = await U.waitFor(() => b.msgs.find((m) => m.type === 'hello' && m.reply && m.watch === true && m._rx >= tOn), 2000, 'watch:true ack');
    U.check(ack2.viewers === 2 && ack2.watching === 2, 'ack hello{reply, watch:true}: viewers 2, watching 2', ack2.viewers + '/' + ack2.watching);
    const rf = await U.waitFor(() => b.msgs.find((m) => m.type === 'frame' && m.replay && m._rx >= tOn), 1000, 'replayed frame');
    U.check(rf.state && rf.state.fighters && rf.state.fighters.length === 2, 'watch on: last frame replayed within 1 s', (rf._rx - tOn) + ' ms');
    U.check(b.msgs.some((m) => m.type === 'status' && m.replay && m._rx >= tOn), 'watch on: status replayed');
    await U.waitFor(() => b.msgs.filter((m) => m.type === 'frame' && !m.replay && m._rx >= tOn).length >= 5, 2000, 'live frames resume');
    U.check(true, 'watch on: live frames resume');
    const s2 = await st();
    U.check(s2.server.viewers === 2 && s2.server.watching === 2, '/state after on: 2 viewers, 2 watching', s2.server.viewers + '/' + s2.server.watching);
    // a socket that says watch:false before hello gets a snapshot without frame/stats
    const c = U.connect(port, { hello: false });
    await c.opened; c.send(JSON.stringify({ type: 'watch', on: false })); c.send(JSON.stringify({ type: 'hello', protocol: 1 }));
    await U.sleep(1500);
    U.check(c.msgs[0] && c.msgs[0].type === 'hello' && !c.msgs.some((m) => HI.indexOf(m.type) >= 0), 'watch:false before hello: snapshot without frame/stats', c.msgs.map((m) => m.type).join(','));
    const s3 = await st();
    U.check(s3.server.viewers === 3 && s3.server.watching === 2, '/state: 3 viewers, 2 watching', s3.server.viewers + '/' + s3.server.watching);
    c.close(); a.close(); b.close();
    await U.sleep(300);
    const s4 = await st();
    U.check(s4.server.viewers === 0 && s4.server.watching === 0, '/state after close: 0/0', s4.server.viewers + '/' + s4.server.watching);
  } catch (e) { U.check(false, 'exception: ' + e.stack); }
  srv.kill('SIGTERM'); const ex = await srv.exited;
  U.check(ex.code === 0, 'SIGTERM exits 0', JSON.stringify(ex));
  fs.rmSync(dir, { recursive: true, force: true });
  if (process.exitCode) console.log(srv.out.split('\n').slice(-30).join('\n'));
  U.summary('test-watch'); process.exit();
})();

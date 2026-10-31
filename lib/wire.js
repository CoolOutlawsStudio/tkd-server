// Wire slimming for viewers (Waffle F1: Render's proxy does not negotiate permessage-deflate, so every byte of JSON
// goes out as is). WIRE=page (default) sends only the fields the page (arena-view.js) reads, with the same field
// names and nesting, rounded to what the page can show. WIRE=full = the pre-F1 payloads (sim.state() verbatim).
// Server-only (Node). The trainer, the worker, the store and persistence never see this: it is applied at send time.
'use strict';
const r = (v, d) => { if (typeof v !== 'number' || !isFinite(v)) return v; const k = Math.pow(10, d); const x = Math.round(v * k) / k; return x === 0 ? 0 : x; };
// significant digits (learn/viz floats with very different scales)
const sig = (v, n) => { if (typeof v !== 'number' || !isFinite(v) || v === 0) return v; return Number(v.toPrecision(n)); };

// Page defaults (arena-view.js): mat {size 8, bodyRadius 0.3}, pose 'ready-stance', motion/phase 'idle'/'none',
// phaseProgress 0, guarding/blocking false, events [], done false. A field equal to the page default is omitted;
// the page then uses exactly the same value.
function slimFighter(f) {
  if (!f || typeof f !== 'object') return f;
  const o = { x: r(f.x, 2), z: r(f.z, 2), yaw: r(f.yaw, 2), action: f.action, health: r(f.health, 1), stamina: r(f.stamina, 2) };
  if (f.pose && f.pose !== 'ready-stance') o.pose = f.pose;
  if (f.motion && f.motion !== 'idle') o.motion = f.motion;
  if (f.phase && f.phase !== 'none') { o.phase = f.phase; o.phaseProgress = r(f.phaseProgress, 2); }
  if (f.guarding) o.guarding = true;
  if (f.blocking) o.blocking = true;
  return o;
}
function slimState(s, events) {
  if (!s || typeof s !== 'object') return s;
  const o = { t: s.t, step: s.step, round: s.round, timeLeft: r(s.timeLeft, 1) };
  if (!s.mat || s.mat.size !== 8 || s.mat.bodyRadius !== 0.3) o.mat = s.mat;
  o.fighters = (s.fighters || []).map(slimFighter);
  o.score = s.score; o.wins = s.wins;
  if (s.done) { o.done = true; o.endReason = s.endReason; }
  const ev = events || s.events;
  if (ev && ev.length) o.events = ev.filter((e) => e && typeof e === 'object').map((e) => ({ type: e.type, by: e.by }));
  o.actions = s.actions;
  return o;
}
// viz: the page reads fighters[i].probs only (policy panel). Layers/activations are left out. 4 decimals: with 3 the
// page's whole-percent text differed from WIRE=full by 1 point in about 1 of 3 viz messages (Waffle wire-qa).
function slimViz(m) {
  return { type: 'viz', id: m.id, fighters: (m.fighters || []).map((f) => ({ probs: Array.from((f && f.probs) || [], (p) => r(p, 4)) })) };
}
// learn: the page shows updates, entropy, approxKl, clipFrac per fighter (floats to 4 significant digits)
function slimLearn(m) { return { type: 'learn', fighter: m.fighter, updates: m.updates, entropy: sig(m.entropy, 4), approxKl: sig(m.approxKl, 4), clipFrac: sig(m.clipFrac, 4) }; }
// round: the page reads round, live, winner, hits (banner on live rounds). Practice rounds are throttled by the caller.
function slimRound(m) { return { type: 'round', round: m.round, live: m.live, winner: m.winner, hits: m.hits, kind: m.kind }; }
// stats.server: the page reads viewers/watching (counts()). Full server info stays in hello and /state.
function slimServer(i) { i = i || {}; return { host: i.host, bootId: i.bootId, uptime: i.uptime, state: i.state, viewers: i.viewers, watching: i.watching, persistence: { mode: i.persistence && i.persistence.mode } }; }
// stats: the page shows trainSeconds, roundsPerSec, stepsPerSec, practiceRounds, wins (the rest stays in /state)
const STATS_KEYS = ['roundsPerSec', 'stepsPerSec', 'practiceRounds', 'liveRounds', 'rounds', 'wins', 'trainSeconds', 'updates', 'practice', 'speed'];
function slimStats(m) { const o = { type: 'stats' }; for (const k of STATS_KEYS) if (m[k] !== undefined) o[k] = typeof m[k] === 'number' && !Number.isInteger(m[k]) && k !== 'trainSeconds' ? sig(m[k], 5) : k === 'trainSeconds' && typeof m[k] === 'number' ? r(m[k], 0) : m[k]; return o; }
// history.elo (connect snapshot): the page reads rounds, a, b per entry (x axis = rounds; `at` falls back to the receive
// time) and needs the FIRST and LAST entries ("change since start"). WIRE=page sends at most ELO_POINTS entries: the last
// ELO_RECENT at full resolution, the older ones thinned evenly with the first always kept, each as {rounds, a, b} with
// a/b rounded to 0.1. The last entry is sent exactly as stored (page fields only, with `at`), so it still equals the
// replayed live `elo` message and the page does not add a duplicate point. 120 entries: ~22 KB -> ~2.5 KB.
const ELO_POINTS = 60, ELO_RECENT = 20;
function slimEloHistory(es) {
  const E = (es || []).filter((e) => e && typeof e === 'object' && Number.isFinite(e.rounds) && Number.isFinite(e.a) && Number.isFinite(e.b));
  if (!E.length) return [];
  let idx = E.map((e, i) => i);
  if (E.length > ELO_POINTS) {
    const nOld = E.length - ELO_RECENT, keep = ELO_POINTS - ELO_RECENT, old = [];
    for (let k = 0; k < keep; k++) { const i = Math.round(k * (nOld - 1) / (keep - 1)); if (!old.length || old[old.length - 1] !== i) old.push(i); }
    idx = old.concat(idx.slice(nOld));
  }
  const last = E.length - 1;
  return idx.map((i) => { const e = E[i]; return i === last ? (e.at != null ? { rounds: e.rounds, a: e.a, b: e.b, at: e.at } : { rounds: e.rounds, a: e.a, b: e.b }) : { rounds: e.rounds, a: r(e.a, 1), b: r(e.b, 1) }; });
}
module.exports = { slimState, slimFighter, slimViz, slimLearn, slimRound, slimServer, slimStats, slimEloHistory, ELO_POINTS };

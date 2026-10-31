/* TKD-Net arena-worker.js (owner: Moneyman) -- the Arena worker, protocol of ARENA-CONTRACT.md section 3.
 * Classic Web Worker: new Worker('arena/arena-worker.js'). All paths are relative to this file (arena/).
 *
 * Sim loading: tries importScripts('../arena-sim.js') (site root, where Waffle's real sim lives) FIRST, so a normal
 * open makes no failing request; only if that fails, importScripts('arena-sim.js') (same folder, dev). If neither loads
 * or defines TKD.Arena.createSim, it falls back to
 * importScripts('arena-sim-stub.js') (dev stub). `ready.sim` is 'arena-sim.js' or 'arena-sim-stub.js', `ready.simPath`
 * the path that loaded, and `ready.stub` is true for the stub.
 * Then loads arena-rl.js (learner + league) and arena-store.js (IndexedDB, fail-soft).
 *
 * Scheduling: one loop of ~8 ms slices then setTimeout. Each slice: (1) the live match steps that are due
 * (speed 1 or 2 = real time x speed, 'fast' = as many as half the slice allows, frames throttled to ~30/s; a new fast
 * live round only starts when Coach.canStartLive() allows it: PPO has caught up for BOTH fighters, the scheduled Elo
 * benchmark is not overdue, and live self-play keeps to its league share), (2) leftover time: pending PPO updates
 * (fighter with fewer updates first), interleaved with the pending Elo benchmark, then practice rounds.
 * Saving: every ~5 s of running time (pool only when it changed), on pause and on flush. A save starts its IndexedDB
 * transaction at once (no read first) and commits it explicitly, so the flush sent on pagehide lands before the worker dies.
 * When there is nothing left to do (practice off) it sleeps until the next live step is due.
 *   in : start, speed, pause, resume, practice, reset, flush, viz, export
 *   out: ready, status, frame, round, learn, elo, stats, saved, viz, weights, error  (every message carries `epoch`)
 */
/* global self, importScripts */
(function () {
  'use strict';
  function errMsg(e) { return (e && e.message) ? e.message : String(e); }
  var load = { sim: null, simError: null, rl: null, store: null };
  self.TKD = self.TKD || {};
  // Real sim first from the site root (../arena-sim.js, where Waffle ships it: no 404 on a normal open), then the
  // same folder (arena/arena-sim.js, dev only).
  var SIM_PATHS = ['../arena-sim.js', 'arena-sim.js'], simErrs = [];
  for (var sp = 0; sp < SIM_PATHS.length && !load.sim; sp++) {
    try {
      importScripts(SIM_PATHS[sp]);
      if (self.TKD.Arena && typeof self.TKD.Arena.createSim === 'function') { load.sim = 'arena-sim.js'; load.simPath = SIM_PATHS[sp]; }
      else simErrs.push(SIM_PATHS[sp] + ' loaded but TKD.Arena.createSim is missing');
    } catch (e) { simErrs.push(SIM_PATHS[sp] + ' not loaded (' + errMsg(e) + ')'); }
  }
  if (!load.sim) load.simError = 'arena-sim.js not loaded: ' + simErrs.join('; ');
  if (!load.sim) {
    try { importScripts('arena-sim-stub.js'); if (typeof self.TKD.Arena.createSim === 'function') { load.sim = 'arena-sim-stub.js'; load.simPath = 'arena-sim-stub.js'; } }
    catch (e) { load.simError += '; arena-sim-stub.js failed: ' + errMsg(e); }
  }
  try { importScripts('arena-rl.js'); } catch (e) { load.rl = 'arena-rl.js failed to load: ' + errMsg(e); }
  try { importScripts('arena-store.js'); } catch (e) { load.store = 'arena-store.js failed to load: ' + errMsg(e); }
  var TKD = self.TKD, Arena = TKD.Arena = TKD.Arena || {};
  if (!Arena.store) {
    var nul = function () { return Promise.resolve(null); };
    Arena.store = { available: false, open: nul, saveAll: nul, loadAll: nul, loadHistory: nul, loadMeta: nul, incrementSessions: nul, clear: nul };
  }
  var store = Arena.store;
  var now = (self.performance && typeof self.performance.now === 'function') ? function () { return self.performance.now(); } : function () { return Date.now(); };

  var SAVE_EVERY_MS = 5000, STATS_EVERY_MS = 2000, FAST_FRAME_MS = 33, MAX_CATCHUP = 3;
  var S = {
    phase: 'idle', running: false, wantPause: false, pendingReset: false, epoch: 0, seed: 1,
    speed: 1, practice: true, coach: null, sessions: 1, restored: false,
    timer: null, gen: 0, sliceMs: 8, liveT0: 0, liveDone: 0, lastFrame: 0, lastTick: 0,
    runMsSinceSave: 0, lastStats: 0, statBase: null, saveChain: Promise.resolve(), vizPrev: {}, lastSaved: null,
    clearing: null, savesInFlight: 0, savedPoolVer: -1, firstSeen: null
  };

  function post(msg) { msg.epoch = S.epoch; try { self.postMessage(msg); } catch (e) {} }
  function stateName() { return S.phase === 'error' ? 'error' : (S.phase === 'loading' || S.phase === 'idle' ? 'loading' : (S.running ? 'running' : 'paused')); }
  function status(message) { var m = { type: 'status', state: stateName(), practice: S.practice, speed: S.speed }; if (message) m.message = message; post(m); }
  function fatal(message) { S.running = false; S.phase = 'error'; S.gen++; post({ type: 'error', message: message }); status(message); }
  function normSpeed(v) { return v === 'fast' ? 'fast' : (Number(v) === 2 ? 2 : 1); }

  function checkSim() {
    var A = Arena;
    if (!(A.OBS_DIM > 0)) return 'OBS_DIM missing';
    if (!A.ACTIONS || !A.ACTIONS.length) return 'ACTIONS missing';
    if (A.NUM_ACTIONS !== A.ACTIONS.length) return 'NUM_ACTIONS != ACTIONS.length';
    if (typeof A.scripted !== 'function') return 'TKD.Arena.scripted(level) missing (needed for the Elo benchmark)';
    var sim = A.createSim({ seed: 1, roundSeconds: 60 }), r = sim.reset(1);
    if (!r || !r.obs || r.obs.length !== 2 || r.obs[0].length !== A.OBS_DIM || r.obs[1].length !== A.OBS_DIM) return 'reset() must return { obs:[A,B] } of length OBS_DIM';
    var s = sim.step(0, 0);
    if (!s || !s.obs || s.obs[0].length !== A.OBS_DIM || !s.reward || s.reward.length !== 2 || typeof s.done !== 'boolean' || !s.info) return 'step() must return { obs, reward:[a,b], done, info }';
    for (var i = 0; i < 2; i++) for (var k = 0; k < A.OBS_DIM; k++) if (!isFinite(s.obs[i][k])) return 'observation contains a non-finite value at ' + k;
    if (typeof sim.state !== 'function') return 'state() missing';
    if (typeof sim.actionMask === 'function') { var m = sim.actionMask(0); if (!m || m.length !== A.NUM_ACTIONS) return 'actionMask(i) must have NUM_ACTIONS entries'; }
    return null;
  }

  function newCoach(seed) {
    return new Arena.Coach({ seed: seed, on: {
      round: function (m) { m.type = 'round'; post(m); },
      learn: function (m) { m.type = 'learn'; post(m); },
      elo: function (m) { m.type = 'elo'; post(m); },
      nan: function (m) { status('PPO update for fighter ' + m.fighter + ' gave NaN: restored its last good weights, reset the optimiser' + (m.lowered ? ', learning rate lowered to ' + m.lr.toPrecision(2) : '')); },
      fatal: function (m) { fatal(m.message); }
    } });
  }

  function readyMsg() {
    var c = S.coach;
    return { type: 'ready', restored: S.restored, rounds: c.rounds, sessions: S.sessions, obsDim: Arena.OBS_DIM, numActions: Arena.NUM_ACTIONS,
      actions: Arena.ACTIONS.slice(), params: c.paramCounts(), layers: c.layers(), sim: load.sim, simPath: load.simPath || null, simName: Arena.SIM_NAME || null, stub: load.sim === 'arena-sim-stub.js',
      decisionHz: Arena.DECISION_HZ || 10, storage: store.available, discarded: S.discarded || null };
  }

  // ---------- start
  function start(o) {
    if (S.phase !== 'idle') { status(); return; }
    o = o || {};
    S.seed = (o.seed == null || !isFinite(Number(o.seed))) ? 1 : (Number(o.seed) >>> 0);
    if (o.speed !== undefined) S.speed = normSpeed(o.speed);
    if (o.practice !== undefined) S.practice = o.practice !== false;
    S.phase = 'loading'; status();
    if (!load.sim) { fatal('no arena sim: ' + load.simError); return; }
    if (load.rl) { fatal(load.rl); return; }
    var problem;
    try { problem = checkSim(); } catch (e) { problem = 'sim threw: ' + errMsg(e); }
    if (problem) { fatal(load.sim + ' breaks ARENA-CONTRACT.md section 1: ' + problem); return; }
    store.open().then(function () { return store.incrementSessions(); }).then(function (meta) {
      S.sessions = (meta && meta.sessions) || 1;
      S.firstSeen = (meta && meta.firstSeen) || null;
      return o.fresh ? null : store.loadAll(Arena.Coach.brainsProblem);
    }).then(function (rec) {
      S.coach = newCoach(S.seed);
      S.restored = false; S.discarded = rec && rec.discarded;
      if (rec && rec.brains) {
        try { S.coach.restore(rec.brains, rec.pool, rec.meta && rec.meta.coach, rec.history); S.restored = true; }
        catch (e) { S.coach = newCoach(S.seed); S.discarded = errMsg(e); }
      }
      S.savedPoolVer = (S.restored && rec.pool) ? S.coach.poolVer : -1; // the stored pool already matches
      S.coach.rng = Arena.rlMakeRng(Arena.mixSeed(S.seed, 1000 + S.sessions)); // new practice draws each page open
      S.coach.practiceOn = S.practice;
      S.phase = 'ready';
      post(readyMsg());
      if (S.pendingReset) { S.pendingReset = false; doReset(); return; }
      if (S.wantPause) { S.running = false; status(); return; }
      begin();
    }).catch(function (e) { fatal('startup failed: ' + errMsg(e)); });
  }

  function begin() {
    S.running = true; S.gen++;
    var t = now();
    S.liveT0 = t; S.liveDone = 0; S.lastTick = t; S.lastStats = t;
    S.statBase = statBase();
    status(store.available ? undefined : 'IndexedDB unavailable: the fighters learn but nothing is saved');
    schedule(0);
  }
  function statBase() { var c = S.coach; return { t: now(), rounds: c.rounds, live: c.steps.live, practice: c.steps.practice, bench: c.steps.bench, samples: c.trainSamples }; }

  function schedule(delay) {
    if (S.timer !== null) { clearTimeout(S.timer); S.timer = null; }
    var g = S.gen;
    S.timer = setTimeout(function () { S.timer = null; if (g === S.gen) slice(); }, delay || 0);
  }

  function sendFrame() {
    var st = S.coach.liveState();
    if (st) post({ type: 'frame', round: S.coach.liveSeq, t: st.t, state: st });
    S.lastFrame = now();
  }

  function slice() {
    if (!S.running) return;
    var t0 = now(), c = S.coach, idle = false, nextDelay = 0;
    try {
      c.trainSeconds += Math.max(0, Math.min(1000, t0 - S.lastTick)) / 1000;
      S.runMsSinceSave += Math.max(0, Math.min(1000, t0 - S.lastTick));
      S.lastTick = t0;
      var hz = Arena.DECISION_HZ || 10;
      if (S.speed === 'fast') {
        while (now() - t0 < S.sliceMs / 2 && S.running && !c.fatal) {
          if (c.liveStep(true) === false) break; // back-pressure: PPO / Elo first, then the next live round
          if (now() - S.lastFrame >= FAST_FRAME_MS) sendFrame();
        }
        if (now() - S.lastFrame >= FAST_FRAME_MS) sendFrame(); // keep ~30 frames/s while a new round waits for PPO/Elo
      } else {
        var target = Math.floor((t0 - S.liveT0) * S.speed * hz / 1000), due = target - S.liveDone;
        if (due > MAX_CATCHUP) { S.liveDone = target - MAX_CATCHUP; due = MAX_CATCHUP; } // the tab was frozen: no catch-up spiral
        for (var k = 0; k < due && S.running && !c.fatal; k++) { c.liveStep(); S.liveDone++; sendFrame(); }
      }
      // 'fast': the visible match goes before practice; practice fills in only while a new live round is held back
      // (league share of self-play, or PPO/Elo catching up), so live rounds keep about their 50% share.
      var practiceOk = S.practice;
      c.liveIsSelf = S.speed === 'fast';
      if (S.speed === 'fast' && practiceOk) practiceOk = !((c.live && !c.live.done) || c.canStartLive());
      while (S.running && !c.fatal && now() - t0 < S.sliceMs) {
        if (c.workUnit(practiceOk) === 'idle') { idle = true; break; }
      }
      if (!S.running) return;
      if (c.fatal) return;
      var t1 = now();
      if (t1 - S.lastStats >= STATS_EVERY_MS) sendStats(t1);
      if (S.runMsSinceSave >= SAVE_EVERY_MS) save();
      if (idle && S.speed !== 'fast') {
        var nextAt = S.liveT0 + (S.liveDone + 1) * 1000 / (hz * S.speed);
        nextDelay = Math.max(0, Math.min(250, nextAt - t1));
      }
    } catch (e) { fatal('arena failed: ' + errMsg(e)); return; }
    schedule(nextDelay);
  }

  function sendStats(t1) {
    var c = S.coach, b = S.statBase, dt = (t1 - b.t) / 1000;
    if (dt <= 0) return;
    var live = c.steps.live - b.live, pr = c.steps.practice - b.practice, be = c.steps.bench - b.bench;
    post({ type: 'stats', roundsPerSec: round2((c.rounds - b.rounds) / dt), stepsPerSec: Math.round((live + pr) / dt),
      liveStepsPerSec: Math.round(live / dt), practiceStepsPerSec: Math.round(pr / dt), benchStepsPerSec: Math.round(be / dt),
      samplesPerSec: Math.round((c.trainSamples - b.samples) / dt), practiceRounds: c.practiceRounds, liveRounds: c.liveRounds,
      rounds: c.rounds, wins: c.wins.slice(), queue: c.queueLength() + (c.job ? 1 : 0), droppedTrajectories: c.dropped || 0, trainSeconds: Math.round(c.trainSeconds), practice: S.practice, speed: S.speed,
      updates: c.learnRounds.slice(), droppedBy: c.droppedBy.slice(), queues: [c.queues[0].length, c.queues[1].length],
      lastEloRound: c.history.elo.length ? c.history.elo[c.history.elo.length - 1].rounds : null, benchPending: !!c.bench });
    S.lastStats = t1; S.statBase = statBase();
  }
  function round2(x) { return Math.round(x * 100) / 100; }

  // Saves brains + history + meta, and the pool only when it changed since the last good save (cheap, ~100 KB).
  // The IndexedDB write transaction is created right away (no read first), so a flush sent on pagehide reaches
  // IndexedDB before the worker is stopped. `force` (flush/pause) saves even when another save is still in flight.
  function save(force) {
    S.runMsSinceSave = 0;
    if (!S.coach || !store.available) return Promise.resolve(null);
    if (!force && S.savesInFlight > 0) return Promise.resolve(null);
    var c = S.coach, poolVer = c.poolVer, withPool = poolVer !== S.savedPoolVer;
    var rec = { brains: c.exportBrains(), pool: withPool ? c.exportPool() : null, history: { rounds: c.history.rounds.slice(), elo: c.history.elo.slice() },
      meta: { sessions: S.sessions, lastSeen: Date.now(), coach: c.exportMeta() } };
    if (S.firstSeen) rec.meta.firstSeen = S.firstSeen;
    var rounds = c.rounds, ep = S.epoch;
    function write() {
      if (ep !== S.epoch) return null; // a reset happened meanwhile: do not resurrect old brains
      return store.saveAll(rec);
    }
    S.savesInFlight++;
    var p = (S.clearing ? S.clearing.then(write) : write());
    p = Promise.resolve(p).then(function (res) {
      S.savesInFlight--;
      if (res && ep === S.epoch) {
        if (withPool && poolVer > S.savedPoolVer) S.savedPoolVer = poolVer;
        S.lastSaved = res; post({ type: 'saved', rounds: rounds, bytes: res.bytes, at: res.at, pool: withPool, trainSeconds: Math.round(c.trainSeconds) });
      }
      return res;
    }, function () { S.savesInFlight--; return null; });
    S.saveChain = p;
    return p;
  }

  function pause() {
    S.wantPause = true;
    if (S.phase !== 'ready') return;
    if (S.running) { S.running = false; S.gen++; save(true); }
    status();
  }
  function resume() {
    S.wantPause = false;
    if (S.phase !== 'ready' || S.running) { if (S.running) status(); return; }
    begin();
  }
  function doReset() {
    S.running = false; S.gen++;
    S.epoch++;
    S.wantPause = false;
    var cl = S.saveChain.then(function () { return store.clear(); }).then(null, function () { return null; });
    S.clearing = cl; S.savedPoolVer = -1;
    cl.then(function () { if (S.clearing === cl) S.clearing = null; });
    S.saveChain = cl;
    S.coach = newCoach(Arena.mixSeed(S.seed, S.epoch));
    S.coach.practiceOn = S.practice;
    S.restored = false; S.discarded = null; S.vizPrev = {};
    post(readyMsg());
    begin();
  }
  function reset() {
    if (S.phase === 'loading' || S.phase === 'idle') { S.pendingReset = true; return; }
    if (S.phase !== 'ready') return;
    doReset();
  }
  function setSpeed(v) {
    S.speed = normSpeed(v);
    S.liveT0 = now(); S.liveDone = 0;
    status();
  }
  function setPractice(on) { S.practice = on !== false; if (S.coach) S.coach.practiceOn = S.practice; status(); }
  function flush() {
    if (S.phase !== 'ready') return;
    save(true);
  }
  function viz(m) {
    if (!S.coach || S.phase !== 'ready') { post({ type: 'viz', id: m.id, fighters: [], ready: false }); return; }
    post({ type: 'viz', id: m.id, fighters: S.coach.viz(S.vizPrev), ready: true });
  }
  function exportWeights() {
    var b = S.coach ? S.coach.exportBrains() : null;
    post({ type: 'weights', a: b ? b.a : null, b: b ? b.b : null, rounds: S.coach ? S.coach.rounds : 0 });
  }

  self.onmessage = function (e) {
    var m = e && e.data;
    if (!m || typeof m.type !== 'string') return;
    try {
      switch (m.type) {
        case 'start': start(m); break;
        case 'speed': setSpeed(m.speed); break;
        case 'pause': pause(); break;
        case 'resume': resume(); break;
        case 'practice': setPractice(m.on); break;
        case 'reset': reset(); break;
        case 'flush': flush(); break;
        case 'viz': viz(m); break;
        case 'export': exportWeights(); break;
        default: break;
      }
    } catch (err) { fatal(m.type + ' failed: ' + errMsg(err)); }
  };
  self.__arenaWorkerState = S; // test hook
  self.__arenaLoad = load;
})();

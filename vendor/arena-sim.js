/* TKD-Net arena-sim.js v1 (owner: Waffle) - two-fighter taekwondo-style fight SIMULATION, no rendering.
 * Built to ARENA-CONTRACT.md v1 section 1 (sha 40190c16). Rules + index tables: ARENA-SIM-NOTES.md.
 * CLASSIC script (no import/export, no deps). Works via importScripts in a worker, <script> in the page, and Node (require).
 * Determinism: the only randomness is the sim's own seeded rng (mulberry32, same algorithm as TKD.makeRng). No Math.random.
 *
 *   var sim = TKD.Arena.createSim({ seed: 1, roundSeconds: 60 });
 *   var r = sim.reset();                 // { obs:[Float32Array A, Float32Array B] }
 *   r = sim.step(aA, aB);                // { obs, reward:[rA,rB], done, info:{t,hits,damage,health,stamina,winner, ...extras} }
 *   sim.actionMask(0|1); sim.state();
 *   TKD.Arena.scripted(level, seed?) -> function(obs, mask) -> action   (0 random, 1 approach+kick, 2 reactive)
 * Units: metres, seconds, radians. Ground plane = (x, z), y = up (Three.js style). Mat centred at origin.
 * Facing: yaw, forward unit vector = (cos yaw, sin yaw) in (x, z). "Left" = yaw + 90deg. turn_left = yaw increases.
 */
(function (root) {
  'use strict';
  var TKD = root.TKD = root.TKD || {};
  var Arena = TKD.Arena = TKD.Arena || {};
  var PI = Math.PI, D2R = PI / 180;

  // ---------------------------------------------------------------- constants
  var DECISION_HZ = 10, DT = 1 / DECISION_HZ;
  var MAT_HALF = 4;            // 8 m x 8 m square mat
  var BODY_R = 0.3;            // fighters cannot get closer than 2*BODY_R centre-to-centre
  var MAX_HEALTH = 300;          // high enough that most rounds between competent fighters go the full 60 s
  var EXHAUSTED = 0.15;        // stamina below this = exhausted (slow moves, +1 startup)
  var PASSIVE_WARN = 50;       // steps (5 s) without starting a technique -> small per-step penalty
  var PASSIVE_GAMJEOM = 100;   // steps (10 s) without starting a technique -> opponent +1 point, counter resets

  var ACTIONS = ['idle', 'move_forward', 'move_back', 'strafe_left', 'strafe_right', 'turn_left', 'turn_right',
    'guard', 'front_kick', 'roundhouse', 'side_kick', 'punch', 'block'];
  var NA = ACTIONS.length;
  var A = {}; for (var ai = 0; ai < NA; ai++) A[ACTIONS[ai]] = ai;
  var HITSTUN = NA;            // pseudo action (not choosable): stunned after being hit in startup
  var NACT_OBS = NA + 1;       // current-action one-hot includes hitstun

  // technique table (frames are decision steps at 10 Hz). reach = max centre-to-centre distance; arc = full cone width.
  var TECH = {};
  TECH[A.punch]      = { name: 'punch',      startup: 1, active: 1, recovery: 2, reach: 0.95, arc: 50 * D2R, damage: 6,  points: 1, cost: 0.05, knock: 0.10, whiffExtra: 0 };
  TECH[A.front_kick] = { name: 'front_kick', startup: 2, active: 1, recovery: 3, reach: 1.20, arc: 40 * D2R, damage: 10, points: 2, cost: 0.10, knock: 0.30, whiffExtra: 1 };
  TECH[A.roundhouse] = { name: 'roundhouse', startup: 3, active: 2, recovery: 3, reach: 1.15, arc: 100 * D2R, damage: 12, points: 3, cost: 0.13, knock: 0.25, whiffExtra: 1 };
  TECH[A.side_kick]  = { name: 'side_kick',  startup: 3, active: 1, recovery: 4, reach: 1.40, arc: 30 * D2R, damage: 14, points: 3, cost: 0.15, knock: 0.45, whiffExtra: 2 };
  TECH[A.block]      = { name: 'block',      startup: 0, active: 2, recovery: 3, reach: 0, arc: 0, damage: 0, points: 0, cost: 0.04, knock: 0, whiffExtra: 0, cooldown: 10 };
  TECH[HITSTUN]      = { name: 'hitstun',    startup: 0, active: 0, recovery: 2, reach: 0, arc: 0, damage: 0, points: 0, cost: 0, knock: 0, whiffExtra: 0 };
  var ATTACKS = [A.front_kick, A.roundhouse, A.side_kick, A.punch];  // order used in obs reach/canHit/threat groups
  var BLOCK_ARC = 70 * D2R, GUARD_ARC = 80 * D2R;  // half-angles: attacker must be within this of defender's facing
  var GUARD_DMG = 0.25, COUNTER_MULT = 1.25, BLOCK_REFUND = 0.08, BLOCK_STAGGER = 2;

  var MOVE = { fwd: 0.20, back: 0.15, strafe: 0.15, turn: 30 * D2R };  // per step (m, rad)
  var REGEN = { idle: 0.030, move: 0.012, guard: 0.008, turn: 0.020 };
  var MOVE_COST = 0.004;

  // reward weights (per fighter, per decision step). Raw event flags are in info.flags so a learner can reshape.
  var REWARD = { damage: 0.01, points: 0.10, whiff: 0.02, exhausted: 0.005, passive: 0.003, edge: 0.01, closing: 0.02,
    win: 1.0, loss: -1.0, draw: -0.3 };  // draw < 0 for BOTH: stops mutual-stalling collusion in pure self-play (see notes)

  // trainer slugs (hyphen = v2 class list; v1 class id into TKD.CLASSES as poseClass)
  var POSE = {}; var POSE_CLASS = {};
  for (var pi = 0; pi < NA; pi++) { POSE[pi] = 'ready-stance'; POSE_CLASS[pi] = 0; }
  POSE[A.front_kick] = 'front-kick'; POSE_CLASS[A.front_kick] = 1;
  POSE[A.roundhouse] = 'roundhouse-kick'; POSE_CLASS[A.roundhouse] = 2;
  POSE[A.side_kick] = 'side-kick'; POSE_CLASS[A.side_kick] = 3;
  POSE[A.punch] = 'punch'; POSE_CLASS[A.punch] = 8;
  POSE[A.guard] = 'high-block'; POSE_CLASS[A.guard] = 7;
  POSE[A.block] = 'low-block'; POSE_CLASS[A.block] = 6;
  POSE[HITSTUN] = 'ready-stance';
  var MOTION = ['idle', 'forward', 'back', 'strafe-left', 'strafe-right', 'turn-left', 'turn-right'];

  // ---------------------------------------------------------------- observation layout
  var LAYOUT = [], OBS = {}, OBS_DIM = 0;
  function seg(name, size) { LAYOUT.push({ name: name, start: OBS_DIM, size: size }); OBS[name] = OBS_DIM; OBS_DIM += size; }
  ['self', 'opp'].forEach(function (p) {
    seg(p + '.health', 1); seg(p + '.stamina', 1); seg(p + '.exhausted', 1);
    seg(p + '.action', NACT_OBS); seg(p + '.phase', 3); seg(p + '.progress', 1); seg(p + '.untilActive', 1);
    seg(p + '.locked', 1); seg(p + '.vulnerable', 1); seg(p + '.blockCooldown', 1); seg(p + '.passivity', 1);
  });
  seg('dist', 1); seg('bearingSin', 1); seg('bearingCos', 1); seg('oppFacingSin', 1); seg('oppFacingCos', 1);
  seg('edge', 4); seg('reachMargin', 4); seg('canHit', 4); seg('threat', 4);
  seg('timeLeft', 1); seg('scoreDiff', 1); seg('healthDiff', 1);
  seg('lastOwn1', NA); seg('lastOwn2', NA); seg('lastOpp', NA);

  // ---------------------------------------------------------------- helpers
  function makeRng(seed) {           // mulberry32, identical to TKD.makeRng in nn.js
    var a = (seed >>> 0) || 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function wrap(a) { while (a > PI) a -= 2 * PI; while (a < -PI) a += 2 * PI; return a; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function rayToEdge(x, z, dx, dz) {  // distance from inside point to square boundary along unit dir
    var t = 1e9;
    if (dx > 1e-9) t = Math.min(t, (MAT_HALF - x) / dx); else if (dx < -1e-9) t = Math.min(t, (-MAT_HALF - x) / dx);
    if (dz > 1e-9) t = Math.min(t, (MAT_HALF - z) / dz); else if (dz < -1e-9) t = Math.min(t, (-MAT_HALF - z) / dz);
    return t < 0 ? 0 : t;
  }

  function newFighter() {
    return { x: 0, z: 0, yaw: 0, health: MAX_HEALTH, stamina: 1, act: A.idle, f: 0, total: 0, startup: 0, active: 0,
      locked: false, hasHit: false, blockCd: 0, sinceAttack: 0, points: 0, hist: [A.idle, A.idle], lastStarted: A.idle,
      wasExhausted: false, hits: 0, damageDealt: 0 };
  }

  // ---------------------------------------------------------------- Sim
  function Sim(opts) {
    opts = opts || {};
    this.seed = (opts.seed == null ? 1 : opts.seed) >>> 0;
    this.roundSeconds = opts.roundSeconds || 60;
    this.roundSteps = Math.round(this.roundSeconds * DECISION_HZ);
    this.rng = makeRng(this.seed);
    this.round = 0;
    this.wins = [0, 0, 0];      // A, B, draws (across rounds of this sim object)
    this.fighters = [newFighter(), newFighter()];
    this.obsBuf = [new Float32Array(OBS_DIM), new Float32Array(OBS_DIM)];
    this.reset();
  }
  var P = Sim.prototype;

  P.reset = function (seed) {
    if (seed != null) { this.seed = seed >>> 0; this.rng = makeRng(this.seed); }
    var rng = this.rng;
    this.round++;
    this.steps = 0; this.t = 0; this.done = false; this.winner = -1; this.events = []; this.endReason = null;
    var ang = rng() * 2 * PI, sp = 2.4 + rng() * 1.6;           // random axis + spacing 2.4..4.0 m
    var cx = (rng() - 0.5) * 1.0, cz = (rng() - 0.5) * 1.0;      // slight off-centre
    var ux = Math.cos(ang), uz = Math.sin(ang);
    for (var i = 0; i < 2; i++) {
      var F = this.fighters[i] = newFighter(), s = i === 0 ? -1 : 1;
      F.x = cx + s * ux * sp / 2; F.z = cz + s * uz * sp / 2;
      F.yaw = wrap(ang + (i === 0 ? 0 : PI) + (rng() - 0.5) * 40 * D2R);
    }
    this._prevDist = this._dist();
    this._buildObs(0); this._buildObs(1);
    return { obs: [this.obsBuf[0], this.obsBuf[1]] };
  };

  P._dist = function () { var a = this.fighters[0], b = this.fighters[1]; return Math.hypot(b.x - a.x, b.z - a.z); };

  P.actionMask = function (i) {
    var m = new Uint8Array(NA), F = this.fighters[i];
    if (F.locked || this.done) { m[A.idle] = 1; return m; }
    for (var a = 0; a < NA; a++) m[a] = 1;
    for (var k = 0; k < ATTACKS.length; k++) if (F.stamina < TECH[ATTACKS[k]].cost) m[ATTACKS[k]] = 0;
    if (F.blockCd > 0 || F.stamina < TECH[A.block].cost) m[A.block] = 0;
    return m;
  };
  P.actionMaskInto = function (i, m) {   // allocation-free variant for hot loops
    var F = this.fighters[i];
    if (F.locked || this.done) { for (var a = 0; a < NA; a++) m[a] = 0; m[A.idle] = 1; return m; }
    for (var b = 0; b < NA; b++) m[b] = 1;
    for (var k = 0; k < 4; k++) if (F.stamina < TECH[ATTACKS[k]].cost) m[ATTACKS[k]] = 0;
    if (F.blockCd > 0 || F.stamina < TECH[A.block].cost) m[A.block] = 0;
    return m;
  };

  function legal(sim, i, a) {
    var F = sim.fighters[i];
    if (F.locked) return false;
    if (!(a >= 0 && a < NA) || (a | 0) !== a) return false;
    var T = TECH[a];
    if (T) { if (F.stamina < T.cost) return false; if (a === A.block && F.blockCd > 0) return false; }
    return true;
  }

  function startTech(F, a) {
    var T = TECH[a], slow = (a !== A.block && a !== HITSTUN && F.stamina < EXHAUSTED) ? 1 : 0;
    F.act = a; F.f = 0; F.startup = T.startup + slow; F.active = T.active; F.total = F.startup + T.active + T.recovery;
    F.locked = true; F.hasHit = false;
  }
  function phaseOf(F) {      // phase of frame F.f (the frame being / about to be executed)
    if (!F.locked) return -1;
    if (F.f < F.startup) return 0; if (F.f < F.startup + F.active) return 1; return 2;
  }

  P.step = function (actA, actB) {
    if (this.done) throw new Error('TKD.Arena: step() after done; call reset()');
    var fs = this.fighters, ev = this.events = [], i, F, O;
    var flags = [blankFlags(), blankFlags()];
    var acts = [actA, actB];
    var preDist = this._dist();
    // 1. decisions
    for (i = 0; i < 2; i++) {
      F = fs[i]; var a = acts[i];
      if (F.locked) { flags[i].ignored = (a !== A.idle) ? 1 : 0; continue; }
      if (!legal(this, i, a)) { flags[i].illegal = 1; a = A.idle; }
      F.hist[1] = F.hist[0]; F.hist[0] = a;
      if (TECH[a]) {
        F.stamina -= TECH[a].cost; startTech(F, a);
        if (a === A.block) F.blockCd = TECH[a].cooldown; else { F.sinceAttack = 0; flags[i].attack = 1; }
      } else { F.act = a; }
    }
    // 2. movement (simultaneous)
    for (i = 0; i < 2; i++) {
      F = fs[i]; if (F.locked) continue;
      var slowF = F.stamina < EXHAUSTED ? 0.5 : 1, cy = Math.cos(F.yaw), sy = Math.sin(F.yaw), d = 0, dx = 0, dz = 0;
      switch (F.act) {
        case A.move_forward: d = MOVE.fwd; dx = cy; dz = sy; break;
        case A.move_back: d = MOVE.back; dx = -cy; dz = -sy; break;
        case A.strafe_left: d = MOVE.strafe; dx = -sy; dz = cy; break;
        case A.strafe_right: d = MOVE.strafe; dx = sy; dz = -cy; break;
        case A.turn_left: F.yaw = wrap(F.yaw + MOVE.turn * (slowF < 1 ? 0.67 : 1)); break;
        case A.turn_right: F.yaw = wrap(F.yaw - MOVE.turn * (slowF < 1 ? 0.67 : 1)); break;
      }
      if (d) { F.x += dx * d * slowF; F.z += dz * d * slowF; F.stamina -= MOVE_COST; }
    }
    this._separate();
    for (i = 0; i < 2; i++) if (this._clampEdge(fs[i])) { flags[i].edge = 1; ev.push({ type: 'edge', by: i }); }
    // 3. hit resolution: evaluate both against the same geometry, then apply
    var hitsThis = [null, null];
    for (i = 0; i < 2; i++) {
      F = fs[i]; O = fs[1 - i];
      if (!F.locked || F.act === A.block || F.act === HITSTUN || phaseOf(F) !== 1 || F.hasHit) continue;
      var T = TECH[F.act], dxo = O.x - F.x, dzo = O.z - F.z, dist = Math.hypot(dxo, dzo);
      var bear = wrap(Math.atan2(dzo, dxo) - F.yaw);
      if (dist <= T.reach && Math.abs(bear) <= T.arc / 2) hitsThis[i] = { dist: dist, dir: Math.atan2(dzo, dxo) };
    }
    var dmgTaken = [0, 0], dmgDealt = [0, 0], ptsGained = [0, 0];
    for (i = 0; i < 2; i++) {
      if (!hitsThis[i]) continue;
      F = fs[i]; O = fs[1 - i]; var T2 = TECH[F.act]; F.hasHit = true;
      // angle of attacker as seen from defender's facing
      var seen = Math.abs(wrap(hitsThis[i].dir + PI - O.yaw));
      var oPhase = phaseOf(O), oAct = O.act;
      if (oAct === A.block && oPhase === 1 && seen <= BLOCK_ARC) {
        O.stamina = Math.min(1, O.stamina + BLOCK_REFUND);
        F.total += BLOCK_STAGGER;                          // attacker staggered: longer recovery
        flags[1 - i].blocked = 1; flags[i].gotBlocked = 1;
        ev.push({ type: 'blocked', by: 1 - i, tech: T2.name });
        continue;
      }
      var dmg = T2.damage, kind = 'hit';
      if (oAct === A.guard && !O.locked && seen <= GUARD_ARC) {
        dmg = T2.damage * GUARD_DMG; kind = 'guarded';
        O.stamina -= 0.03 + T2.damage * 0.004;
        flags[1 - i].guarded = 1;
      } else {
        if (O.locked && oAct !== A.block && (oPhase === 0 || oPhase === 2 || oAct === HITSTUN)) { dmg *= COUNTER_MULT; kind = 'counter'; flags[i].counter = 1; }
        ptsGained[i] += T2.points; flags[i].clean = 1;
        // interrupt a technique in startup
        if (O.locked && oPhase === 0 && oAct !== A.block && !(hitsThis[1 - i])) { startTech(O, HITSTUN); flags[1 - i].stunned = 1; }
        // knockback
        O.x += Math.cos(hitsThis[i].dir) * T2.knock; O.z += Math.sin(hitsThis[i].dir) * T2.knock;
        if (this._clampEdge(O)) { ptsGained[i] += 1; flags[1 - i].pushedOut = 1; ev.push({ type: 'pushout', by: i }); }
      }
      dmgTaken[1 - i] += dmg; dmgDealt[i] += dmg; flags[i].hit = 1; F.hits++;
      ev.push({ type: kind, by: i, tech: T2.name, damage: Math.round(dmg * 10) / 10, points: kind === 'guarded' ? 0 : T2.points });
    }
    for (i = 0; i < 2; i++) { fs[i].health = Math.max(0, fs[i].health - dmgTaken[i]); fs[i].damageDealt += dmgDealt[i]; }
    this._separate();
    // 4. advance frames, whiffs, stamina, passivity
    for (i = 0; i < 2; i++) {
      F = fs[i]; O = fs[1 - i];
      if (F.locked) {
        var ph = phaseOf(F);
        if (ph === 1 && F.f === F.startup + F.active - 1 && !F.hasHit && F.act !== A.block && F.act !== HITSTUN) {
          flags[i].whiff = 1; F.total += TECH[F.act].whiffExtra; ev.push({ type: 'whiff', by: i, tech: TECH[F.act].name });
        }
        F.f++;
        if (F.f >= F.total) { F.locked = false; F.act = A.idle; F.f = 0; }
      } else {
        var r = F.act === A.idle ? REGEN.idle : F.act === A.guard ? REGEN.guard : (F.act === A.turn_left || F.act === A.turn_right) ? REGEN.turn : REGEN.move;
        F.stamina += r;
      }
      F.stamina = clamp(F.stamina, 0, 1);
      if (F.blockCd > 0) F.blockCd--;
      var ex = F.stamina < EXHAUSTED; flags[i].exhausted = ex ? 1 : 0;
      if (ex && !F.wasExhausted) ev.push({ type: 'exhausted', by: i }); F.wasExhausted = ex;
      F.sinceAttack++;
      if (F.sinceAttack > PASSIVE_WARN) flags[i].passive = 1;
      if (F.sinceAttack >= PASSIVE_GAMJEOM) { ptsGained[1 - i] += 1; F.sinceAttack = 0; flags[i].gamjeom = 1; ev.push({ type: 'passivity', by: i }); }
    }
    fs[0].points += ptsGained[0]; fs[1].points += ptsGained[1];
    // 5. time / termination
    this.steps++; this.t = this.steps * DT;
    var ko = fs[0].health <= 0 || fs[1].health <= 0;
    if (ko || this.steps >= this.roundSteps) {
      this.done = true;
      if (ko) {
        this.endReason = 'ko';
        this.winner = (fs[0].health <= 0 && fs[1].health <= 0) ? 0 : fs[1].health <= 0 ? 1 : 2;
        ev.push({ type: 'ko', by: this.winner === 1 ? 0 : this.winner === 2 ? 1 : -1 });
      } else {
        this.endReason = 'time';
        var pd = fs[0].points - fs[1].points, hd = fs[0].health - fs[1].health;
        this.winner = pd > 0 ? 1 : pd < 0 ? 2 : hd > 0.5 ? 1 : hd < -0.5 ? 2 : 0;
      }
      this.wins[this.winner === 1 ? 0 : this.winner === 2 ? 1 : 2]++;
    }
    // 6. rewards
    var dist = this._dist(), rew = [0, 0];
    for (i = 0; i < 2; i++) {
      var j = 1 - i, Fi = fs[i], Fj = fs[j], fl = flags[i];
      var rr = REWARD.damage * (dmgDealt[i] - dmgTaken[i]) + REWARD.points * (ptsGained[i] - ptsGained[j])
        - REWARD.whiff * fl.whiff - REWARD.exhausted * fl.exhausted - REWARD.passive * fl.passive - REWARD.edge * fl.edge;
      var behind = (Fi.points - Fj.points) + (Fi.health - Fj.health) / 20 < 0;
      if (behind && dist > 1.0) { var c = clamp(preDist - dist, -0.3, 0.3); rr += REWARD.closing * c; fl.closing = c; }
      if (this.done) rr += this.winner === 0 ? REWARD.draw : this.winner === i + 1 ? REWARD.win : REWARD.loss;
      fl.damageDealt = dmgDealt[i]; fl.damageTaken = dmgTaken[i]; fl.pointsGained = ptsGained[i];
      rew[i] = rr;
    }
    this._prevDist = dist;
    this._buildObs(0); this._buildObs(1);
    return {
      obs: [this.obsBuf[0], this.obsBuf[1]], reward: rew, done: this.done,
      info: {
        t: this.t, hits: [fs[0].hits, fs[1].hits], damage: [fs[0].damageDealt, fs[1].damageDealt],
        health: [fs[0].health, fs[1].health], stamina: [fs[0].stamina, fs[1].stamina], winner: this.winner,
        // extras (not in contract v1): cumulative points, this step's events + raw per-fighter flags, step index
        points: [fs[0].points, fs[1].points], step: this.steps, events: ev, flags: flags, endReason: this.endReason
      }
    };
  };

  function blankFlags() {
    return { attack: 0, hit: 0, clean: 0, counter: 0, whiff: 0, blocked: 0, gotBlocked: 0, guarded: 0, stunned: 0,
      pushedOut: 0, edge: 0, exhausted: 0, passive: 0, gamjeom: 0, illegal: 0, ignored: 0, closing: 0,
      damageDealt: 0, damageTaken: 0, pointsGained: 0 };
  }

  P._separate = function () {
    var a = this.fighters[0], b = this.fighters[1], dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), m = 2 * BODY_R;
    if (d < m) {
      if (d < 1e-6) { dx = Math.cos(a.yaw); dz = Math.sin(a.yaw); d = 1; } else { dx /= d; dz /= d; }
      var push = (m - (d < 1e-6 ? 0 : d)) / 2;
      a.x -= dx * push; a.z -= dz * push; b.x += dx * push; b.z += dz * push;
    }
  };
  P._clampEdge = function (F) {
    var lim = MAT_HALF - BODY_R, out = false;
    if (F.x > lim) { F.x = lim; out = true; } else if (F.x < -lim) { F.x = -lim; out = true; }
    if (F.z > lim) { F.z = lim; out = true; } else if (F.z < -lim) { F.z = -lim; out = true; }
    return out;
  };

  function writeFighter(o, base, F, T) {
    o[base] = F.health / MAX_HEALTH; o[base + 1] = F.stamina; o[base + 2] = F.stamina < EXHAUSTED ? 1 : 0;
    o[base + 3 + F.act] = 1;
    var p = base + 3 + NACT_OBS, ph = phaseOf(F);
    if (ph >= 0) { o[p + ph] = 1; o[p + 3] = F.f / F.total; o[p + 4] = ph === 0 ? clamp((F.startup - F.f) / 4, 0, 1) : 0; o[p + 5] = 1; }
    o[p + 6] = (ph === 2 || F.act === HITSTUN) ? 1 : 0;
    o[p + 7] = F.blockCd / TECH[A.block].cooldown;
    o[p + 8] = clamp(F.sinceAttack / PASSIVE_GAMJEOM, 0, 1);
  }

  P._buildObs = function (i) {
    // fresh array every step: callers may store observations in trajectories without copying
    var o = this.obsBuf[i] = new Float32Array(OBS_DIM);
    var F = this.fighters[i], O = this.fighters[1 - i];
    writeFighter(o, OBS['self.health'], F); writeFighter(o, OBS['opp.health'], O);
    var dx = O.x - F.x, dz = O.z - F.z, dist = Math.hypot(dx, dz);
    var bear = wrap(Math.atan2(dz, dx) - F.yaw), ob = wrap(Math.atan2(-dz, -dx) - O.yaw);
    o[OBS.dist] = clamp(dist / (2 * MAT_HALF), 0, 1);
    o[OBS.bearingSin] = Math.sin(bear); o[OBS.bearingCos] = Math.cos(bear);
    o[OBS.oppFacingSin] = Math.sin(ob); o[OBS.oppFacingCos] = Math.cos(ob);
    var cy = Math.cos(F.yaw), sy = Math.sin(F.yaw), e = OBS.edge, S = 2 * MAT_HALF;
    o[e] = clamp(rayToEdge(F.x, F.z, cy, sy) / S, 0, 1); o[e + 1] = clamp(rayToEdge(F.x, F.z, -cy, -sy) / S, 0, 1);
    o[e + 2] = clamp(rayToEdge(F.x, F.z, -sy, cy) / S, 0, 1); o[e + 3] = clamp(rayToEdge(F.x, F.z, sy, -cy) / S, 0, 1);
    for (var k = 0; k < 4; k++) {
      var T = TECH[ATTACKS[k]];
      o[OBS.reachMargin + k] = clamp(T.reach - dist, -1, 1);
      o[OBS.canHit + k] = (dist <= T.reach && Math.abs(bear) <= T.arc / 2) ? 1 : 0;
      o[OBS.threat + k] = (dist <= T.reach && Math.abs(ob) <= T.arc / 2) ? 1 : 0;
    }
    o[OBS.timeLeft] = 1 - this.steps / this.roundSteps;
    o[OBS.scoreDiff] = clamp((F.points - O.points) / 10, -1, 1);
    o[OBS.healthDiff] = (F.health - O.health) / MAX_HEALTH;
    o[OBS.lastOwn1 + F.hist[0]] = 1; o[OBS.lastOwn2 + F.hist[1]] = 1; o[OBS.lastOpp + O.hist[0]] = 1;
    return o;
  };

  P.state = function () {
    var fs = this.fighters, out = [];
    for (var i = 0; i < 2; i++) {
      var F = fs[i], ph = phaseOf(F), act = F.act;
      out.push({
        x: +F.x.toFixed(3), y: 0, z: +F.z.toFixed(3), yaw: +F.yaw.toFixed(4),
        action: act === HITSTUN ? 'hitstun' : ACTIONS[act], actionId: act,
        pose: POSE[act], poseClass: POSE_CLASS[act], motion: act < MOTION.length ? MOTION[act] : null,
        phase: ph < 0 ? 'none' : ['startup', 'active', 'recovery'][ph], frame: F.locked ? F.f : 0, frames: F.locked ? F.total : 0,
        phaseProgress: F.locked ? +(F.f / F.total).toFixed(3) : 0,
        health: +F.health.toFixed(2), stamina: +F.stamina.toFixed(3), points: F.points, hits: F.hits,
        guarding: act === A.guard, blocking: act === A.block && ph === 1, vulnerable: ph === 2 || act === HITSTUN,
        exhausted: F.stamina < EXHAUSTED, blockCooldown: F.blockCd
      });
    }
    return { t: +this.t.toFixed(2), step: this.steps, round: this.round, roundSeconds: this.roundSeconds,
      timeLeft: +(this.roundSeconds - this.t).toFixed(2), mat: { size: 2 * MAT_HALF, bodyRadius: BODY_R },
      fighters: out, score: [fs[0].points, fs[1].points], wins: this.wins.slice(), done: this.done, winner: this.winner,
      endReason: this.endReason, events: this.events.slice() };
  };

  // ---------------------------------------------------------------- scripted baselines: function(obs, mask) -> action
  function pickLegal(mask, a, fallback) { return mask[a] ? a : (fallback != null && mask[fallback] ? fallback : A.idle); }
  function faceOrNull(o, tol) {
    var s = o[OBS.bearingSin], c = o[OBS.bearingCos];
    if (c < Math.cos(tol)) return s > 0 ? A.turn_left : A.turn_right;
    return null;
  }
  function oppPhase(o) { var p = OBS['opp.phase']; return o[p] ? 0 : o[p + 1] ? 1 : o[p + 2] ? 2 : -1; }
  function oppAct(o) { var b = OBS['opp.action']; for (var k = 0; k < NACT_OBS; k++) if (o[b + k]) return k; return 0; }
  function isAttack(a) { return a === A.front_kick || a === A.roundhouse || a === A.side_kick || a === A.punch; }

  function scripted(level, seed) {
    var rng = makeRng(seed == null ? 12345 + level : seed);
    function rand() { return rng(); }
    if (level === 0) {  // uniform random over legal actions
      return function (o, mask) {
        var n = 0, k; for (k = 0; k < NA; k++) if (!mask || mask[k]) n++;
        var r = Math.floor(rand() * n); for (k = 0; k < NA; k++) if (!mask || mask[k]) { if (r-- === 0) return k; }
        return A.idle;
      };
    }
    if (level === 1) {  // approach, face, throw a random technique that reaches
      return function (o, mask) {
        mask = mask || allMask;
        if (o[OBS['self.locked']]) return A.idle;
        var t = faceOrNull(o, 20 * D2R); if (t != null) return t;
        var opts = []; for (var k = 0; k < 4; k++) if (o[OBS.canHit + k] && mask[ATTACKS[k]]) opts.push(ATTACKS[k]);
        if (opts.length && rand() < 0.6) return opts[Math.floor(rand() * opts.length)];
        if (o[OBS['self.stamina']] < 0.2) return A.idle;
        if (o[OBS.dist] * 2 * MAT_HALF > 1.0) return A.move_forward;
        return rand() < 0.5 ? A.idle : A.move_forward;
      };
    }
    // level 2: reactive spacing + whiff punish + timed block/guard
    return function (o, mask) {
      mask = mask || allMask;
      if (o[OBS['self.locked']]) return A.idle;
      var dist = o[OBS.dist] * 2 * MAT_HALF, oa = oppAct(o), op = oppPhase(o);
      var threatened = isAttack(oa) && op === 0;
      var anyThreat = o[OBS.threat] || o[OBS.threat + 1] || o[OBS.threat + 2] || o[OBS.threat + 3];
      var t = faceOrNull(o, 15 * D2R);
      if (threatened && anyThreat) {
        var until = o[OBS['opp.untilActive']] * 4;
        if (until <= 1 && mask[A.block]) return A.block;
        if (t == null) return A.guard;
        return A.move_back;
      }
      if (t != null) return t;
      var vuln = o[OBS['opp.vulnerable']] || (isAttack(oa) && op === 2);
      var st = o[OBS['self.stamina']];
      // whiff / recovery punish: fastest technique that reaches
      if (vuln) {
        var order = [A.punch, A.front_kick, A.roundhouse, A.side_kick];
        for (var q = 0; q < 4; q++) { var k = ATTACKS.indexOf(order[q]); if (o[OBS.canHit + k] && mask[order[q]]) return order[q]; }
        if (dist > 0.9) return A.move_forward;
      }
      if (st < 0.3) return dist < 1.8 ? A.move_back : A.idle;
      // spacing: sit just outside the opponent's longest reach, then step in and side kick / front kick
      var passive = o[OBS['self.passivity']] > 0.6;
      if (o[OBS.canHit + 2] && mask[A.side_kick] && (rand() < 0.35 || passive)) return A.side_kick;
      if (o[OBS.canHit] && mask[A.front_kick] && (rand() < 0.3 || passive)) return A.front_kick;
      if (o[OBS.canHit + 3] && mask[A.punch] && rand() < 0.4) return A.punch;
      if (dist > 1.9) return A.move_forward;
      if (dist < 1.2 && rand() < 0.5) return A.move_back;
      if (passive) return A.move_forward;
      var r = rand();
      return r < 0.3 ? A.strafe_left : r < 0.6 ? A.strafe_right : r < 0.8 ? A.idle : A.move_forward;
    };
  }
  var allMask = new Uint8Array(NA); for (var mi = 0; mi < NA; mi++) allMask[mi] = 1;

  // ---------------------------------------------------------------- exports
  Arena.Sim = Sim;
  Arena.createSim = function (opts) { return new Sim(opts); };
  Arena.OBS_DIM = OBS_DIM;
  Arena.ACTIONS = ACTIONS.slice();
  Arena.NUM_ACTIONS = NA;
  Arena.DECISION_HZ = DECISION_HZ;
  Arena.scripted = scripted;
  // extras (not in contract v1)
  Arena.ACTION_ID = A;
  Arena.OBS = OBS;                 // name -> start index
  Arena.OBS_LAYOUT = LAYOUT;       // [{name,start,size}]
  Arena.ATTACK_ORDER = ATTACKS.map(function (a) { return ACTIONS[a]; });
  Arena.TECH = (function () { var t = {}; for (var k in TECH) t[TECH[k].name] = TECH[k]; return t; })();
  Arena.REWARD = REWARD;
  Arena.POSE = ACTIONS.map(function (_, k) { return POSE[k]; });
  Arena.makeRng = makeRng;
  Arena.SIM_VERSION = 'arena-sim-1';
  Arena.SIM_NAME = 'arena-sim-2d-v1';   // arena-rl.js keys saved brains on this; bump on any obs/action/rule change
  Arena.CONTRACT = 'ARENA-CONTRACT.md v1 (40190c16)';
  if (typeof module !== 'undefined' && module.exports) module.exports = Arena;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);

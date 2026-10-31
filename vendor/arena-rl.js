/* TKD-Net arena-rl.js (owner: Moneyman) -- learning side of the Arena (ARENA-CONTRACT.md section 2).
 * Classic script, no dependencies, works in a Web Worker (importScripts), a page and node.
 *
 *   TKD.Arena.Net     actor-critic MLP: obs -> tanh(H1) -> tanh(H2) -> { masked-softmax policy over NUM_ACTIONS, value }
 *                     hand-written forward/backprop on Float32Array (Float64Array for gradient checks).
 *   TKD.Arena.Learner one fighter's brain: Net + Adam (global-norm grad clipping) + PPO-clip with GAE,
 *                     advantage normalisation, entropy bonus, minibatch epochs, KL early stop, NaN recovery.
 *                     Updates are sliceable jobs (job.work(nSamples)) so the worker never blocks.
 *   TKD.Arena.Coach   the league: two learners, practice matches (50% current-vs-current, 30% vs past snapshots,
 *                     20% vs scripted), live match, opponent pool (<= 8 snapshots per fighter), fixed benchmark
 *                     milestones, Elo vs FIXED benchmarks (scripted levels calibrated once + frozen milestones).
 *                     Everything is driven by count-based work units, so a run is deterministic given the seed.
 * Sizes come from the sim (TKD.Arena.OBS_DIM / NUM_ACTIONS) at construction; nothing is hard-coded.
 */
(function (root) {
  'use strict';
  var TKD = root.TKD = root.TKD || {};
  var Arena = TKD.Arena = TKD.Arena || {};
  Arena.RL_VERSION = 'arena-mlp-tanh-ppo-v1';

  function makeRng(seed) { // mulberry32
    var a = (seed >>> 0) || 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  Arena.rlMakeRng = makeRng; // the learner's own rng (does not depend on whichever sim defined Arena.makeRng)
  function mixSeed(a, b) { return (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x632BE5AB, 0x85EBCA77) ^ 0x27D4EB2F) >>> 0; }
  Arena.mixSeed = mixSeed;
  function gaussian(rng) {
    var u = 0; while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  // ------------------------------------------------------------------ Net
  function Net(opts) {
    opts = opts || {};
    var A = this.A = opts.float64 ? Float64Array : Float32Array;
    this.D = opts.obsDim | 0; this.NA = opts.numActions | 0;
    if (!(this.D > 0) || !(this.NA > 1)) throw new Error('Arena.Net: obsDim and numActions must come from the sim');
    var hid = opts.hidden || [64, 64];
    this.H1 = hid[0] | 0; this.H2 = hid[1] | 0;
    var rng = makeRng((opts.seed == null ? 1 : opts.seed) >>> 0 || 1), self = this;
    function param(name, size, std, shape) {
      var w = new A(size);
      if (std > 0) for (var i = 0; i < size; i++) w[i] = gaussian(rng) * std;
      return { name: name, w: w, g: new A(size), shape: shape };
    }
    var D = this.D, H1 = this.H1, H2 = this.H2, NA = this.NA;
    // Layouts: W1[h][d], W2[h2][h1], Wp[a][h2], Wv[h2]
    this.params = [
      param('W1', H1 * D, Math.sqrt(1 / D), [H1, D]), param('b1', H1, 0, [H1]),
      param('W2', H2 * H1, Math.sqrt(1 / H1), [H2, H1]), param('b2', H2, 0, [H2]),
      param('Wp', NA * H2, 0.01, [NA, H2]), param('bp', NA, 0, [NA]),
      param('Wv', H2, Math.sqrt(1 / H2), [1, H2]), param('bv', 1, 0, [1])
    ];
    this.byName = {};
    this.params.forEach(function (p) { self.byName[p.name] = p; });
    this.h1 = new A(H1); this.h2 = new A(H2); this.z = new A(NA); this.p = new A(NA); this.logp = new A(NA);
    this.m = new Uint8Array(NA); this.value = 0;
    this.dz = new A(NA); this.dh2 = new A(H2); this.dh1 = new A(H1);
  }
  Net.prototype.paramCount = function () { var s = 0; for (var q = 0; q < this.params.length; q++) s += this.params[q].w.length; return s; };
  Net.prototype.layers = function () {
    return [
      { name: 'trunk1 (tanh)', shape: [this.D, this.H1], params: this.H1 * this.D + this.H1 },
      { name: 'trunk2 (tanh)', shape: [this.H1, this.H2], params: this.H2 * this.H1 + this.H2 },
      { name: 'policy (masked softmax)', shape: [this.H2, this.NA], params: this.NA * this.H2 + this.NA },
      { name: 'value', shape: [this.H2, 1], params: this.H2 + 1 }
    ];
  };

  // Forward ONE observation (obs offset `oo` into array `x`), mask (offset mo into `mk`, or null = all allowed).
  // Leaves h1, h2, z, p (masked probs), logp, value in the scratch buffers.
  Net.prototype.forward = function (x, oo, mk, mo) {
    var D = this.D, H1 = this.H1, H2 = this.H2, NA = this.NA, i, j;
    var W1 = this.params[0].w, b1 = this.params[1].w, W2 = this.params[2].w, b2 = this.params[3].w;
    var Wp = this.params[4].w, bp = this.params[5].w, Wv = this.params[6].w, bv = this.params[7].w;
    var h1 = this.h1, h2 = this.h2, z = this.z, p = this.p, logp = this.logp, m = this.m;
    oo = oo || 0; mo = mo || 0;
    for (i = 0; i < H1; i++) { var s = b1[i], wo = i * D; for (j = 0; j < D; j++) s += W1[wo + j] * x[oo + j]; h1[i] = Math.tanh(s); }
    for (i = 0; i < H2; i++) { var s2 = b2[i], w2 = i * H1; for (j = 0; j < H1; j++) s2 += W2[w2 + j] * h1[j]; h2[i] = Math.tanh(s2); }
    var v = bv[0]; for (j = 0; j < H2; j++) v += Wv[j] * h2[j]; this.value = v;
    var zmax = -Infinity, any = false;
    for (i = 0; i < NA; i++) {
      m[i] = mk ? (mk[mo + i] ? 1 : 0) : 1;
      if (m[i]) any = true;
    }
    if (!any) for (i = 0; i < NA; i++) m[i] = 1; // defensive: an all-zero mask means "all allowed"
    for (i = 0; i < NA; i++) {
      var zz = bp[i], wp = i * H2; for (j = 0; j < H2; j++) zz += Wp[wp + j] * h2[j];
      z[i] = zz; if (m[i] && zz > zmax) zmax = zz;
    }
    var den = 0;
    for (i = 0; i < NA; i++) { if (m[i]) { p[i] = Math.exp(z[i] - zmax); den += p[i]; } else p[i] = 0; }
    var lden = Math.log(den);
    for (i = 0; i < NA; i++) { if (m[i]) { p[i] /= den; logp[i] = z[i] - zmax - lden; } else logp[i] = -Infinity; }
    return p;
  };

  // Backprop after forward(): dz = dL/dlogits (masked entries ignored), dv = dL/dvalue. Accumulates into p.g.
  Net.prototype.backward = function (x, oo, dz, dv) {
    var D = this.D, H1 = this.H1, H2 = this.H2, NA = this.NA, i, j;
    var W2 = this.params[2].w, Wp = this.params[4].w, Wv = this.params[6].w;
    var gW1 = this.params[0].g, gb1 = this.params[1].g, gW2 = this.params[2].g, gb2 = this.params[3].g;
    var gWp = this.params[4].g, gbp = this.params[5].g, gWv = this.params[6].g, gbv = this.params[7].g;
    var h1 = this.h1, h2 = this.h2, dh2 = this.dh2, dh1 = this.dh1, m = this.m;
    oo = oo || 0;
    for (j = 0; j < H2; j++) { dh2[j] = Wv[j] * dv; gWv[j] += dv * h2[j]; }
    gbv[0] += dv;
    for (i = 0; i < NA; i++) {
      if (!m[i]) continue;
      var d = dz[i]; if (d === 0) continue;
      var wp = i * H2; gbp[i] += d;
      for (j = 0; j < H2; j++) { gWp[wp + j] += d * h2[j]; dh2[j] += Wp[wp + j] * d; }
    }
    dh1.fill(0);
    for (i = 0; i < H2; i++) {
      var g2 = dh2[i] * (1 - h2[i] * h2[i]); if (g2 === 0) continue;
      var w2 = i * H1; gb2[i] += g2;
      for (j = 0; j < H1; j++) { gW2[w2 + j] += g2 * h1[j]; dh1[j] += W2[w2 + j] * g2; }
    }
    for (i = 0; i < H1; i++) {
      var g1 = dh1[i] * (1 - h1[i] * h1[i]); if (g1 === 0) continue;
      var wo = i * D; gb1[i] += g1;
      for (j = 0; j < D; j++) gW1[wo + j] += g1 * x[oo + j];
    }
  };
  Net.prototype.zeroGrad = function () { for (var q = 0; q < this.params.length; q++) this.params[q].g.fill(0); };

  Net.prototype.getWeights = function () {
    var out = { version: Arena.RL_VERSION, obsDim: this.D, numActions: this.NA, hidden: [this.H1, this.H2] };
    for (var q = 0; q < this.params.length; q++) out[this.params[q].name] = new Float32Array(this.params[q].w);
    return out;
  };
  Net.checkWeights = function (obj, D, NA, hidden) {
    if (!obj) return 'no weights';
    if (obj.version !== Arena.RL_VERSION) return 'version mismatch ' + obj.version;
    if (obj.obsDim !== D || obj.numActions !== NA) return 'shape mismatch obsDim/numActions ' + obj.obsDim + '/' + obj.numActions + ' != ' + D + '/' + NA;
    if (hidden && (!obj.hidden || obj.hidden[0] !== hidden[0] || obj.hidden[1] !== hidden[1])) return 'hidden size mismatch';
    return null;
  };
  Net.prototype.setWeights = function (obj) {
    var e = Net.checkWeights(obj, this.D, this.NA, [this.H1, this.H2]);
    if (e) throw new Error('setWeights: ' + e);
    var q, p, i;
    for (q = 0; q < this.params.length; q++) {
      p = this.params[q]; var src = obj[p.name];
      if (!src || src.length !== p.w.length) throw new Error('setWeights: bad shape for ' + p.name);
      for (i = 0; i < src.length; i++) if (!isFinite(src[i])) throw new Error('setWeights: non-finite value in ' + p.name);
    }
    for (q = 0; q < this.params.length; q++) { p = this.params[q]; p.w.set(obj[p.name]); }
  };
  Arena.Net = Net;

  function sampleFrom(p, n, rng) {
    var u = rng(), c = 0, last = 0;
    for (var i = 0; i < n; i++) { if (p[i] > 0) { c += p[i]; last = i; if (u < c) return i; } }
    return last;
  }
  function argmaxP(p, n) { var b = 0; for (var i = 1; i < n; i++) if (p[i] > p[b]) b = i; return b; }
  Arena.sampleFrom = sampleFrom;

  // ------------------------------------------------------------------ Learner
  var DEFAULTS = { hidden: [64, 64], lr: 7e-4, gamma: 0.99, lambda: 0.95, clip: 0.2, epochs: 4, minibatches: 4,
    entropy: 0.02, valueCoef: 0.5, maxGradNorm: 0.5, targetKl: 0.03 };
  Arena.LEARNER_DEFAULTS = DEFAULTS;

  function Learner(opts) {
    opts = opts || {};
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in opts) if (opts[k] !== undefined) o[k] = opts[k];
    this.opts = o;
    this.obsDim = o.obsDim != null ? o.obsDim : Arena.OBS_DIM;
    this.numActions = o.numActions != null ? o.numActions : Arena.NUM_ACTIONS;
    this.net = new Net({ obsDim: this.obsDim, numActions: this.numActions, hidden: o.hidden, seed: o.seed, float64: o.float64 });
    this.A = this.net.A;
    this.lr = o.lr; this.baseLr = o.lr;
    this.m = []; this.v = [];
    for (var q = 0; q < this.net.params.length; q++) { this.m.push(new this.A(this.net.params[q].w.length)); this.v.push(new this.A(this.net.params[q].w.length)); }
    this.t = 0; this.updates = 0; this.rng = makeRng(mixSeed(o.seed || 1, 4242));
    this.dz = new this.A(this.numActions);
    this.nanStreak = 0; this.lrLowered = false;
    this.lastGood = this.net.getWeights(); // refreshed after every finite update; restored on NaN
  }
  Learner.prototype.paramCount = function () { return this.net.paramCount(); };
  Learner.prototype.resetOptimizer = function () { this.t = 0; for (var q = 0; q < this.m.length; q++) { this.m[q].fill(0); this.v[q].fill(0); } };
  Learner.prototype.getWeights = function () { return this.net.getWeights(); };
  Learner.prototype.setWeights = function (w) { this.net.setWeights(w); this.resetOptimizer(); this.lastGood = this.net.getWeights(); };

  Learner.prototype.weightsFinite = function () {
    for (var q = 0; q < this.net.params.length; q++) { var w = this.net.params[q].w; for (var k = 0; k < w.length; k++) if (!isFinite(w[k])) return false; }
    return true;
  };
  // NaN recovery (like train-worker.js): restore the last good weights, reset Adam, lower the learning rate once.
  Learner.prototype.recover = function () {
    this.nanStreak++;
    this.net.setWeights(this.lastGood); this.resetOptimizer();
    var lowered = false;
    if (!this.lrLowered) { this.lr *= 0.3; this.lrLowered = true; lowered = true; }
    return { nan: true, lowered: lowered, lr: this.lr, streak: this.nanStreak };
  };
  // Returns { a, logp, v } (sampled unless greedy).
  Learner.prototype.act = function (obs, mask, rng, greedy) {
    var p = this.net.forward(obs, 0, mask, 0);
    var a = greedy ? argmaxP(p, this.numActions) : sampleFrom(p, this.numActions, rng || this.rng);
    return { a: a, logp: this.net.logp[a], v: this.net.value };
  };

  // PPO loss on samples idx[from..to) of batch, gradients ACCUMULATED with weight `scale` per sample (no zeroing).
  // batch: { n, obs, mask (Uint8Array n*NA or null), act, oldLogp, adv, ret }. Returns sums (not means).
  Learner.prototype.lossAndGrad = function (batch, idx, from, to, scale, wantGrad) {
    var net = this.net, NA = this.numActions, D = this.obsDim, o = this.opts, dz = this.dz;
    var eps = o.clip, ce = o.entropy, vc = o.valueCoef;
    var S = { policy: 0, value: 0, entropy: 0, kl: 0, clipped: 0, n: 0, total: 0 };
    for (var r = from; r < to; r++) {
      var i = idx ? idx[r] : r, a = batch.act[i];
      var p = net.forward(batch.obs, i * D, batch.mask, i * NA), lp = net.logp;
      var lpa = lp[a];
      var ratio = Math.exp(lpa - batch.oldLogp[i]), adv = batch.adv[i];
      var s1 = ratio * adv, rc = ratio < 1 - eps ? 1 - eps : (ratio > 1 + eps ? 1 + eps : ratio), s2 = rc * adv;
      var pl = -(s1 < s2 ? s1 : s2);
      var H = 0, k;
      for (k = 0; k < NA; k++) if (net.m[k] && p[k] > 0) H -= p[k] * lp[k];
      var dv0 = net.value - batch.ret[i];
      S.policy += pl; S.value += 0.5 * dv0 * dv0; S.entropy += H; S.n++;
      S.kl += (ratio - 1) - (lpa - batch.oldLogp[i]);
      if (Math.abs(ratio - 1) > eps) S.clipped++;
      S.total += pl + vc * 0.5 * dv0 * dv0 - ce * H;
      if (!wantGrad) continue;
      var dlp = s1 <= s2 ? -s1 : 0; // d(-min)/d logp_a  (0 when the clipped branch is the min)
      for (k = 0; k < NA; k++) {
        if (!net.m[k]) { dz[k] = 0; continue; }
        var g = dlp * ((k === a ? 1 : 0) - p[k]);
        if (p[k] > 0) g += ce * p[k] * (lp[k] + H); // d(-ce*H)/dz_k
        dz[k] = g * scale;
      }
      net.backward(batch.obs, i * D, dz, vc * dv0 * scale);
    }
    return S;
  };

  // Adam step with global-norm clipping. Returns pre-clip norm (non-finite -> no update).
  Learner.prototype.applyGradients = function () {
    var ps = this.net.params, sq = 0, q, i;
    for (q = 0; q < ps.length; q++) { var g = ps[q].g; for (i = 0; i < g.length; i++) sq += g[i] * g[i]; }
    var norm = Math.sqrt(sq);
    if (!isFinite(norm)) return norm;
    var mg = this.opts.maxGradNorm, scale = (mg > 0 && norm > mg) ? mg / norm : 1;
    this.t++;
    var b1 = 0.9, b2 = 0.999, ep = 1e-8, bc1 = 1 - Math.pow(b1, this.t), bc2 = 1 - Math.pow(b2, this.t), step = this.lr / bc1;
    for (q = 0; q < ps.length; q++) {
      var w = ps[q].w, gg = ps[q].g, m = this.m[q], v = this.v[q];
      for (i = 0; i < w.length; i++) {
        var gi = gg[i] * scale;
        m[i] = b1 * m[i] + (1 - b1) * gi; v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        w[i] -= step * m[i] / (Math.sqrt(v[i] / bc2) + ep);
      }
    }
    return norm;
  };

  // GAE(lambda) advantages + returns, then advantage normalisation. traj: { n, rew, val, done (last step terminal), lastValue }
  Learner.prototype.prepare = function (traj) {
    var n = traj.n, g = this.opts.gamma, lam = this.opts.lambda, A = this.A;
    var adv = new Float32Array(n), ret = new Float32Array(n), last = 0, nextV = traj.done ? 0 : (traj.lastValue || 0);
    for (var t = n - 1; t >= 0; t--) {
      var delta = traj.rew[t] + g * nextV - traj.val[t];
      last = delta + g * lam * last;
      adv[t] = last; ret[t] = last + traj.val[t]; nextV = traj.val[t];
    }
    var mean = 0, sd = 0, i;
    for (i = 0; i < n; i++) mean += adv[i];
    mean /= n;
    for (i = 0; i < n; i++) sd += (adv[i] - mean) * (adv[i] - mean);
    sd = Math.sqrt(sd / n) + 1e-8;
    for (i = 0; i < n; i++) adv[i] = (adv[i] - mean) / sd;
    void A;
    return { n: n, obs: traj.obs, mask: traj.mask, act: traj.act, oldLogp: traj.logp, adv: adv, ret: ret };
  };

  // Sliceable PPO update. job.work(maxSamples) -> true when finished; job.result has the `learn` stats.
  Learner.prototype.makeUpdate = function (traj) {
    var self = this, batch = this.prepare(traj), n = batch.n, o = this.opts;
    var nmb = Math.max(1, Math.min(o.minibatches, n)), mbSize = Math.ceil(n / nmb);
    var idx = new Int32Array(n), i;
    for (i = 0; i < n; i++) idx[i] = i;
    var job = { done: false, result: null, epoch: 0, pos: 0, mbEnd: 0, nan: false, samples: 0 };
    var acc = null, epochKl = 0, epochN = 0, stopped = false;
    function shuffle() { for (var k = n - 1; k > 0; k--) { var j = Math.floor(self.rng() * (k + 1)), t = idx[k]; idx[k] = idx[j]; idx[j] = t; } }
    function newAcc() { return { policy: 0, value: 0, entropy: 0, kl: 0, clipped: 0, n: 0 }; }
    shuffle(); acc = newAcc();
    job.work = function (maxSamples) {
      if (job.done) return true;
      var budget = maxSamples > 0 ? maxSamples : n * o.epochs;
      while (budget > 0 && !job.done) {
        if (job.pos === job.mbEnd) { // start a minibatch
          job.mbEnd = Math.min(n, job.pos + mbSize);
          job.mbStart = job.pos;
          self.net.zeroGrad();
        }
        var to = Math.min(job.mbEnd, job.pos + budget);
        var s = self.lossAndGrad(batch, idx, job.pos, to, 1 / (job.mbEnd - job.mbStart), true);
        budget -= to - job.pos; job.samples += to - job.pos; job.pos = to;
        acc.policy += s.policy; acc.value += s.value; acc.entropy += s.entropy; acc.kl += s.kl; acc.clipped += s.clipped; acc.n += s.n;
        epochKl += s.kl; epochN += s.n;
        if (!isFinite(s.total)) { job.nan = true; finish(); break; }
        if (job.pos === job.mbEnd) {
          var norm = self.applyGradients();
          if (!isFinite(norm)) { job.nan = true; finish(); break; }
          if (job.pos >= n) { // epoch end
            job.epoch++;
            var kl = epochKl / Math.max(1, epochN); epochKl = 0; epochN = 0;
            if (job.epoch >= o.epochs || (o.targetKl > 0 && kl > 1.5 * o.targetKl)) { stopped = job.epoch < o.epochs; finish(); break; }
            job.pos = 0; job.mbEnd = 0; shuffle();
          }
        }
      }
      return job.done;
    };
    function finish() {
      job.done = true;
      var bad = job.nan;
      if (!bad) for (var q = 0; q < self.net.params.length && !bad; q++) { var w = self.net.params[q].w; for (var k = 0; k < w.length; k += 7) if (!isFinite(w[k])) { bad = true; break; } }
      if (bad) { job.result = self.recover(); return; }
      self.nanStreak = 0; self.updates++; self.lastGood = self.net.getWeights();
      var N = Math.max(1, acc.n);
      job.result = { updates: self.updates, policyLoss: acc.policy / N, valueLoss: acc.value / N, entropy: acc.entropy / N,
        approxKl: acc.kl / N, clipFrac: acc.clipped / N, lr: self.lr, epochs: job.epoch, earlyStop: stopped, samples: n };
    }
    return job;
  };
  Arena.Learner = Learner;

  // ------------------------------------------------------------------ Elo helpers
  function expected(r, ro) { return 1 / (1 + Math.pow(10, (ro - r) / 400)); }
  // Rating r that makes the expected score equal the actual score against opponents with FIXED ratings.
  // games: [{ r: oppRating, s: 0|0.5|1 }]. A virtual 0.5-weighted draw against each distinct opponent keeps it finite.
  function perfRating(games, prior) {
    var opps = {}, list = games.slice(), k;
    for (k = 0; k < games.length; k++) opps[games[k].r] = true;
    if (prior !== false) for (k in opps) list.push({ r: Number(k), s: 0.5, w: 0.5 });
    if (!list.length) return null;
    var lo = -1000, hi = 5000;
    for (var it = 0; it < 60; it++) {
      var mid = (lo + hi) / 2, f = 0;
      for (k = 0; k < list.length; k++) { var w = list[k].w || 1; f += w * (list[k].s - expected(mid, list[k].r)); }
      if (f > 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  // Standard error (Elo points) of a performance rating from the Fisher information.
  function perfSE(games, r) {
    var info = 0, c = Math.LN10 / 400;
    for (var k = 0; k < games.length; k++) { var e = expected(r, games[k].r); info += c * c * e * (1 - e); }
    return info > 0 ? 1 / Math.sqrt(info) : null;
  }
  // Fit ratings of several players with player 0 anchored at `anchor`. pairs: [{ i, j, s }] (s = score of i).
  function fitRatings(nPlayers, pairs, anchor) {
    var R = [], i, it, k;
    for (i = 0; i < nPlayers; i++) R.push(anchor);
    var all = pairs.slice();
    for (i = 0; i < nPlayers; i++) for (var j = i + 1; j < nPlayers; j++) all.push({ i: i, j: j, s: 0.5, w: 0.5 });
    for (it = 0; it < 2000; it++) {
      for (i = 1; i < nPlayers; i++) {
        var g = 0, h = 0;
        for (k = 0; k < all.length; k++) {
          var P = all[k], w = P.w || 1, e;
          if (P.i === i) { e = expected(R[i], R[P.j]); g += w * (P.s - e); h += w * e * (1 - e); }
          else if (P.j === i) { e = expected(R[i], R[P.i]); g += w * ((1 - P.s) - e); h += w * e * (1 - e); }
        }
        if (h > 0) R[i] += Math.max(-200, Math.min(200, (g / h) * 400 / Math.LN10));
      }
    }
    return R.map(function (x) { return Math.round(x * 10) / 10; });
  }
  Arena.elo = { expected: expected, perfRating: perfRating, perfSE: perfSE, fitRatings: fitRatings };

  // ------------------------------------------------------------------ Trajectory buffer
  function Traj(D, NA, cap) {
    this.D = D; this.NA = NA; this.cap = 0; this.n = 0; this.done = false; this.lastValue = 0;
    this._grow(cap || 600);
  }
  Traj.prototype._grow = function (cap) {
    var o = this;
    function g(Ctor, per, old) { var a = new Ctor(cap * per); if (old) a.set(old.subarray(0, o.n * per)); return a; }
    this.obs = g(Float32Array, this.D, this.obs); this.mask = g(Uint8Array, this.NA, this.mask);
    this.act = g(Int32Array, 1, this.act); this.logp = g(Float32Array, 1, this.logp);
    this.val = g(Float32Array, 1, this.val); this.rew = g(Float32Array, 1, this.rew);
    this.cap = cap;
  };
  Traj.prototype.push = function (obs, mask, a, logp, v) {
    if (this.n >= this.cap) this._grow(this.cap * 2);
    var n = this.n, D = this.D, NA = this.NA;
    this.obs.set(obs, n * D);
    if (mask) this.mask.set(mask, n * NA); else for (var k = 0; k < NA; k++) this.mask[n * NA + k] = 1;
    this.act[n] = a; this.logp[n] = logp; this.val[n] = v; this.rew[n] = 0;
    this.n++;
  };
  Traj.prototype.finish = function () { // compact copy for the update queue
    var n = this.n;
    return { n: n, obs: this.obs.slice(0, n * this.D), mask: this.mask.slice(0, n * this.NA), act: this.act.slice(0, n),
      logp: this.logp.slice(0, n), val: this.val.slice(0, n), rew: this.rew.slice(0, n), done: this.done, lastValue: this.lastValue };
  };
  Arena.Traj = Traj;

  // ------------------------------------------------------------------ Match
  // ctrls[i]: { kind:'learner', learner, record } | { kind:'policy', net } | { kind:'scripted', fn, level }
  function Match(sim, seed, ctrls, tag) {
    this.sim = sim; this.ctrls = ctrls; this.tag = tag || {};
    this.rng = makeRng(mixSeed(seed, 99));
    var r = sim.reset(seed);
    this.obs = r.obs; this.steps = 0; this.done = false; this.last = null; this.lastActions = [0, 0];
    this.totReward = [0, 0];
    this.trajs = [null, null];
    for (var i = 0; i < 2; i++) if (ctrls[i].kind === 'learner' && ctrls[i].record) this.trajs[i] = new Traj(ctrls[i].learner.obsDim, ctrls[i].learner.numActions, Math.round((sim.roundSeconds || 60) * (Arena.DECISION_HZ || 10)));
  }
  Match.prototype.step = function () {
    if (this.done) throw new Error('Match.step after done');
    var acts = [0, 0], sim = this.sim, i;
    for (i = 0; i < 2; i++) {
      var c = this.ctrls[i], mask = typeof sim.actionMask === 'function' ? sim.actionMask(i) : null;
      if (c.kind === 'scripted') acts[i] = c.fn(this.obs[i], mask) | 0;
      else {
        var net = c.kind === 'learner' ? c.learner.net : c.net, NA = net.NA;
        var p = net.forward(this.obs[i], 0, mask, 0);
        var a = c.greedy ? argmaxP(p, NA) : sampleFrom(p, NA, this.rng);
        acts[i] = a;
        if (this.trajs[i]) this.trajs[i].push(this.obs[i], mask, a, net.logp[a], net.value);
      }
    }
    var res = sim.step(acts[0], acts[1]);
    for (i = 0; i < 2; i++) {
      var rw = Number(res.reward[i]); if (!isFinite(rw)) rw = 0;
      this.totReward[i] += rw;
      if (this.trajs[i]) this.trajs[i].rew[this.trajs[i].n - 1] = rw;
    }
    this.obs = res.obs; this.steps++; this.last = res; this.lastActions = acts;
    if (res.done) {
      this.done = true;
      for (i = 0; i < 2; i++) if (this.trajs[i]) this.trajs[i].done = true;
    }
    return res;
  };
  Match.prototype.winner = function () { return this.last ? this.last.info.winner : -1; };
  Arena.Match = Match;

  // ------------------------------------------------------------------ Coach (league)
  var MILESTONES = [0, 100, 400, 1600, 6400, 25600, 102400];
  function Coach(opts) {
    opts = opts || {};
    if (typeof Arena.createSim !== 'function') throw new Error('Arena.Coach: no sim loaded (TKD.Arena.createSim missing)');
    var o = this.opts = {
      seed: (opts.seed == null ? 1 : opts.seed) >>> 0, roundSeconds: opts.roundSeconds || 60,
      learner: opts.learner || {}, snapshotEvery: opts.snapshotEvery || 20, poolMax: opts.poolMax || 8,
      eloEvery: opts.eloEvery || 25, benchGames: opts.benchGames || 4, benchWindow: opts.benchWindow || 3,
      pastGames: opts.pastGames || 2, mix: opts.mix || [0.5, 0.3, 0.2], calibGames: opts.calibGames || 16,
      unitSamples: opts.unitSamples || 32, maxQueue: opts.maxQueue || 8, unitSteps: opts.unitSteps || 16, benchmarks: opts.benchmarks !== false,
      liveBacklog: opts.liveBacklog || 1, benchUnitSteps: opts.benchUnitSteps || 64, selfWindow: opts.selfWindow || 20
    };
    o.queueCap = Math.max(1, Math.ceil(o.maxQueue / 2)); // per fighter
    this.obsDim = Arena.OBS_DIM; this.numActions = Arena.NUM_ACTIONS;
    if (!(this.obsDim > 0) || !(this.numActions > 1)) throw new Error('Arena.Coach: sim must export OBS_DIM and NUM_ACTIONS');
    this.on = opts.on || {};
    this._init(o.seed);
  }
  Coach.prototype._init = function (seed) {
    var o = this.opts;
    this.seed = seed;
    this.rng = makeRng(mixSeed(seed, 1));
    this.learners = [0, 1].map(function (f) {
      var lo = {}; for (var k in o.learner) lo[k] = o.learner[k];
      lo.seed = mixSeed(seed, 100 + f); lo.obsDim = Arena.OBS_DIM; lo.numActions = Arena.NUM_ACTIONS;
      return new Learner(lo);
    });
    this.pools = [[], []]; this.milestones = [[], []];
    this.rounds = 0; this.liveRounds = 0; this.practiceRounds = 0; this.benchGamesPlayed = 0;
    this.wins = [0, 0, 0]; this.learnRounds = [0, 0];
    this.queues = [[], []]; this.job = null; this.jobFighter = -1; this.lastJobFighter = 1; this.benchTurn = false;
    this.dropped = 0; this.droppedBy = [0, 0]; this.recentSelf = []; this.poolVer = 0; this.liveGated = 0; this.liveIsSelf = false;
    this.practice = null; this.practiceOn = true; this.liveSeq = 0; this.practiceSeq = 0;
    this.history = { rounds: [], elo: [] };
    this.anchors = null; this.calib = null; this.bench = null; this.benchIndex = 0; this.benchResults = [];
    this.nextElo = 0; this.steps = { live: 0, practice: 0, bench: 0 }; this.trainSamples = 0;
    this.live = null; this.trainSeconds = 0; this.fatal = null;
    this._takeMilestone();
  };
  Coach.prototype.paramCounts = function () { return [this.learners[0].paramCount(), this.learners[1].paramCount()]; };
  Coach.prototype.layers = function () { return this.learners[0].net.layers(); };
  Coach.prototype._emit = function (name, msg) { if (this.on[name]) this.on[name](msg); };
  Coach.prototype._newSim = function () { return Arena.createSim({ seed: this.seed, roundSeconds: this.opts.roundSeconds }); };

  Coach.prototype._takeMilestone = function () {
    for (var f = 0; f < 2; f++) {
      var ms = this.milestones[f];
      ms.push({ round: this.rounds, weights: this.learners[f].getWeights() });
      if (ms.length > 5) ms.splice(1, 1); // keep the round-0 brain plus the 4 newest milestones
      this._netCache = null;
    }
    this.poolVer = (this.poolVer || 0) + 1;
  };
  function policyNet(entry, D, NA) {
    if (!entry._net) { var w = entry.weights; entry._net = new Net({ obsDim: D, numActions: NA, hidden: w.hidden }); entry._net.setWeights(w); }
    return entry._net;
  }

  // ----- live match (the visible one); both current learners play and learn from it
  // Queued trajectories (both fighters) plus the update in progress.
  Coach.prototype.queueLength = function () { return this.queues[0].length + this.queues[1].length; };
  Coach.prototype.benchOverdue = function () { return !!(this.bench && this.rounds >= this.bench.rounds + this.opts.eloEvery); };
  // May a new 'fast' live round start now? Back-pressure so that live play never outruns PPO (nothing is dropped),
  // the scheduled Elo benchmark is never starved, and live self-play keeps to its league share (mix[0]) while practice is on.
  Coach.prototype.canStartLive = function () {
    if (this.fatal || this.benchOverdue()) return false;
    var b = this.opts.liveBacklog;
    if (this.queues[0].length > b || this.queues[1].length > b) return false;
    if (this.practiceOn && this.recentSelf.length >= 10) {
      var n = 0; for (var i = 0; i < this.recentSelf.length; i++) n += this.recentSelf[i];
      if (n / this.recentSelf.length > this.opts.mix[0] + 1e-9) return false;
    }
    return true;
  };
  // gated = true ('fast' speed): returns false instead of starting a new round when canStartLive() says no.
  Coach.prototype.liveStep = function (gated) {
    if (gated && (!this.live || this.live.done) && !this.canStartLive()) { this.liveGated++; return false; }
    if (!this.live || this.live.done) {
      this.liveSeq++;
      if (!this.liveSim) this.liveSim = this._newSim();
      this.live = new Match(this.liveSim, mixSeed(this.seed + 7, this.liveSeq + this.rounds * 3),
        [{ kind: 'learner', learner: this.learners[0], record: true }, { kind: 'learner', learner: this.learners[1], record: true }], { kind: 'self', live: true });
    }
    var res = this.live.step(); this.steps.live++;
    if (this.live.done) this._roundDone(this.live, true);
    return res;
  };
  Coach.prototype.liveState = function () {
    if (!this.live) return null;
    var st = this.liveSim.state(), A = Arena.ACTIONS || [];
    st.actions = [A[this.live.lastActions[0]] || String(this.live.lastActions[0]), A[this.live.lastActions[1]] || String(this.live.lastActions[1])];
    return st;
  };

  // ----- practice match selection (50% current vs current, 30% vs past snapshot, 20% vs scripted)
  Coach.prototype._newPractice = function () {
    this.practiceSeq++;
    if (!this.practiceSim) this.practiceSim = this._newSim();
    var u = this.rng(), mix = this.opts.mix, L = this.learners, ctrls, tag, f = this.rng() < 0.5 ? 0 : 1;
    var lag = (this.learnRounds[0] + this.queues[0].length) - (this.learnRounds[1] + this.queues[1].length);
    if (lag > 1) f = 1; else if (lag < -1) f = 0; // one-learner rounds go to the fighter that is behind on updates
    if (this.liveIsSelf) u = mix[0] + u * (1 - mix[0]); // 'fast': the live match is the self-play share, practice plays past/scripted
    var seed = mixSeed(this.seed + 13, this.practiceSeq);
    if (u < mix[0]) {
      ctrls = [{ kind: 'learner', learner: L[0], record: true }, { kind: 'learner', learner: L[1], record: true }]; tag = { kind: 'self' };
    } else if (u < mix[0] + mix[1] && this.pools[1 - f].length) {
      var pool = this.pools[1 - f], e = pool[Math.floor(this.rng() * pool.length)];
      ctrls = [null, null];
      ctrls[f] = { kind: 'learner', learner: L[f], record: true };
      ctrls[1 - f] = { kind: 'policy', net: policyNet(e, this.obsDim, this.numActions) };
      tag = { kind: 'past', learner: f, oppRound: e.round };
    } else {
      var lv = this.rng(), level = lv < 0.2 ? 0 : (lv < 0.6 ? 1 : 2);
      ctrls = [null, null];
      ctrls[f] = { kind: 'learner', learner: L[f], record: true };
      ctrls[1 - f] = { kind: 'scripted', fn: Arena.scripted(level, seed), level: level };
      tag = { kind: 'scripted', learner: f, level: level };
    }
    this.practice = new Match(this.practiceSim, seed, ctrls, tag);
  };

  Coach.prototype._roundDone = function (match, live) {
    var info = match.last.info, w = info.winner;
    this.rounds++;
    if (live) this.liveRounds++; else this.practiceRounds++;
    if (match.tag.kind === 'self') this.wins[w === 1 ? 0 : (w === 2 ? 1 : 2)]++;
    var msg = { round: this.rounds, live: !!live, winner: w, hits: info.hits.slice(), damage: [Math.round(info.damage[0] * 10) / 10, Math.round(info.damage[1] * 10) / 10],
      reward: [Math.round(match.totReward[0] * 1000) / 1000, Math.round(match.totReward[1] * 1000) / 1000], steps: match.steps, kind: match.tag.kind };
    if (match.tag.level != null) msg.level = match.tag.level;
    if (match.tag.learner != null) msg.learner = match.tag.learner;
    var hr = this.history.rounds;
    hr.push({ round: this.rounds, winner: w, hitsA: info.hits[0], hitsB: info.hits[1], live: !!live, kind: match.tag.kind });
    if (hr.length > 500) hr.splice(0, hr.length - 500);
    var fed = false;
    for (var i = 0; i < 2; i++) if (match.trajs[i] && match.trajs[i].n > 0) {
      fed = true;
      var qi = this.queues[i];
      qi.push({ fighter: i, traj: match.trajs[i].finish() });
      // per-fighter cap: an overflow only ever drops that fighter's own oldest trajectory, so neither side is starved
      while (qi.length > this.opts.queueCap) { qi.shift(); this.dropped++; this.droppedBy[i]++; }
    }
    if (fed) { this.recentSelf.push(match.tag.kind === 'self' ? 1 : 0); if (this.recentSelf.length > this.opts.selfWindow) this.recentSelf.shift(); }
    this._emit('round', msg);
    if (MILESTONES.indexOf(this.rounds) >= 0) this._takeMilestone();
    if (this.opts.benchmarks && this.rounds >= this.nextElo && !this.bench) this._scheduleBench();
  };

  // ----- benchmarks: fixed opponents only (scripted levels with ratings calibrated once, frozen milestones)
  Coach.prototype._scheduleBench = function () {
    this.nextElo = this.rounds + this.opts.eloEvery;
    var games = [], o = this.opts, set = this.benchIndex % o.benchWindow, f, L, g, m;
    if (!this.anchors) {
      for (var i = 0; i < 3; i++) for (var j = i + 1; j < 3; j++) for (g = 0; g < o.calibGames; g++)
        games.push({ calib: true, i: i, j: j, swap: g % 2 === 1, seed: mixSeed(31337, i * 1000 + j * 100 + g) });
    }
    for (f = 0; f < 2; f++) {
      for (L = 0; L < 3; L++) for (g = 0; g < o.benchGames; g++)
        games.push({ fighter: f, level: L, seed: mixSeed(5000 + L, set * o.benchGames + g) });
      var ms = this.milestones[f];
      for (m = 0; m < ms.length; m++) for (g = 0; g < o.pastGames; g++)
        games.push({ fighter: f, past: m, pastRound: ms[m].round, seed: mixSeed(9000 + m, set * o.pastGames + g) });
    }
    this.bench = { games: games, k: 0, match: null, results: [], rounds: this.rounds, index: this.benchIndex };
    this.benchIndex++;
  };
  Coach.prototype._benchMatch = function (gm) {
    if (!this.benchSim) this.benchSim = this._newSim();
    var ctrls;
    if (gm.calib) {
      var a = { kind: 'scripted', fn: Arena.scripted(gm.i, gm.seed) }, b = { kind: 'scripted', fn: Arena.scripted(gm.j, gm.seed + 1) };
      ctrls = gm.swap ? [b, a] : [a, b];
    } else {
      var f = gm.fighter, me = { kind: 'learner', learner: this.learners[f], record: false }, opp;
      if (gm.level != null) opp = { kind: 'scripted', fn: Arena.scripted(gm.level, gm.seed) };
      else opp = { kind: 'policy', net: policyNet(this.milestones[f][gm.past], this.obsDim, this.numActions) };
      ctrls = f === 0 ? [me, opp] : [opp, me]; // each fighter benchmarks from its own side
    }
    return new Match(this.benchSim, gm.seed, ctrls, { kind: 'bench' });
  };
  Coach.prototype._benchStep = function (nSteps) {
    var B = this.bench;
    for (var s = 0; s < nSteps && this.bench; s++) {
      var gm = B.games[B.k];
      if (!B.match) B.match = this._benchMatch(gm);
      B.match.step(); this.steps.bench++;
      if (B.match.done) {
        var w = B.match.winner(), sA = w === 1 ? 1 : (w === 2 ? 0 : 0.5);
        if (gm.calib) B.results.push({ calib: true, i: gm.swap ? gm.j : gm.i, j: gm.swap ? gm.i : gm.j, s: sA });
        else B.results.push({ fighter: gm.fighter, level: gm.level, past: gm.past, s: gm.fighter === 0 ? sA : 1 - sA });
        this.benchGamesPlayed++;
        B.match = null; B.k++;
        if (B.k >= B.games.length) this._benchDone();
      }
    }
  };
  Coach.prototype._benchDone = function () {
    var B = this.bench, k, r;
    this.bench = null;
    if (!this.anchors) {
      var pairs = [];
      for (k = 0; k < B.results.length; k++) { r = B.results[k]; if (r.calib) pairs.push({ i: r.i, j: r.j, s: r.s }); }
      this.anchors = fitRatings(3, pairs, 1000);
      this.calib = { games: pairs.length };
    }
    this.benchResults.push({ index: B.index, results: B.results.filter(function (x) { return !x.calib; }) });
    if (this.benchResults.length > this.opts.benchWindow) this.benchResults.shift();
    var all = []; for (k = 0; k < this.benchResults.length; k++) all = all.concat(this.benchResults[k].results);
    var out = { rounds: B.rounds, a: null, b: null, vsScripted: [[0, 0, 0], [0, 0, 0]], vsPast: [0, 0],
      games: { scripted: [[0, 0, 0], [0, 0, 0]], past: [0, 0] }, se: [null, null], anchors: this.anchors.slice(),
      trainSeconds: Math.round(this.trainSeconds), samples: this.trainSamples, at: Date.now() };
    for (var f = 0; f < 2; f++) {
      var games = [], sc = [0, 0, 0], ps = 0;
      for (k = 0; k < all.length; k++) {
        r = all[k]; if (r.fighter !== f) continue;
        if (r.level != null) { games.push({ r: this.anchors[r.level], s: r.s }); sc[r.level] += r.s; out.games.scripted[f][r.level]++; }
        else { ps += r.s; out.games.past[f]++; }
      }
      for (var L = 0; L < 3; L++) out.vsScripted[f][L] = out.games.scripted[f][L] ? Math.round(1000 * sc[L] / out.games.scripted[f][L]) / 1000 : null;
      out.vsPast[f] = out.games.past[f] ? Math.round(1000 * ps / out.games.past[f]) / 1000 : null;
      var R = perfRating(games), se = perfSE(games, R);
      out[f === 0 ? 'a' : 'b'] = Math.round(R);
      out.se[f] = se == null ? null : Math.round(se);
    }
    this.history.elo.push({ rounds: out.rounds, a: out.a, b: out.b, vsScripted: out.vsScripted, vsPast: out.vsPast, games: out.games, trainSeconds: out.trainSeconds, at: out.at });
    if (this.history.elo.length > 2000) { var keep = []; for (k = 0; k < this.history.elo.length; k++) if (k % 2 === 0 || k >= 1000) keep.push(this.history.elo[k]); this.history.elo = keep; }
    this._emit('elo', out);
  };

  Coach.prototype._snapshot = function (f) {
    var pool = this.pools[f];
    pool.push({ round: this.rounds, weights: this.learners[f].getWeights() });
    if (pool.length > this.opts.poolMax) pool.shift();
    this.poolVer++;
  };

  Coach.prototype._nanResult = function (f, r) {
    this._emit('nan', { fighter: f, lr: r.lr, lowered: r.lowered, streak: r.streak });
    if (r.streak >= 5 && !this.fatal) { this.fatal = 'PPO update for fighter ' + f + ' produced NaN 5 times in a row; learning stopped'; this._emit('fatal', { message: this.fatal }); }
  };
  function trajFinite(t) {
    for (var i = 0; i < t.n; i++) if (!isFinite(t.val[i]) || !isFinite(t.logp[i]) || !isFinite(t.rew[i])) return false;
    return true;
  }
  // Next trajectory to train on: the fighter with fewer finished updates goes first (ties alternate), so both
  // fighters get the same update budget at any speed.
  Coach.prototype._nextQueued = function () {
    var q0 = this.queues[0].length, q1 = this.queues[1].length, f;
    if (!q0 && !q1) return null;
    if (q0 && !q1) f = 0; else if (q1 && !q0) f = 1;
    else if (this.learnRounds[0] !== this.learnRounds[1]) f = this.learnRounds[0] < this.learnRounds[1] ? 0 : 1;
    else f = 1 - this.lastJobFighter;
    this.lastJobFighter = f;
    return this.queues[f].shift();
  };
  // One count-based unit of background work. Priority: pending PPO update > benchmark > practice, except that a
  // pending benchmark gets every other unit (benchUnitSteps sim steps) while PPO is busy, so Elo arrives on schedule
  // (every eloEvery rounds) even when the update queue never empties ('fast').
  // Returns 'update' | 'bench' | 'practice' | 'idle'.
  Coach.prototype.workUnit = function (practiceAllowed) {
    if (this.fatal) return 'idle';
    if (this.bench && (this.job || this.queues[0].length || this.queues[1].length)) {
      this.benchTurn = !this.benchTurn;
      if (this.benchTurn) { this._benchStep(this.opts.benchUnitSteps); return 'bench'; }
    }
    var q;
    while (!this.job && (q = this._nextQueued())) {
      if (!trajFinite(q.traj)) { // collected with broken weights: drop it, and repair the brain if it is the culprit
        this.dropped = (this.dropped || 0) + 1;
        var Lq = this.learners[q.fighter];
        if (!Lq.weightsFinite()) this._nanResult(q.fighter, Lq.recover());
        continue;
      }
      this.jobFighter = q.fighter; this.job = this.learners[q.fighter].makeUpdate(q.traj);
    }
    if (this.job) {
      var before = this.job.samples;
      var finished = this.job.work(this.opts.unitSamples);
      this.trainSamples += this.job.samples - before;
      if (finished) {
        var f = this.jobFighter, r = this.job.result; this.job = null;
        if (r.nan) this._nanResult(f, r);
        else {
          this.learnRounds[f]++;
          if (this.learnRounds[f] % this.opts.snapshotEvery === 0) this._snapshot(f);
          this._emit('learn', { fighter: f, updates: r.updates, policyLoss: r.policyLoss, valueLoss: r.valueLoss, entropy: r.entropy,
            approxKl: r.approxKl, clipFrac: r.clipFrac, lr: r.lr, epochs: r.epochs, earlyStop: r.earlyStop, samples: r.samples });
        }
      }
      return 'update';
    }
    if (this.bench) { this._benchStep(this.opts.unitSteps); return 'bench'; }
    if (practiceAllowed === false || !this.practiceOn) return 'idle';
    if (!this.practice || this.practice.done) this._newPractice();
    for (var s = 0; s < this.opts.unitSteps && !this.practice.done; s++) { this.practice.step(); this.steps.practice++; }
    if (this.practice.done) { var m = this.practice; this.practice = null; this._roundDone(m, false); }
    return 'practice';
  };

  function cap64(a) { var n = Math.min(64, a.length), r = new Float32Array(n); for (var i = 0; i < n; i++) r[i] = a[i]; return r; }
  // Per-layer activations of both fighters for the current live observation (for the 3D network view).
  Coach.prototype.viz = function (prev) {
    var obsPair = this.live ? this.live.obs : null, out = [], NA = this.numActions;
    var mask = [null, null];
    if (this.liveSim && typeof this.liveSim.actionMask === 'function' && this.live && !this.live.done) { mask[0] = this.liveSim.actionMask(0); mask[1] = this.liveSim.actionMask(1); }
    for (var f = 0; f < 2; f++) {
      var net = this.learners[f].net, obs = obsPair ? obsPair[f] : new Float32Array(this.obsDim);
      var p = net.forward(obs, 0, mask[f], 0);
      var probs = [], top = 0;
      for (var k = 0; k < NA; k++) { probs.push(p[k]); if (p[k] > p[top]) top = k; }
      var layerVals = [cap64(obs), cap64(net.h1), cap64(net.h2), cap64(p), new Float32Array([net.value])];
      var names = ['input', 'trunk1', 'trunk2', 'policy', 'value'];
      var wsets = [null, ['W1', 'b1'], ['W2', 'b2'], ['Wp', 'bp'], ['Wv', 'bv']];
      var layers = [];
      for (var L = 0; L < names.length; L++) {
        var wd = 0, wn = 0, cnt = 0;
        if (wsets[L]) {
          for (var q = 0; q < wsets[L].length; q++) {
            var w = net.byName[wsets[L][q]].w, key = f + ':' + wsets[L][q], old = prev && prev[key];
            for (var i = 0; i < w.length; i++) { wn += w[i] * w[i]; if (old) { var d = w[i] - old[i]; wd += d * d; } }
            cnt += w.length;
            if (prev) prev[key] = new Float32Array(w);
          }
        }
        layers.push({ name: names[L], activations: layerVals[L], weightDelta: cnt ? Math.sqrt(wd / cnt) : 0, weightNorm: cnt ? Math.sqrt(wn / cnt) : 0 });
      }
      out.push({ layers: layers, probs: probs, top: top, topName: (Arena.ACTIONS || [])[top], value: net.value });
    }
    return out;
  };

  // ----- persistence helpers (arena-store.js stores these records)
  Coach.prototype.exportBrains = function () {
    return { version: Arena.RL_VERSION, sim: Arena.SIM_NAME || 'arena-sim', obsDim: this.obsDim, numActions: this.numActions,
      hidden: this.learners[0].net.getWeights().hidden, a: this.learners[0].getWeights(), b: this.learners[1].getWeights(),
      lr: [this.learners[0].lr, this.learners[1].lr], updates: [this.learners[0].updates, this.learners[1].updates] };
  };
  Coach.prototype.exportPool = function () {
    function strip(list) { return list.map(function (e) { return { round: e.round, weights: e.weights }; }); }
    return { version: Arena.RL_VERSION, sim: Arena.SIM_NAME || 'arena-sim', obsDim: this.obsDim, numActions: this.numActions,
      a: strip(this.pools[0]), b: strip(this.pools[1]), milestonesA: strip(this.milestones[0]), milestonesB: strip(this.milestones[1]) };
  };
  Coach.prototype.exportMeta = function () {
    return { rounds: this.rounds, liveRounds: this.liveRounds, practiceRounds: this.practiceRounds, wins: this.wins.slice(),
      learnRounds: this.learnRounds.slice(), anchors: this.anchors, anchorsSim: Arena.SIM_NAME || 'arena-sim', benchIndex: this.benchIndex,
      benchResults: this.benchResults, nextElo: this.nextElo, trainSeconds: this.trainSeconds, trainSamples: this.trainSamples,
      liveSeq: this.liveSeq, practiceSeq: this.practiceSeq, dropped: this.dropped, droppedBy: this.droppedBy.slice() };
  };
  // Returns null if OK, else the reason the record was rejected (caller then discards stored brains).
  Coach.brainsProblem = function (rec) {
    if (!rec) return 'none';
    if (rec.version !== Arena.RL_VERSION) return 'version ' + rec.version + ' != ' + Arena.RL_VERSION;
    if (rec.sim !== (Arena.SIM_NAME || 'arena-sim')) return 'trained on sim ' + rec.sim + ', now ' + (Arena.SIM_NAME || 'arena-sim');
    if (rec.obsDim !== Arena.OBS_DIM || rec.numActions !== Arena.NUM_ACTIONS) return 'shape ' + rec.obsDim + 'x' + rec.numActions + ' != ' + Arena.OBS_DIM + 'x' + Arena.NUM_ACTIONS;
    var e = Net.checkWeights(rec.a, Arena.OBS_DIM, Arena.NUM_ACTIONS, null) || Net.checkWeights(rec.b, Arena.OBS_DIM, Arena.NUM_ACTIONS, null);
    return e;
  };
  // Restore saved state. Throws on any mismatch (caller falls back to fresh brains).
  Coach.prototype.restore = function (brains, pool, meta, history) {
    var p = Coach.brainsProblem(brains);
    if (p) throw new Error('brains rejected: ' + p);
    this.learners[0].setWeights(brains.a); this.learners[1].setWeights(brains.b);
    if (brains.lr) { this.learners[0].lr = brains.lr[0]; this.learners[1].lr = brains.lr[1]; }
    if (brains.updates) { this.learners[0].updates = brains.updates[0] | 0; this.learners[1].updates = brains.updates[1] | 0; }
    var self = this;
    function okList(list) {
      if (!list || !list.length) return [];
      return list.filter(function (e) { return e && e.weights && !Net.checkWeights(e.weights, self.obsDim, self.numActions, null); })
        .map(function (e) { return { round: e.round, weights: e.weights }; });
    }
    if (pool && pool.version === Arena.RL_VERSION && pool.sim === (Arena.SIM_NAME || 'arena-sim') && pool.obsDim === this.obsDim && pool.numActions === this.numActions) {
      this.pools = [okList(pool.a).slice(-this.opts.poolMax), okList(pool.b).slice(-this.opts.poolMax)];
      var mA = okList(pool.milestonesA), mB = okList(pool.milestonesB);
      if (mA.length && mB.length) this.milestones = [mA, mB];
      else this.milestones = [[{ round: meta ? meta.rounds | 0 : 0, weights: brains.a }], [{ round: meta ? meta.rounds | 0 : 0, weights: brains.b }]];
    } else this.milestones = [[{ round: meta ? meta.rounds | 0 : 0, weights: brains.a }], [{ round: meta ? meta.rounds | 0 : 0, weights: brains.b }]];
    if (meta) {
      this.rounds = meta.rounds | 0; this.liveRounds = meta.liveRounds | 0; this.practiceRounds = meta.practiceRounds | 0;
      if (meta.wins && meta.wins.length === 3) this.wins = meta.wins.slice();
      if (meta.learnRounds && meta.learnRounds.length === 2) this.learnRounds = meta.learnRounds.slice();
      if (meta.anchors && meta.anchors.length === 3 && meta.anchorsSim === (Arena.SIM_NAME || 'arena-sim')) this.anchors = meta.anchors.slice();
      if (this.anchors && meta.benchResults) this.benchResults = meta.benchResults;
      this.benchIndex = meta.benchIndex | 0; this.nextElo = meta.nextElo || this.rounds;
      this.trainSeconds = meta.trainSeconds || 0; this.trainSamples = meta.trainSamples || 0;
      this.liveSeq = meta.liveSeq | 0; this.practiceSeq = meta.practiceSeq | 0;
      this.dropped = meta.dropped | 0; if (meta.droppedBy && meta.droppedBy.length === 2) this.droppedBy = [meta.droppedBy[0] | 0, meta.droppedBy[1] | 0];
    }
    if (history && history.rounds && history.elo) this.history = { rounds: history.rounds.slice(-500), elo: history.elo.slice() };
  };
  Arena.Coach = Coach;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));

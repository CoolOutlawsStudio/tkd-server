// Remote persistence for the arena server. Backends (picked by env, see README):
//   supabase : SUPABASE_URL + SUPABASE_ANON_KEY + SERVER_SECRET -> RPCs arena_save / arena_load / arena_clear
//              (supabase_arena_server.sql). Anon key + secret only, never the service_role key.
//   file     : DATA_DIR (a persistent disk, e.g. the box) -> DATA_DIR/arena-<kind>-<generation>.json
//   memory   : nothing configured -> brains live only in this process (said so in /state and `hello`).
// Records are the exact arena-store.js records. kind 'state' = {brains, history, meta}; kind 'pool' = {pool}.
// Every blob carries a generation (monotonic), sha256 (checked on load; SQL also checks it on save), and the newest
// 2 generations per kind are kept. Load falls back to the older generation if the newest fails its checks.
'use strict';
const fs = require('fs'), path = require('path');
const codec = require('./codec');

function supabaseBackend(o) {
  const base = o.url.replace(/\/+$/, '') + '/rest/v1/rpc/';
  const f = o.fetch || fetch;
  async function rpc(name, body, timeoutMs) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs || 20000);
    try {
      const res = await f(base + name, { method: 'POST', signal: ac.signal,
        headers: { apikey: o.anonKey, Authorization: 'Bearer ' + o.anonKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.assign({ p_secret: o.secret }, body)) });
      const text = await res.text();
      let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
      if (!res.ok) { const msg = (j && (j.message || j.error)) || text.slice(0, 200) || ('HTTP ' + res.status); const e = new Error(name + ': ' + msg); e.status = res.status; e.code = (/ARS\d{3}/.exec(msg) || [])[0] || null; throw e; }
      return j;
    } finally { clearTimeout(t); }
  }
  return {
    name: 'supabase', where: o.url.replace(/^https?:\/\//, '').split('/')[0],
    async list() { return (await rpc('arena_load', {}, 30000)) || []; },
    async put(kind, generation, enc, meta, timeoutMs) {
      return rpc('arena_save', { p_kind: kind, p_generation: generation, p_sha256: enc.sha256, p_payload: enc.payload, p_meta: meta }, timeoutMs);
    },
    async clear() { return rpc('arena_clear', {}); }
  };
}

function fileBackend(o) {
  const dir = o.dir;
  fs.mkdirSync(dir, { recursive: true });
  const re = /^arena-(state|pool)-(\d+)\.json$/;
  function files() { return fs.readdirSync(dir).map((n) => { const m = re.exec(n); return m ? { name: n, kind: m[1], generation: Number(m[2]) } : null; }).filter(Boolean); }
  return {
    name: 'file', where: dir,
    async list() {
      return files().sort((a, b) => b.generation - a.generation).map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f.name), 'utf8')); } catch (e) { return { kind: f.kind, generation: f.generation, payload: null, sha256: null, broken: e.message }; }
      });
    },
    async put(kind, generation, enc, meta) {
      const max = files().filter((f) => f.kind === kind).reduce((m, f) => Math.max(m, f.generation), 0);
      if (generation <= max) { const e = new Error('ARS409: generation ' + generation + ' is not newer than stored ' + max); e.code = 'ARS409'; throw e; }
      const rec = { kind, generation, sha256: enc.sha256, bytes: enc.bytes, payload: enc.payload, meta, saved_at: new Date().toISOString() };
      const final = path.join(dir, 'arena-' + kind + '-' + generation + '.json'), tmp = final + '.tmp';
      const fd = fs.openSync(tmp, 'w'); fs.writeSync(fd, JSON.stringify(rec)); fs.fsyncSync(fd); fs.closeSync(fd);
      fs.renameSync(tmp, final); // atomic
      const mine = files().filter((f) => f.kind === kind).sort((a, b) => b.generation - a.generation);
      mine.slice(2).forEach((f) => { try { fs.unlinkSync(path.join(dir, f.name)); } catch (e) { /* ignore */ } });
      return { kind, generation, bytes: enc.bytes, sha256: enc.sha256 };
    },
    async clear() { const fl = files(); fl.forEach((f) => fs.unlinkSync(path.join(dir, f.name))); return fl.length; }
  };
}

function createPersistence(env, opts) {
  opts = opts || {};
  let backend = null, reason = null;
  const anyS = env.SUPABASE_URL || env.SUPABASE_ANON_KEY || env.SERVER_SECRET;
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SERVER_SECRET) {
    if (env.SERVER_SECRET.length < 32) reason = 'SERVER_SECRET is shorter than 32 characters: persistence disabled';
    else if (/service_role/.test(decodeJwtRole(env.SUPABASE_ANON_KEY) || '') || /^sb_secret_/.test(env.SUPABASE_ANON_KEY)) reason = 'SUPABASE_ANON_KEY is a service_role / secret key: refused, use the anon (or sb_publishable_) key';
    else backend = supabaseBackend({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, secret: env.SERVER_SECRET, fetch: opts.fetch });
  } else if (anyS) reason = 'SUPABASE_URL, SUPABASE_ANON_KEY and SERVER_SECRET must all be set: persistence disabled';
  if (!backend && !reason && env.DATA_DIR) backend = fileBackend({ dir: env.DATA_DIR });
  if (!backend && !reason) reason = 'no persistence configured (memory only): brains are lost on restart';

  const P = {
    mode: backend ? backend.name : 'memory', where: backend ? backend.where : null, reason,
    generation: { state: 0, pool: 0 }, resets: 0,
    last: { loadedAt: null, loadedGeneration: null, savedAt: null, savedGeneration: null, bytes: null, poolBytes: null, poolSavedAt: null, error: null, errorAt: null, saves: 0, failures: 0, fallbacks: 0 }
  };

  // -> { kv: {brains, pool, history, meta} | null, resets, info }
  P.load = async function () {
    if (!backend) return { kv: null, resets: 0, info: 'memory' };
    const rows = await backend.list();
    const kv = {}, info = [];
    for (const kind of ['state', 'pool']) {
      const mine = rows.filter((r) => r.kind === kind).sort((a, b) => b.generation - a.generation);
      if (mine.length) P.generation[kind] = Math.max(P.generation[kind], Number(mine[0].generation) || 0);
      for (let i = 0; i < mine.length; i++) {
        const r = mine[i];
        try {
          const rec = codec.decode(r.payload, r.sha256);
          if (!rec || rec.format !== codec.FORMAT || rec.kind !== kind) throw new Error('not a ' + kind + ' record');
          if (kind === 'state') {
            kv.brains = rec.records.brains || null; kv.history = rec.records.history || null; kv.meta = rec.records.meta || null;
            P.resets = (rec.server && rec.server.resets) | 0;
            P.last.loadedGeneration = Number(r.generation);
          } else kv.pool = rec.records.pool || null;
          info.push(kind + ' gen ' + r.generation + (i ? ' (fallback: newer one failed)' : '') + ' ' + r.bytes + ' B');
          if (i) P.last.fallbacks++;
          break;
        } catch (e) { info.push(kind + ' gen ' + r.generation + ' rejected: ' + e.message); }
      }
    }
    P.last.loadedAt = Date.now();
    const any = kv.brains || kv.meta || kv.history || kv.pool;
    return { kv: any ? kv : null, resets: P.resets, info: info.join('; ') || 'nothing stored yet' };
  };

  // kv = latest records; withPool: also upload the pool. Returns {bytes, poolBytes, generation} or throws.
  // put with one generation resync: if another instance (e.g. the old one during a Render zero-downtime deploy) wrote a
  // newer generation, adopt the stored max and retry once instead of failing every later save forever.
  async function putResync(kind, enc, meta, timeoutMs) {
    for (let attempt = 0; ; attempt++) {
      const g = P.generation[kind] + 1;
      try { await backend.put(kind, g, enc, meta, timeoutMs); P.generation[kind] = g; return g; } catch (e) {
        const m = e.code === 'ARS409' && /stored (\d+)/.exec(e.message || '');
        if (!m || attempt > 0) throw e;
        P.last.conflicts = (P.last.conflicts || 0) + 1;
        P.generation[kind] = Math.max(P.generation[kind], Number(m[1]));
      }
    }
  }

  // kv = latest records; withPool: also upload the pool. Returns {bytes, poolBytes, generation} or throws.
  P.save = async function (kv, o) {
    o = o || {};
    if (!backend) return null;
    const meta = Object.assign({ resets: P.resets }, o.meta || {});
    const res = { generation: null, bytes: 0, poolBytes: 0 };
    try {
      const st = codec.encode({ format: codec.FORMAT, kind: 'state', server: meta, records: { brains: kv.brains || null, history: kv.history || null, meta: kv.meta || null } });
      const g = await putResync('state', st, meta, o.timeoutMs);
      res.generation = g; res.bytes = st.bytes;
      if (o.withPool && kv.pool) {
        const pl = codec.encode({ format: codec.FORMAT, kind: 'pool', server: meta, records: { pool: kv.pool } });
        await putResync('pool', pl, meta, o.timeoutMs);
        res.poolBytes = pl.bytes; P.last.poolSavedAt = Date.now(); P.last.poolBytes = pl.bytes;
      }
      P.last.saves++; P.last.savedAt = Date.now(); P.last.savedGeneration = g; P.last.bytes = st.bytes; P.last.error = null;
      return res;
    } catch (e) {
      P.last.failures++; P.last.error = e.message; P.last.errorAt = Date.now();
      throw e;
    }
  };

  P.clear = async function () {
    P.resets++;
    if (!backend) return 0;
    return backend.clear();
  };
  P.state = function () {
    return { mode: P.mode, where: P.where, note: P.reason, generation: P.generation.state, poolGeneration: P.generation.pool,
      savedAt: iso(P.last.savedAt), bytes: P.last.bytes, poolSavedAt: iso(P.last.poolSavedAt), poolBytes: P.last.poolBytes,
      loadedAt: iso(P.last.loadedAt), loadedGeneration: P.last.loadedGeneration, saves: P.last.saves, failures: P.last.failures,
      lastError: P.last.error, lastErrorAt: iso(P.last.errorAt), fallbacks: P.last.fallbacks, conflicts: P.last.conflicts || 0 };
  };
  return P;
}
function iso(t) { return t ? new Date(t).toISOString() : null; }
function decodeJwtRole(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')).role || null; } catch (e) { return null; }
}
module.exports = { createPersistence };

// In-memory IndexedDB stand-in for the server copy of arena-store.js (which runs UNCHANGED). Async like the real API,
// values structured-cloned on put and get. Every committed write is reported through hooks.onPut(key, value) /
// hooks.onDelete(key) so the main thread always holds the latest records and can upload them on its own schedule.
'use strict';
function makeFactory(seed, hooks) {
  hooks = hooks || {};
  const later = (fn) => setImmediate(fn);
  const dbs = new Map();
  function makeDB(name, rec) {
    return {
      name, version: rec.version,
      objectStoreNames: { contains: (s) => rec.stores.has(s) },
      createObjectStore: (s) => { if (!rec.stores.has(s)) rec.stores.set(s, new Map()); return {}; },
      close() {},
      transaction(sname, mode) {
        if (!rec.stores.has(sname)) throw new Error('NotFoundError');
        const data = rec.stores.get(sname), tx = {}, ops = [];
        let scheduled = false;
        function run() {
          // apply all ops of this transaction atomically, then fire request callbacks, then complete
          const results = [];
          for (const op of ops) {
            if (op.kind === 'get') results.push(data.has(op.k) ? structuredClone(data.get(op.k)) : undefined);
            else if (op.kind === 'put') { data.set(op.k, op.v); results.push(op.k); if (hooks.onPut) hooks.onPut(op.k, op.v); }
            else { data.delete(op.k); results.push(undefined); if (hooks.onDelete) hooks.onDelete(op.k); }
          }
          ops.forEach((op, i) => { op.r.result = results[i]; if (op.r.onsuccess) op.r.onsuccess({ target: op.r }); });
          later(() => { if (tx.oncomplete) tx.oncomplete({}); });
        }
        function req(kind, k, v) {
          const r = {}; ops.push({ kind, k, v, r });
          if (!scheduled) { scheduled = true; later(run); }
          return r;
        }
        tx.commit = function () {};
        tx.objectStore = () => ({
          get: (k) => req('get', k),
          put: (v, k) => { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); return req('put', k, structuredClone(v)); },
          'delete': (k) => { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); return req('del', k); }
        });
        return tx;
      }
    };
  }
  return {
    open(name, version) {
      const r = {};
      later(() => {
        let rec = dbs.get(name), upgrade = false;
        if (!rec) {
          rec = { version, stores: new Map() }; dbs.set(name, rec); upgrade = true;
        }
        r.result = makeDB(name, rec);
        if (upgrade && r.onupgradeneeded) r.onupgradeneeded({ target: r });
        if (upgrade && seed) { // pre-load the records restored from persistence into store 'kv'
          const kv = rec.stores.get('kv') || new Map(); rec.stores.set('kv', kv);
          for (const k of Object.keys(seed)) if (seed[k] != null) kv.set(k, seed[k]);
        }
        if (r.onsuccess) r.onsuccess({ target: r });
      });
      return r;
    }
  };
}
module.exports = { makeFactory };

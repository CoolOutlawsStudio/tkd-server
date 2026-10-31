/* TKD-Net arena-store.js (owner: Moneyman) -- IndexedDB persistence for the Arena (ARENA-CONTRACT.md section 4).
 * DB 'tkd-arena', object store 'kv', keys: 'brains', 'pool', 'history', 'meta'. Typed arrays are stored by structured
 * clone (not JSON). Works in a Web Worker and in a page.
 * Every call FAILS SOFT like ../store.js: if IndexedDB is missing, blocked (private mode), hangs (Safari) or errors,
 * calls resolve null (or false for writes) and TKD.Arena.store.available is false. Nothing ever rejects.
 *   open()                      -> db | null
 *   saveAll({brains,pool,history,meta}) -> { bytes, at } | null   (one readwrite transaction: all or nothing; keys that
 *                               are null/absent are left as stored, e.g. the pool is only written when it changed)
 *   loadAll(problemFn)          -> { brains, pool, history, meta, discarded } | null
 *        problemFn(brains) returns null if usable, else a reason; then brains+pool+history are DELETED and
 *        returned as null (version / shape / sim mismatch). Without problemFn (page side) nothing is deleted.
 *   loadHistory(), loadMeta()   -> record | null      (page side: charts before the worker is up)
 *   incrementSessions()         -> meta | null
 *   clear()                     -> true | null        (deletes brains, pool, history and training counters; keeps sessions)
 */
(function (root) {
  'use strict';
  var TKD = root.TKD = root.TKD || {};
  var Arena = TKD.Arena = TKD.Arena || {};
  var DB_NAME = 'tkd-arena', STORE = 'kv', DB_VERSION = 1;
  var store = { available: false, DB_NAME: DB_NAME, STORE_NAME: STORE, timeoutMs: 4000, _db: null, _opening: null };

  function getFactory() { try { return root.indexedDB || null; } catch (e) { return null; } }

  store.open = function () {
    if (store._opening) return store._opening;
    store._opening = new Promise(function (resolve) {
      var done = false, timer = null;
      function finish(db) {
        if (done) { if (db) { try { db.close(); } catch (e) {} } return; }
        done = true; if (timer) clearTimeout(timer);
        store._db = db || null; store.available = !!db; resolve(store._db);
      }
      var f = getFactory();
      if (!f) { finish(null); return; }
      timer = setTimeout(function () { finish(null); }, store.timeoutMs);
      try {
        var req = f.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () { try { var db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); } catch (e) {} };
        req.onsuccess = function () {
          var db = req.result;
          try { db.onversionchange = function () { try { db.close(); } catch (e) {} store._db = null; store.available = false; store._opening = null; }; } catch (e) {}
          finish(db);
        };
        req.onerror = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); finish(null); };
        req.onblocked = function () {};
      } catch (e) { finish(null); }
    });
    return store._opening;
  };

  function tx(mode, fn) {
    return store.open().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var result = null, settled = false;
        function done(v) { if (!settled) { settled = true; resolve(v); } }
        try {
          var t = db.transaction(STORE, mode), os = t.objectStore(STORE);
          fn(os, function (v) { result = v; });
          // Commit a write at once instead of waiting for the event loop to go idle: the pagehide flush must land
          // before the page stops the worker (Chrome 76+, Safari 15+; older browsers auto-commit as before).
          if (mode === 'readwrite' && typeof t.commit === 'function') { try { t.commit(); } catch (e) {} }
          t.oncomplete = function () { done(result); };
          t.onerror = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); done(null); };
          t.onabort = function () { done(null); };
        } catch (e) { done(null); }
      });
    }, function () { return null; }).catch(function () { return null; });
  }
  function getMany(keys) {
    return tx('readonly', function (os, set) {
      var out = {}, left = keys.length;
      keys.forEach(function (k) {
        var r = os.get(k);
        r.onsuccess = function () { out[k] = r.result === undefined ? null : r.result; if (--left === 0) set(out); };
      });
    });
  }
  function putMany(obj) {
    return tx('readwrite', function (os, set) { for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) os.put(obj[k], k); set(true); })
      .then(function (v) { return v === true; });
  }
  function delMany(keys) {
    return tx('readwrite', function (os, set) { keys.forEach(function (k) { os['delete'](k); }); set(true); }).then(function (v) { return v === true; });
  }

  function bytesOf(v, depth) {
    if (!v || depth > 6) return 0;
    if (typeof v.byteLength === 'number' && typeof v.BYTES_PER_ELEMENT === 'number') return v.byteLength;
    if (typeof v !== 'object') return 0;
    var b = 0;
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) b += bytesOf(v[k], (depth || 0) + 1);
    return b;
  }
  store.bytesOf = function (v) { return bytesOf(v, 0); };

  store.saveAll = function (rec) {
    var at = Date.now(), put = {};
    ['brains', 'pool', 'history', 'meta'].forEach(function (k) { if (rec && rec[k] != null) put[k] = rec[k]; });
    if (put.brains) put.brains.savedAt = at;
    return putMany(put).then(function (ok) { return ok ? { bytes: bytesOf(put.brains, 0) + bytesOf(put.pool, 0), at: at } : null; }, function () { return null; });
  };

  store.loadAll = function (problemFn) {
    return getMany(['brains', 'pool', 'history', 'meta']).then(function (r) {
      if (!r) return null;
      var out = { brains: r.brains, pool: r.pool, history: r.history, meta: r.meta, discarded: null };
      if (out.brains && typeof problemFn === 'function') {
        var p = null;
        try { p = problemFn(out.brains); } catch (e) { p = 'check threw: ' + (e && e.message); }
        if (p) {
          out.discarded = p; out.brains = null; out.pool = null; out.history = null;
          return delMany(['brains', 'pool', 'history']).then(function () { return out; });
        }
      }
      return out;
    }, function () { return null; }).catch(function () { return null; });
  };
  store.loadHistory = function () { return getMany(['history']).then(function (r) { return r ? r.history : null; }); };
  store.loadMeta = function () { return getMany(['meta']).then(function (r) { return r ? r.meta : null; }); };

  store.incrementSessions = function () {
    return store.loadMeta().then(function (m) {
      if (!store.available) return null;
      var now = Date.now();
      m = m || { sessions: 0, firstSeen: now };
      m.sessions = (m.sessions || 0) + 1; m.lastSeen = now;
      return putMany({ meta: m }).then(function (ok) { return ok ? m : null; });
    }).catch(function () { return null; });
  };

  store.clear = function () {
    return store.open().then(function (db) {
      if (!db) return null;
      return store.loadMeta().then(function (m) {
        var keep = m ? { sessions: m.sessions || 0, firstSeen: m.firstSeen, lastSeen: m.lastSeen } : null;
        return delMany(['brains', 'pool', 'history']).then(function (ok) {
          if (!keep) return ok;
          return putMany({ meta: keep }).then(function (ok2) { return ok && ok2; });
        });
      });
    }).catch(function () { return null; });
  };

  Arena.store = store;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));

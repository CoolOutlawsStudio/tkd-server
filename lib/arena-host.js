// Worker-thread entry. Runs the UNCHANGED browser worker vendor/arena-worker.js (which importScripts
// ../arena-sim.js, arena-rl.js and arena-store.js) inside a shim that looks like a classic Web Worker global:
// self, postMessage, onmessage, importScripts, setTimeout/clearTimeout, performance.now, structuredClone, indexedDB.
// indexedDB is lib/mem-idb.js, seeded with the records restored by the main thread; every committed write is posted
// to the main thread ('__kv' / '__kvdel'), which owns remote persistence. Training never runs on the main thread,
// so WebSocket I/O is never delayed by a training slice.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm'), fs = require('fs'), path = require('path'), v8 = require('v8');
const { makeFactory } = require('./mem-idb');

const VENDOR = workerData.vendorDir;
// importScripts name (as requested by arena-worker.js, relative to arena/) -> vendor file
const MAP = { '../arena-sim.js': 'arena-sim.js', 'arena-rl.js': 'arena-rl.js', 'arena-store.js': 'arena-store.js' };

const ctx = {
  console, setTimeout, clearTimeout,
  performance: { now: () => performance.now() },
  structuredClone, Promise, Date, Math
};
ctx.self = ctx;
ctx.indexedDB = makeFactory(workerData.seedKv || null, {
  onPut: (k, v) => parentPort.postMessage({ type: '__kv', key: k, value: v }),
  onDelete: (k) => parentPort.postMessage({ type: '__kvdel', key: k })
});
ctx.postMessage = (m) => parentPort.postMessage(m); // structured clone, like a real worker
ctx.importScripts = function () {
  for (let i = 0; i < arguments.length; i++) {
    const name = arguments[i];
    const file = Object.prototype.hasOwnProperty.call(MAP, name) ? path.join(VENDOR, MAP[name]) : null;
    if (!file || !fs.existsSync(file)) throw new Error('NetworkError: failed to load ' + name);
    run(file, name);
  }
};
function run(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const fn = vm.runInThisContext('(function (self, importScripts, postMessage, window, globalThis, indexedDB) {' + src + '\n})', { filename: name });
  fn.call(ctx, ctx, ctx.importScripts, ctx.postMessage, undefined, ctx, ctx.indexedDB);
}
run(path.join(VENDOR, 'arena-worker.js'), 'arena-worker.js');

parentPort.on('message', (m) => {
  if (!m || typeof m.type !== 'string') return;
  if (m.type === '__mem') {
    const h = v8.getHeapStatistics();
    parentPort.postMessage({ type: '__mem', heapUsed: h.used_heap_size, heapTotal: h.total_heap_size });
    return;
  }
  if (typeof ctx.onmessage === 'function') ctx.onmessage({ data: m });
});
parentPort.postMessage({ type: '__booted', load: ctx.__arenaLoad || null, rlVersion: (ctx.TKD && ctx.TKD.Arena && ctx.TKD.Arena.RL_VERSION) || null, simName: (ctx.TKD && ctx.TKD.Arena && ctx.TKD.Arena.SIM_NAME) || null });

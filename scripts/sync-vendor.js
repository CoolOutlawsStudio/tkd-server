#!/usr/bin/env node
// Refreshes vendor/ from the live source of truth so the server never runs a drifting fork.
//   node scripts/sync-vendor.js           copy + write vendor/SHAS.json
//   node scripts/sync-vendor.js --check   exit 1 if any vendor file differs from the source (no copy)
// Source dir: $TKD_NET_DIR or /workspace/tkd-net. vendor/ is a byte-identical copy; never edit it by hand.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const SRC = process.env.TKD_NET_DIR || '/workspace/tkd-net';
const VENDOR = path.join(__dirname, '..', 'vendor');
// vendor name -> path in tkd-net (owner)
const FILES = {
  'arena-sim.js': 'arena-sim.js',              // Waffle
  'arena-rl.js': 'arena/arena-rl.js',          // Moneyman
  'arena-worker.js': 'arena/arena-worker.js',  // Moneyman
  'arena-store.js': 'arena/arena-store.js'     // Moneyman
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const check = process.argv.includes('--check');
let drift = 0; const out = {};
for (const [name, rel] of Object.entries(FILES)) {
  const src = path.join(SRC, rel), dst = path.join(VENDOR, name);
  if (!fs.existsSync(src)) { console.error('missing source ' + src); process.exitCode = 1; continue; }
  const sb = fs.readFileSync(src), db = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  const same = db && sha(db) === sha(sb);
  if (!same) drift++;
  if (check) { console.log((same ? 'same   ' : 'DRIFT  ') + name + ' ' + sha(sb).slice(0, 8) + (db ? ' (vendor ' + sha(db).slice(0, 8) + ')' : ' (vendor missing)')); continue; }
  fs.mkdirSync(VENDOR, { recursive: true });
  if (!same) fs.writeFileSync(dst, sb);
  out[name] = { sha256: sha(sb), sha8: sha(sb).slice(0, 8), bytes: sb.length, from: rel };
  console.log((same ? 'unchanged ' : 'copied    ') + name + ' ' + sha(sb).slice(0, 8) + ' ' + sb.length + ' B');
}
if (check) { if (drift) { console.log(drift + ' file(s) drifted: run npm run sync'); process.exitCode = 1; } else console.log('vendor/ matches ' + SRC); }
else fs.writeFileSync(path.join(VENDOR, 'SHAS.json'), JSON.stringify({ source: SRC, syncedAt: new Date().toISOString(), files: out }, null, 2) + '\n');

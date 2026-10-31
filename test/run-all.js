// npm test: stream contract + persistence (fake Supabase). Throughput/soak are separate (they take minutes):
//   node test/test-viewers.js     PHASE_S=60 (0 vs 5 viewers)      node test/soak.js 20 [CPU_LIMIT=0.5]
//   cd test/sql && npm i && node sqltest.mjs   (supabase_arena_server.sql on PGlite)
'use strict';
const { spawnSync } = require('child_process'), path = require('path');
let failed = 0;
for (const t of ['test-stream.js', 'test-persist.js', 'test-file-and-limits.js']) {
  console.log('=== ' + t);
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
const v = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'sync-vendor.js'), '--check'], { stdio: 'inherit' });
if (v.status !== 0) failed++;
console.log(failed ? 'SOME SERVER TESTS FAILED' : 'ALL SERVER TESTS PASSED');
process.exit(failed ? 1 : 0);

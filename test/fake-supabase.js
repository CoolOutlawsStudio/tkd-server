// Tiny stand-in for the Supabase REST RPC endpoints of supabase_arena_server.sql (same rules: anon apikey required,
// secret checked against a stored sha256, payload sha256 checked, generations must increase, newest 2 kept per kind).
// Usage: const fake = await startFake({ secretSha256 }); fake.url; fake.rows; fake.close()
'use strict';
const http = require('http'), crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function startFake(o) {
  o = o || {};
  const rows = []; // {kind, generation, sha256, bytes, payload, meta, saved_at}
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => setTimeout(handle, o.delayMs || 0));
    function handle() {
      const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b); };
      const m = /^\/rest\/v1\/rpc\/(arena_save|arena_load|arena_clear)$/.exec(req.url);
      calls.push({ fn: m && m[1], bytes: body.length, at: Date.now() });
      if (!m) return send(404, { message: 'not found' });
      if (!req.headers.apikey || req.headers.apikey !== o.anonKey) return send(401, { message: 'Invalid API key' });
      if (o.failNext) { o.failNext--; return send(503, { message: 'upstream unavailable (injected)' }); }
      let a; try { a = JSON.parse(body); } catch (e) { return send(400, { message: 'bad json' }); }
      if (!(typeof a.p_secret === 'string' && a.p_secret.length >= 32 && sha(a.p_secret) === o.secretSha256)) return send(400, { code: '28000', message: 'ARS401: arena server secret rejected' });
      if (m[1] === 'arena_load') return send(200, rows.slice().sort((x, y) => x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : y.generation - x.generation));
      if (m[1] === 'arena_clear') { const n = rows.length; rows.length = 0; return send(200, n); }
      if (['state', 'pool'].indexOf(a.p_kind) < 0) return send(400, { message: 'ARS400: bad kind' });
      const bytes = Buffer.byteLength(a.p_payload || '');
      if (bytes > 4194304) return send(400, { message: 'ARS413: too big' });
      if (sha(a.p_payload) !== a.p_sha256) return send(400, { message: 'ARS422: sha256 does not match the payload' });
      const max = rows.filter((r) => r.kind === a.p_kind).reduce((x, r) => Math.max(x, r.generation), 0);
      if (a.p_generation <= max) return send(400, { message: 'ARS409: generation ' + a.p_generation + ' is not newer than stored ' + max });
      rows.push({ kind: a.p_kind, generation: a.p_generation, sha256: a.p_sha256, bytes, payload: a.p_payload, meta: a.p_meta || {}, saved_at: new Date().toISOString() });
      const mine = rows.filter((r) => r.kind === a.p_kind).sort((x, y) => y.generation - x.generation);
      mine.slice(2).forEach((r) => rows.splice(rows.indexOf(r), 1));
      send(200, { kind: a.p_kind, generation: a.p_generation, bytes, sha256: a.p_sha256 });
    }
  });
  return new Promise((r) => server.listen(o.port || 0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + server.address().port, rows, calls, opts: o, close: () => new Promise((d) => server.close(d)) })));
}
module.exports = { startFake, sha };
if (require.main === module) { // standalone: node test/fake-supabase.js <port> <secret> <anonKey>
  const [port, secret, anon] = process.argv.slice(2);
  startFake({ port: Number(port), secretSha256: sha(secret), anonKey: anon }).then((f) => console.log('fake supabase on', f.url));
}

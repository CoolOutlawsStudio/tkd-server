import { PGlite } from '@electric-sql/pglite';
import fs from 'fs'; import crypto from 'crypto';
const db = new PGlite(); // no pgcrypto: the SQL uses built-in pg_catalog.sha256()
let pass = 0, fail = 0; const ok = (c, n, x) => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (x ? ' (' + x + ')' : '')); };
await db.exec(`create schema if not exists extensions; create role anon nologin; create role authenticated nologin; grant usage on schema public to anon, authenticated; grant usage on schema extensions to anon, authenticated;`);
// Supabase-like default privileges: anon gets table privileges on new public tables unless revoked
await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated; alter default privileges in schema public grant execute on functions to anon, authenticated;`);
const sql = fs.readFileSync(new URL('../../supabase_arena_server.sql', import.meta.url), 'utf8');
await db.exec(sql); await db.exec(sql); ok(true, 'SQL applies twice (idempotent)');
const secret = crypto.randomBytes(32).toString('base64url'), h = crypto.createHash('sha256').update(secret).digest('hex');
await db.query(`insert into public.arena_server_config (id, secret_sha256) values (1, $1) on conflict (id) do update set secret_sha256 = excluded.secret_sha256`, [h]);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function asAnon(q, p) { await db.exec('set role anon'); try { return await db.query(q, p); } finally { await db.exec('reset role'); } }
async function err(q, p) { try { await asAnon(q, p); return null; } catch (e) { return e.message; } }
ok(/permission denied/.test(await err('select * from public.arena_brains')), 'anon cannot select the table');
ok(/permission denied/.test(await err("insert into public.arena_brains values ('state',1,repeat('a',64),1,'x')")), 'anon cannot insert directly');
ok(/permission denied/.test(await err('select * from public.arena_server_config')), 'anon cannot read the secret hash');
ok(/permission denied/.test(await err("select public.arena_secret_ok('x')")), 'anon cannot call arena_secret_ok (no oracle)');
ok(/ARS401/.test(await err("select public.arena_load('wrong-secret-wrong-secret-wrong-secret-x')")), 'wrong secret -> ARS401');
ok(/ARS401/.test(await err("select public.arena_save('short','state',1,$1,'x')", [sha('x')])), 'short secret -> ARS401');
ok(/ARS401/.test(await err('select public.arena_load($1)', [secret + 'x'.repeat(300)])), 'over-long secret (> 256 bytes) -> ARS401');
const save = (g, payload, kind, s) => asAnon('select public.arena_save($1,$2,$3,$4,$5,$6) as r', [secret, kind || 'state', g, s || sha(payload), payload, { rounds: g }]);
const r1 = await save(1, 'payload-1'); ok(r1.rows[0].r.generation == 1, 'anon + secret saves gen 1');
ok(/ARS422/.test(await err("select public.arena_save($1,'state',2,$2,'payload-2')", [secret, sha('other')])), 'sha mismatch -> ARS422');
ok(/ARS409/.test(await err("select public.arena_save($1,'state',1,$2,'p')", [secret, sha('p')])), 'stale generation -> ARS409');
ok(/ARS400/.test(await err("select public.arena_save($1,'evil',5,$2,'p')", [secret, sha('p')])), 'bad kind -> ARS400');
ok(/ARS413/.test(await err("select public.arena_save($1,'state',5,$2,'p',$3)", [secret, sha('p'), { x: 'm'.repeat(16400) }])), 'meta > 16 KiB -> ARS413');
await save(2, 'payload-2'); await save(3, 'payload-3'); await save(1, 'pool-1', 'pool');
const big = 'A'.repeat(1500000); await save(4, big);
ok(true, '1.5 MB payload accepted');
ok(/ARS413/.test(await err("select public.arena_save($1,'state',9,$2,$3)", [secret, sha('B'.repeat(4194305)), 'B'.repeat(4194305)])), '> 4 MB -> ARS413');
const l = await asAnon('select kind, generation, bytes from public.arena_load($1)', [secret]);
ok(JSON.stringify(l.rows.map((r) => r.kind + r.generation)) === '["pool1","state4","state3"]', 'load: newest 2 state gens + pool, newest first', l.rows.map((r) => r.kind + r.generation + ':' + r.bytes).join(','));
const c = await asAnon('select public.arena_clear($1) as n', [secret]); ok(c.rows[0].n === 3, 'clear deletes all rows', c.rows[0].n);
const vol = await db.query("select provolatile from pg_proc where oid = 'public.arena_load(text)'::regprocedure"); ok(vol.rows[0].provolatile === 'v', 'arena_load is volatile (POST-only in PostgREST)', vol.rows[0].provolatile);
const rls = await db.query("select relrowsecurity from pg_class where oid = 'public.arena_brains'::regclass"); ok(rls.rows[0].relrowsecurity === true, 'RLS on');
const pol = await db.query("select count(*)::int n from pg_policies where tablename in ('arena_brains','arena_server_config')"); ok(pol.rows[0].n === 0, 'no policies');
const auth = await db.exec('set role authenticated').then(() => db.query("select public.arena_load('x')").then(() => 'ok', (e) => e.message)).finally(() => db.exec('reset role'));
ok(/permission denied/.test(auth), 'authenticated role cannot call the RPCs', auth);
console.log('sql tests: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);

-- TKD-Net Arena server persistence (owner: Moneyman). NOT APPLIED. Review: Waffle. Apply: Moneyman, Supabase SQL editor,
-- project oxwapwhazogjgjdtyvsx. Idempotent (safe to run twice). Needs the pgcrypto extension (Supabase installs it in
-- schema `extensions` by default).
--
-- Model: the arena server talks to Supabase with the PUBLIC anon key only. The anon key alone can do nothing here:
--   * table public.arena_brains has RLS on and NO policies, and anon/authenticated have no table privileges, so it can't
--     be read or written through the REST table API at all;
--   * the only way in is three SECURITY DEFINER functions (arena_save / arena_load / arena_clear) that each require
--     p_secret, a long random server secret (>= 32 chars) whose SHA-256 must match the single row in
--     public.arena_server_config. The secret itself lives only in the host's env var SERVER_SECRET; the database only
--     stores its hash (paste the HASH below, never the secret, so it never lands in the SQL editor history).
--   * the service_role key is never used or needed.
-- Rows: one per (kind, generation). kind 'state' = {brains, history, meta} (saved every 60 s and on SIGTERM),
-- kind 'pool' = {pool} (opponent snapshots, saved only when changed, at most every 10 min). The payload is base64 text
-- of gzipped JSON (lib/codec.js); its sha256 is verified here on save and again by the server on load. Only the newest
-- 2 generations per kind are kept. Generations must increase: a stale writer (a second server instance still running
-- after a deploy) gets error ARS409 instead of overwriting newer brains.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.arena_brains (
  kind        text        not null check (kind in ('state', 'pool')),
  generation  bigint      not null check (generation > 0),
  sha256      text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes       integer     not null check (bytes > 0 and bytes <= 4194304),
  payload     text        not null,
  meta        jsonb       not null default '{}'::jsonb,
  saved_at    timestamptz not null default now(),
  primary key (kind, generation)
);
alter table public.arena_brains enable row level security;
revoke all on table public.arena_brains from anon, authenticated, public;

create table if not exists public.arena_server_config (
  id            integer primary key default 1 check (id = 1),
  secret_sha256 text    not null check (secret_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at    timestamptz not null default now()
);
alter table public.arena_server_config enable row level security;
revoke all on table public.arena_server_config from anon, authenticated, public;

-- internal: true when p_secret is the configured server secret
create or replace function public.arena_secret_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32 and exists (
    select 1 from public.arena_server_config c
    where c.id = 1 and c.secret_sha256 = encode(extensions.digest(convert_to(p_secret, 'UTF8'), 'sha256'), 'hex')
  ), false);
$$;
revoke all on function public.arena_secret_ok(text) from public, anon, authenticated;

create or replace function public.arena_save(p_secret text, p_kind text, p_generation bigint, p_sha256 text, p_payload text, p_meta jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_max bigint;
  v_bytes integer;
begin
  if not public.arena_secret_ok(p_secret) then
    raise exception 'ARS401: arena server secret rejected' using errcode = '28000';
  end if;
  if p_kind is null or p_kind not in ('state', 'pool') then
    raise exception 'ARS400: bad kind' using errcode = '22023';
  end if;
  if p_payload is null or p_generation is null or p_generation <= 0 then
    raise exception 'ARS400: payload and a positive generation are required' using errcode = '22023';
  end if;
  v_bytes := octet_length(p_payload);
  if v_bytes > 4194304 then
    raise exception 'ARS413: payload is % bytes, limit 4194304', v_bytes using errcode = '22023';
  end if;
  if p_sha256 is null or encode(extensions.digest(convert_to(p_payload, 'UTF8'), 'sha256'), 'hex') <> p_sha256 then
    raise exception 'ARS422: sha256 does not match the payload' using errcode = '22023';
  end if;
  -- serialise concurrent writers of the same kind
  perform pg_advisory_xact_lock(hashtext('arena_brains:' || p_kind));
  select max(generation) into v_max from public.arena_brains where kind = p_kind;
  if v_max is not null and p_generation <= v_max then
    raise exception 'ARS409: generation % is not newer than stored %', p_generation, v_max using errcode = '22023';
  end if;
  insert into public.arena_brains (kind, generation, sha256, bytes, payload, meta)
  values (p_kind, p_generation, p_sha256, v_bytes, p_payload, coalesce(p_meta, '{}'::jsonb));
  -- keep only the newest 2 generations of this kind
  delete from public.arena_brains b
   where b.kind = p_kind
     and b.generation < (select min(g) from (select generation as g from public.arena_brains
                                              where kind = p_kind order by generation desc limit 2) t);
  return jsonb_build_object('kind', p_kind, 'generation', p_generation, 'bytes', v_bytes, 'sha256', p_sha256);
end;
$$;

-- newest first; the server verifies sha256 and falls back to the older generation if the newest is unusable
create or replace function public.arena_load(p_secret text)
returns table (kind text, generation bigint, sha256 text, bytes integer, payload text, meta jsonb, saved_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.arena_secret_ok(p_secret) then
    raise exception 'ARS401: arena server secret rejected' using errcode = '28000';
  end if;
  return query
    select b.kind, b.generation, b.sha256, b.bytes, b.payload, b.meta, b.saved_at
      from public.arena_brains b
     order by b.kind, b.generation desc;
end;
$$;

-- admin reset: deletes every stored generation (the server then writes a fresh 'state' generation)
create or replace function public.arena_clear(p_secret text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare n integer;
begin
  if not public.arena_secret_ok(p_secret) then
    raise exception 'ARS401: arena server secret rejected' using errcode = '28000';
  end if;
  delete from public.arena_brains;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.arena_save(text, text, bigint, text, text, jsonb) from public, authenticated;
revoke all on function public.arena_load(text) from public, authenticated;
revoke all on function public.arena_clear(text) from public, authenticated;
grant execute on function public.arena_save(text, text, bigint, text, text, jsonb) to anon;
grant execute on function public.arena_load(text) to anon;
grant execute on function public.arena_clear(text) to anon;

-- ---------------------------------------------------------------------------------------------------------------
-- ONE-TIME SETUP (run separately, after the block above). Generate the secret on the machine that will run the
-- server, keep it ONLY in that host's env (SERVER_SECRET), and paste just its SHA-256 here:
--   node -e "const s=require('crypto').randomBytes(32).toString('base64url');console.log('SERVER_SECRET='+s);console.log('sha256='+require('crypto').createHash('sha256').update(s).digest('hex'))"
-- then:
--   insert into public.arena_server_config (id, secret_sha256) values (1, '<paste sha256 hex>')
--   on conflict (id) do update set secret_sha256 = excluded.secret_sha256, updated_at = now();
-- Rotating the secret = run the insert again with the new hash and restart the server with the new SERVER_SECRET.
--
-- CHECKS (expected results):
--   select relrowsecurity from pg_class where oid = 'public.arena_brains'::regclass;          -- true
--   select count(*) from pg_policies where tablename in ('arena_brains','arena_server_config');  -- 0
--   select has_table_privilege('anon', 'public.arena_brains', 'select');                       -- false
--   select has_function_privilege('anon', 'public.arena_secret_ok(text)', 'execute');         -- false
--   select public.arena_load('wrong-secret-wrong-secret-wrong-secret');                        -- ERROR ARS401
-- ROLLBACK:
--   drop function if exists public.arena_save(text, text, bigint, text, text, jsonb), public.arena_load(text),
--     public.arena_clear(text), public.arena_secret_ok(text);
--   drop table if exists public.arena_brains, public.arena_server_config;

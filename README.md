# TKD-Net Arena server (owner: Moneyman)

One Node process trains the two Arena fighters forever. Every page that connects over WebSocket watches the same live match.
Protocol: `ARENA-SERVER-CONTRACT.md` (section 6, to be merged into `/workspace/tkd-net/ARENA-CONTRACT.md`).
Host-neutral: it runs anywhere Node >= 18 runs. **Nothing is deployed from this folder.**

```
server.js                    main thread: HTTP /health /state, WS /arena, fan-out, persistence schedule, shutdown
lib/arena-host.js            worker thread: Web-Worker shim that runs vendor/arena-worker.js unchanged
lib/mem-idb.js               in-memory IndexedDB for the unchanged arena-store.js (writes mirrored to the main thread)
lib/persistence.js           supabase (RPC + secret) | file (DATA_DIR) | memory backends, generations, sha checks
lib/codec.js                 arena-store records <-> gzipped JSON base64 (typed arrays lossless)
vendor/                      byte-identical copies of arena-sim.js, arena-rl.js, arena-worker.js, arena-store.js (+SHAS.json)
scripts/sync-vendor.js       refresh vendor/ from /workspace/tkd-net (--check = fail on drift)
supabase_arena_server.sql    table + SECURITY DEFINER RPCs (NOT applied)
test/                        tests, fake Supabase, soak; results in test/results/
Dockerfile, render.yaml      container (node:20-alpine) and Render fallback blueprint
```

## Run
```
npm ci                      # installs ws (the only dependency)
npm run check-vendor        # vendor/ must match /workspace/tkd-net (npm run sync to refresh)
PORT=8080 node server.js    # memory-only unless persistence env vars are set
curl localhost:8080/state
```
Stop with SIGTERM or Ctrl-C. It saves (state + pool) before exiting.

### On the box behind a Cloudflare relay (primary target)
```
cd /workspace/tkd-server && PORT=8787 DATA_DIR=/workspace/tkd-server-data node server.js     # or the SUPABASE_* vars
cloudflared tunnel --url http://localhost:8787     # quick tunnel: prints https://<random>.trycloudflare.com
```
The page's `TKD_SERVER_URL` is then `wss://<random>.trycloudflare.com/arena`. Notes:
- A quick-tunnel URL changes every time cloudflared restarts. A fixed hostname needs a named tunnel on a Cloudflare
  account, which is jeff's/Toml's call. Not set up here.
- Cloudflare closes idle WebSockets after 100 s. The server's 20 s heartbeat keeps them open.
- Keep it running with a supervisor (`systemd --user`, `pm2`, or `while true; do node server.js; sleep 5; done`). SIGTERM is graceful.

### Render free web service (deploy target; this folder is the repo `CoolOutlawsStudio/tkd-server`)
This folder is self-contained: `vendor/` (committed) holds the arena files, so the repo builds without tkd-net.
Before every push run `npm run sync && npm run check-vendor && npm test`.
1. Push this folder as the public repo (no secrets in it: `.gitignore` excludes `*.env`; `render.yaml` holds only public values).
2. Render -> New -> Blueprint -> the repo. It reads `render.yaml` (free plan, `npm ci --omit=dev`, `node server.js`,
   health check `/health`). Type the 3 `sync: false` values: `SUPABASE_ANON_KEY`, `SERVER_SECRET`, `ADMIN_TOKEN`.
3. Apply `supabase_arena_server.sql` and insert the secret's sha256 (below) **before** the first start, or it runs memory-only.
4. Kai sets `TKD_SERVER_URL = 'wss://<service>.onrender.com/arena'`.
Render free behaviour and measured numbers: `ARENA-SERVER-CONTRACT.md` 6.10-6.11. In short: it sleeps 15 min after the
last viewer message, takes about 1 min to wake on the next connection, resumes the saved brains in about 2 s, keeps the live match at 10 Hz on
0.1 CPU while practice training slows about 10x, and uses about 1.2 KB/s per viewer.

### Container (any Docker host)
`docker build -t tkd-arena-server . && docker run -p 8080:8080 --env-file arena.env tkd-arena-server`
(node:20-alpine, runs as `node`, `node server.js` as PID 1 so SIGTERM reaches it, HEALTHCHECK on `/health`).
Not built here (no Docker on the box). Render uses the native Node runtime from `render.yaml`, not this file.

## Environment variables
| var | default | meaning |
|---|---|---|
| `PORT` | 8080 | HTTP + WS port (`BIND` default 0.0.0.0) |
| `ALLOWED_ORIGINS` | `https://cooloutlawsstudio.github.io,https://tkd-net.netlify.app` | CORS + WebSocket Origin allow-list (comma-separated) |
| `ALLOW_NO_ORIGIN` | 1 | allow WS clients that send no Origin (tools, tests); 0 = browsers only |
| `ADMIN_TOKEN` | unset (reset disabled) | >= 16 chars; enables the admin `reset` message |
| `SUPABASE_URL` | unset | e.g. `https://oxwapwhazogjgjdtyvsx.supabase.co` |
| `SUPABASE_ANON_KEY` | unset | the **public anon** key (a service_role key is refused) |
| `SERVER_SECRET` | unset | >= 32 random chars; its SHA-256 goes into `arena_server_config` |
| `DATA_DIR` | unset | file persistence (used only if the Supabase vars are not set) |
| `SAVE_EVERY_S` | 60 | upload interval for `state` (brains + history + meta) |
| `POOL_SAVE_EVERY_S` | 600 | minimum interval between pool uploads (also uploaded on shutdown) |
| `MAX_VIEWERS` | 100 | further viewers get `error{code:'full'}` and fall back |
| `FRAME_HZ` | 15 | max frames/s per viewer (the match produces 10) |
| `WS_DEFLATE` | 1 | permessage-deflate (~7x less bandwidth); 0 = off |
| `VIZ_MS` | 1000 | viz push period (Render: 5000) |
| `LEARN_HZ` | 1 | max `learn` messages/s per fighter |
| `ROUND_MSGS` | all | `live` = forward only live-round `round` messages |
| `ARENA_SEED` | 1 | base seed of the coach (practice RNG is re-seeded every boot, like a page open) |
| `SERVER_NAME` | hostname / `RENDER_SERVICE_NAME` / `FLY_APP_NAME` | shown as `server.host` |
| `WORKER_HEAP_MB` | 512 | V8 heap cap of the trainer thread |
| `SHUTDOWN_TIMEOUT_S` | 20 | hard exit if the shutdown save hangs |
| `HEARTBEAT_S`, `MEM_LOG_S`, `WATCHDOG_S`, `HISTORY_ROUNDS`, `HISTORY_ELO`, `QUIET` | 20, 1000, 60, 30, 100, 120, 0 | tuning |

## Persistence setup (Supabase; done by Moneyman from a 1:1, after Waffle's review)
1. SQL editor -> run `supabase_arena_server.sql` (idempotent).
2. On the host: `node -e "const c=require('crypto');const s=c.randomBytes(32).toString('base64url');console.log('SERVER_SECRET='+s);console.log('sha256='+c.createHash('sha256').update(s).digest('hex'))"`.
   Put `SERVER_SECRET` in the host env only. Paste only the sha256 into
   `insert into public.arena_server_config (id, secret_sha256) values (1,'<sha256>') on conflict (id) do update set secret_sha256=excluded.secret_sha256, updated_at=now();`
3. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SERVER_SECRET` and start the server. `/state` should then show
   `persistence.mode: "supabase"` and, after 60 s, `saves >= 1`.

## Tests
```
npm test                                  # stream contract, persistence/restart (fake Supabase), file backend, limits, vendor drift, ~2 min
node test/test-viewers.js                 # 0 vs 5 viewers throughput + identical frames, ~3.5 min
node test/soak.js 20                      # 20-min soak; CPU_LIMIT=0.5 CPU=6 for a half-core estimate
node test/bandwidth.js 60                 # bytes per viewer by message type (CPU_LIMIT=0.1, VIZ_MS=5000 ...)
node test/coldstart.js                    # Render-style: train, SIGTERM, cold start at 0.1 CPU from fake Supabase
cd test/sql && npm i && node sqltest.mjs  # the SQL on PGlite (Postgres 17 WASM + pgcrypto)
```

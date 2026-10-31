# TKD-Net Arena contract: section 6, Server mode (draft for review; owner: Moneyman)

> Additive to `ARENA-CONTRACT.md` sections 1-5 (nothing there changes). Moneyman merges this into `ARENA-CONTRACT.md`
> after Waffle's review. Implementation: `/workspace/tkd-server/` (`server.js`). Protocol version **1**.

## 6.1 What runs where
- **One** Node process (Node >= 18, dependency `ws` only) trains the two fighters forever and plays one live match at real
  time (10 decision steps/s, 60 s rounds). Every page that connects watches **the same** match. Nobody can pause it.
- The trainer is the **unchanged browser worker**: `arena-worker.js` 4fd78ad4 loading `arena-sim.js` 6952e844,
  `arena-rl.js` e6bb0ad7, `arena-store.js` 1f7cdea6. They run in a Node `worker_thread` inside a shim that provides what a
  Web Worker has (`self`, `postMessage`, `onmessage`, `importScripts`, `setTimeout`, `performance.now`,
  `structuredClone`, `indexedDB`). `indexedDB` is an in-memory stand-in whose writes are mirrored to the main thread,
  which uploads them (6.7). Same scheduling, league, PPO and Elo code as the browser, so server fighters train exactly
  like browser fighters (differences: 6.9).
- The main thread does only HTTP, WebSocket fan-out and persistence, so a training slice never delays a viewer's frame.
- `vendor/` holds byte-identical copies of the four files; `npm run sync` refreshes them from `/workspace/tkd-net`
  (`npm run check-vendor` fails on drift). The shas are reported in `hello.version.files` and `/state`.

## 6.2 Where the page connects (Kai)
- **One config value:** `TKD_SERVER_URL`, a single constant at the top of the arena page, e.g.
  `var TKD_SERVER_URL = 'wss://arena.example.com/arena';` (`''` = no server, in-browser only).
- **Override:** `arena.html?server=wss://host/arena` uses that URL for this visit; `?server=off` forces in-browser mode.
- HTTP endpoints derive from it: replace `wss:` with `https:` and `/arena` with `/health` or `/state`.
- Hosting targets: **Render free web service** (Toml: "Deploy on render"; repo `CoolOutlawsStudio/tkd-server`, URL like
  `wss://tkd-arena-server.onrender.com/arena`) and the box behind a Cloudflare relay. The page never hard-codes a host;
  only `TKD_SERVER_URL` changes. Render specifics: 6.11.

## 6.3 Endpoints
| Endpoint | Purpose |
|---|---|
| `WS /arena` | the live stream (JSON text frames). Other paths answer 404. |
| `GET /health` | `{ ok, state, uptime, version }`; **200** while booting or training, **503** if the trainer is stopped or silent for 30 s (watchdog). For host health checks. |
| `GET /state` | small JSON (about 1.3 KB): `{ server, elo:{rounds,a,b,se,anchors,at}, stats:{roundsPerSec,stepsPerSec,liveRounds,practiceRounds,wins,updates,droppedTrajectories}, live:{round,t}, framesSent, framesDropped, restored }`. For a status badge without opening a socket. |
| `GET /` | `{ name, ws:'/arena', health, state, protocol }` |

- **CORS** (`/health`, `/state`): `Access-Control-Allow-Origin` echoes the request origin only if it is in
  `ALLOWED_ORIGINS` (default `https://cooloutlawsstudio.github.io,https://tkd-net.netlify.app`), `Vary: Origin`, GET/OPTIONS only.
- **WebSocket Origin check:** a browser `Origin` not in `ALLOWED_ORIGINS` gets HTTP 403 on upgrade. Requests without an
  `Origin` header (curl, test clients, health probes) are allowed unless `ALLOW_NO_ORIGIN=0`.

## 6.4 Messages: server -> page
Every message is one JSON text frame `{ type, ..., epoch }`. Shapes are **identical to the worker messages of section 3**
(same field names and meanings), plus the additive fields below. Typed arrays become plain JSON arrays.

| type | when | fields (beyond section 3) |
|---|---|---|
| `hello` | **always the first message**, then on every state change (`change:true`), every 20 s (`heartbeat:true`), as the reply to a client `hello` (`reply:true`), after an admin reset (`reset:true`) | `protocol:1, state, since, message, rounds, viewers, persistence, version, server` (6.5) |
| `ready` | after `hello` (replay) and whenever the trainer (re)starts | section 3 `ready` + `mode:'server'`, `persistence:'supabase'|'file'|'memory'`, `storage` (true if persisted), `server` |
| `status` | replay, then on change | section 3 + `mode:'server'`. `state` is the trainer's (`loading`/`running`/`paused`/`error`). The page should show `hello.state` as the headline. |
| `history` | after `ready` (replay and on each trainer start) | the `arena-store` `history` record, bounded: `{ rounds:[{round,winner,hitsA,hitsB,live,kind}] (last 100), elo:[{rounds,a,b,vsScripted,vsPast,games,trainSeconds,at}] (last 120), replay:true }`. This replaces `store.loadHistory()` in server mode. |
| `frame` | live match, **10/s** (at most `FRAME_HZ`, default 15, coalesced: only the newest frame is sent) | section 3 `frame` + `seq` (server frame counter). One `frame` with `replay:true` on connect. |
| `round` | every finished round (live and practice, ~4-5/s) | section 3 `round` unchanged |
| `elo` | every ~25 rounds; the newest one again as replay on connect | section 3 `elo` unchanged |
| `stats` | every ~2 s | section 3 `stats` + `server` |
| `viz` | ~1/s, pushed while at least one viewer is connected (`id:'server-<n>'`) | section 3 `viz`, activations as arrays rounded to 4 decimals; `weightDelta` is the change since the previous server `viz` (about 1 s) |
| `learn` | at most 1/s per fighter (the newest) | section 3 `learn` unchanged |
| `saved` | after each **remote** save (not the worker's local 5 s saves) | `{ remote:true, persistence, generation, rounds, trainSeconds, bytes, stateBytes, poolBytes, pool, at, ms, why }` |
| `error` | trainer error, or a refused client message | `{ message, code? }` with `code`: `full`, `protocol`, `forbidden`, `not-accepted`, `rate` |
| `pong` | reply to `ping` | `{ t, serverTime }` |

**`epoch`:** the server's reset counter, persisted with the brains. It only changes on an admin reset (it does **not**
go back to 0 when the server restarts). A page that sees a higher `epoch` clears its charts and keeps going; older
epochs are ignored, as in section 3. A server restart is visible as a new `server.bootId`.

**Order on connect** (after the client's `hello`, or after 1 s if it sends none):
`hello`, `ready`, `status`, `history`, `elo`, `stats`, `saved`, `frame` (each only if available; all but `hello`
carry `replay:true`). Total about 30-60 KB. Then live messages.

## 6.5 `hello` and the `server` field
```
{ type:'hello', protocol:1, epoch:0,
  state: 'waking'|'resuming'|'training'|'paused'|'offline',
  since: ISO time the state began, message: text or null,
  rounds, viewers, persistence:{...}, version:{ server:'1.0.0', protocol:1, files:{'arena-sim.js':'6952e844', ...}, rl, sim },
  server:{ host, bootId, startedAt, uptime (s), state, since, message, trainSeconds, rounds, viewers, maxViewers,
           frameHz, restarts, epoch, persistence, version, memory:{ rssMB, mainHeapMB, workerHeapMB, at } },
  change?:true, heartbeat?:true, reply?:true, reset?:true }
```
| state | meaning | page shows (suggestion) |
|---|---|---|
| `waking` | process just started (loading saved brains, under 1 s), or starting fresh brains (first run, memory-only, load failed). Before the process exists (Render spinning up, ~1 min) the page shows its own "Waking the server…" (6.9) | "Server starting…" |
| `resuming` | restoring saved brains, or restarting the trainer after a crash | "Resuming saved fighters…" |
| `training` | live match running, both fighters learning | "Live from server" |
| `paused` | saving before a restart/deploy, or trainer crashed (auto-restart with backoff 5 s .. 5 min) | "Server paused: `message`" |
| `offline` | sent once just before a clean shutdown; the page also uses it when it cannot connect | "Server offline, training in your browser" |

`persistence` = `{ mode:'supabase'|'file'|'memory', where, note, generation, poolGeneration, savedAt, bytes,
poolSavedAt, poolBytes, loadedAt, loadedGeneration, saves, failures, lastError, lastErrorAt, fallbacks }`.
`mode:'memory'` with a `note` means nothing survives a restart. The page should say so.

## 6.6 Messages: page -> server
Only these are accepted (anything else gets `error{code:'not-accepted'}` and is ignored; the match is shared, so
`start`, `pause`, `resume`, `speed`, `practice`, `flush`, `viz`, `export` are **not** honoured):
| type | fields | reply |
|---|---|---|
| `hello` | `{ protocol:1, epochSeen }` | the first one triggers the replay snapshot; later ones get `hello{reply:true, epochChanged}`. A different `protocol` gets `error{code:'protocol'}` and close 4000. |
| `ping` | `{ t }` | `pong{t, serverTime}` |
| `reset` | `{ token }` | **admin only**: `token` must equal the `ADMIN_TOKEN` env var (>= 16 chars; unset = reset disabled), compared in constant time, at most 1 per minute. Deletes both brains, pool, history and every stored generation, then `epoch` + 1. Otherwise `error{code:'forbidden'}`. |
Limits: messages up to 4 KB; 2 messages/s sustained (burst 20), more closes the socket with 1008.

## 6.7 Persistence (Supabase, anon key + server secret, never service_role)
- Records are exactly the `arena-store.js` records (`brains`, `pool`, `history`, `meta`, section 4). The worker
  saves them into its in-memory IndexedDB every ~5 s as in the browser. The main thread uploads the newest:
  - kind **`state`** = `{brains, history, meta}`: every 60 s (`SAVE_EVERY_S`) if anything changed, and on SIGTERM/SIGINT.
    Measured about **134-136 KB** (brains alone 133 KB).
  - kind **`pool`** = `{pool}` (opponent snapshots + frozen milestones): on the first save, then at most every 10 min
    (`POOL_SAVE_EVERY_S`) when it changed, and on SIGTERM. **Bigger than the 100-200 KB target**: 0.2 MB early, about
    **1.3 MB** once the pool is full (26 networks of 12,517 floats). Saving it rarely keeps writes to about 190 MB/day.
- Encoding: JSON with typed arrays as `{"__ta":"Float32Array","b64":...}` (lossless), gzipped, base64 text.
  `sha256` of that text is checked by SQL on save and by the server on load.
- **Generations:** every upload has a generation number, monotonic per kind. The newest 2 per kind are kept. On load the
  server takes the newest generation that passes the sha/format checks and falls back to the older one otherwise.
  A writer whose generation is not newer is refused (`ARS409`), so a stale second instance can't overwrite newer brains.
- **Security** (`supabase_arena_server.sql`, not applied yet): table `public.arena_brains` with RLS on and **no
  policies**, and no table privileges for `anon`/`authenticated`, so the REST table API can't touch it. The only way in
  is 3 `SECURITY DEFINER` functions (`search_path=''`), executable by `anon` only: `arena_save`, `arena_load` and
  `arena_clear`. Each one requires `p_secret` (>= 32 chars), whose SHA-256 must equal the single row of
  `public.arena_server_config`. The secret exists only in the host's `SERVER_SECRET` env var, and the database stores
  only its hash. The public anon key alone can do nothing. The server refuses to start persistence with a key whose JWT
  role is `service_role`.
  Errors: `ARS401` bad secret, `ARS400` bad args, `ARS409` stale generation, `ARS413` > 4 MB, `ARS422` sha mismatch.
  - Rejected alternative: a private Storage bucket. Storage RLS policies can only see the JWT role/uid, not a
    per-request secret, so either the anon key could write it or we'd need the service_role key (forbidden) or a
    signed-in Supabase user for the server (a signup).
- **Optional:** with `SUPABASE_*`/`SERVER_SECRET` unset the server runs **memory-only** and says so (`persistence.mode`,
  `note`, `hello.message`). With `DATA_DIR` set (and no Supabase), it uses atomic JSON files there: same envelope,
  generations and keep-2 rule. That's useful on the box. If the initial load fails (bad secret, outage), the server
  runs memory-only **and does not save**, so it never overwrites good stored brains with fresh ones.
- **Loss bound:** a crash loses at most 60 s of training (the 5 s bound of the browser is for its local IndexedDB).
  A clean SIGTERM loses nothing: pause -> local save -> upload of state + pool -> `hello{state:'offline'}` -> close
  1012, about 0.1 s in tests (timeout `SHUTDOWN_TIMEOUT_S`, default 20 s).

## 6.8 Flow control, limits, idle
- **Frames:** the trainer posts 10 frames/s. The main thread keeps only the newest and sends at most `FRAME_HZ`
  (default 15, Render 10)/s, serialised **once** for all viewers. WebSocket permessage-deflate is on (`WS_DEFLATE`), so
  the wire is ~7x smaller (6.10). Browsers handle it transparently.
- **Message volume knobs:** `VIZ_MS` (viz push period, default 1000, Render 5000), `LEARN_HZ` (default 1),
  `ROUND_MSGS=live` (forward only live-round `round` messages; default `all`).
- **Backpressure:** a viewer with more than 64 KB unsent skips frames (counted in `framesDropped`; other messages
  still go). Above 2 MB unsent it is disconnected. The trainer never waits for a socket.
- **Max viewers:** `MAX_VIEWERS` (default 100). Viewer 101 gets `error{code:'full'}` and close 1013, then falls back.
- **Heartbeat:** every 20 s, a WebSocket ping (no pong by the next round = terminated) and a `hello{heartbeat:true}`.
  That is under Cloudflare's 100 s idle-socket timeout, so a relayed socket stays open.
- **Idle (0 viewers):** training continues at full speed (that's the point). Frames are not serialised and `viz`
  is not computed.
- **Memory guard:** RSS, main heap and trainer heap are logged every 60 s and shown in `server.memory`. Histories are
  capped (worker: 500 rounds and 2,000 Elo points, thinned. Server: 500 rounds and 200 Elo points; replay 100/120).
  The trainer thread has a V8 heap cap (`WORKER_HEAP_MB`, 512). If it crashes or stops talking for 30 s, it is
  restarted from the newest records in memory (backoff 5 s .. 5 min).

## 6.9 Page fallback (Kai)
1. If `TKD_SERVER_URL` is empty or `?server=off`: in-browser worker as today.
2. Otherwise open the WebSocket and show "Connecting to server…". **Start the in-browser worker** if any of these
   happen: no `hello` within 8 s, a close before the first `hello`, `error{code:'full'|'protocol'}`, or `hello.state`
   is `offline`. Say which mode is active ("Live from server" / "Training in your browser: server offline").
   **Waking a sleeping Render service:** the first connection attempt is what wakes it (~1 min; until then Render
   answers with its own loading page without CORS, so the socket or fetch simply fails). So keep retrying the socket
   every 5 s for up to 90 s while showing "Waking the server (about a minute)…", with the in-browser match running
   meanwhile, and switch to the server stream when its `hello` arrives.
   **While connected and the tab is visible, send `{type:'ping'}` every 60 s.** On Render free, inbound WebSocket
   messages keep the service awake (protocol-level pongs may not count). Without viewers it sleeps after 15 min, which is intended (no external keep-alive).
3. While connected: a socket close (1012 = server restarting, 1006 = network) -> "Reconnecting…", retry with backoff
   (1, 2, 4 … 30 s). After 3 failed tries, switch to in-browser and keep retrying in the background (every 60 s)
   without disrupting the local match. Optionally poll `/state` first to see `state` without a socket.
4. Ignore messages with an older `epoch`. On a higher `epoch`, clear the charts and the round list.
5. Never send `pause`/`speed`/`practice`/`flush` in server mode. Hide those controls and show "shared match".
6. In-browser mode and server mode have separate brains. The server never reads the page's IndexedDB.

## 6.10 Bandwidth (measured, `test/bandwidth.js`, one viewer, per second of watching)
| setting | JSON payload | on the wire (permessage-deflate) | GB/month if one viewer watched 24/7 | viewer-hours per 5 GB |
|---|---|---|---|---|
| deflate off, viz 1/s | 14.9 KB/s | 15.0 KB/s | 39.8 | 90 |
| deflate on, viz 1/s (default) | 14.9 KB/s | 2.19 KB/s | 5.8 | 620 |
| deflate on, viz every 5 s (**Render config**) | 11.8 KB/s | **1.23 KB/s** (4.5 MB/hour) | 3.3 | **~1,100** |
| same at 0.1 CPU (fewer practice `round` msgs) | 10.0 KB/s | 0.92 KB/s | 2.4 | ~1,480 |
Frames are 61-79% of the payload (936 B each, 10/s), and `viz` is 3.9 KB each. Plus the server's own uploads to Supabase (also
outbound on Render): state 136 KB per 60 s = **8.2 MB per awake hour**, and the pool 1.3-1.5 MB hourly plus on every
SIGTERM (each spin-down). So an always-awake service would use about 6-7 GB/month in checkpoints alone. On Render free
it is only awake while watched, plus 15 min. Use `SAVE_EVERY_S=120..300` if the 5 GB gets tight.

## 6.11 Render free specifics
- 0.1 CPU: the live match keeps real time (the worker always steps the due live steps first; practice, PPO and Elo use
  the remainder). Measured with a 10 ms/100 ms duty-cycle limit: game time stayed exact (round 2 at t=32.4 s after 92 s),
  9.0-9.4 frames/s delivered (gap p50 100 ms, p95 ~200 ms, p99 ~300 ms, since the coalescer drops the second of two frames
  that arrive together after a CPU stall), practice fell from ~5-6 to ~0.5 rounds/s, and PPO from ~2.5 to ~0.33 updates/s per fighter.
  So the fighters learn about 10x slower than on a full core, and only while awake.
- Cold start of **our** process (Render's ~1 min spin-up comes first): listen 0.2 s, saved brains (138 KB state +
  1.46 MB pool, 300 ms simulated RTT) restored and streaming at **2.3 s**, at 0.1 CPU.
- SIGTERM (deploy, restart, spin-down): save state + pool, `hello{offline}`, close 1012: 1.5 s at 0.1 CPU
  (Render allows 30 s; `SHUTDOWN_TIMEOUT_S=25`).
- Memory: in the Render config at 0.1 CPU, RSS was 102 MB at 1 min and flat at **168-171 MB from minute 5 to 12**.
  At full speed it plateaus at **~300 MB** (20-min soak), with steps at the large pool uploads. JS heaps stay small
  (main ~7 MB, trainer 8-55 MB), so most of it is allocator/V8 reserve. The trainer heap is capped at 256 MB. 512 MB is the limit.
- Disk is ephemeral, so Supabase is the only persistence there (`DATA_DIR` is for the box).
- 750 free instance hours/month per workspace: enough for one service awake 24/7, not for two.

## 6.12 Differences from the in-browser worker
- Speed is fixed at 1 (real time) and practice is always on. Viewers can't pause, change speed, toggle practice, flush or export.
- The trainer thread gets a whole CPU core, not a busy tab. On this box it runs about 4.7 rounds/s and 2,500-2,900
  sim steps/s at 1x (practice fills the spare time), the same code path as the browser at 1x.
- `saved` means "uploaded" (remote, every 60 s), not the worker's local 5 s save. Up to 60 s can be lost on a crash.
- `viz` is pushed about once a second instead of on request, as plain arrays rounded to 4 decimals. `learn` is throttled to 1/s per fighter.
- `epoch` is the persisted reset counter. `ready.sessions` counts server boots. The practice RNG is re-seeded per boot,
  as the browser does per page open. The seed is `ARENA_SEED` (default 1).
- The worker's "IndexedDB unavailable" status text never appears (the server's store is always there). The persistence
  state is in `hello`/`ready` instead.

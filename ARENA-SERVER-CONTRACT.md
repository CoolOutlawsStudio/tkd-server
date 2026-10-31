# TKD-Net Arena contract: section 6, Server mode (owner: Moneyman)

> Additive to `ARENA-CONTRACT.md` sections 1-5 (nothing there changes). Merged into `ARENA-CONTRACT.md` section 6.
> Implementation: `/workspace/tkd-server/` (`server.js`), repo `CoolOutlawsStudio/tkd-server`. Protocol version **1**.
> Reviewed by Waffle (PASS WITH FIXES); her fixes H1, M1, M2 and L1-L4 are in the server and the SQL described here.
> Additions after Kai's review are backward compatible (protocol stays 1): `watch`, `watching`, `saved.ok`.
> F1 (Waffle's live QA, 2026-10-30): Render does not compress WebSockets, so the server now slims the high-rate
> messages to the fields the page reads (`WIRE=page`, default; 6.4, 6.10). Field names are unchanged; `WIRE=full` restores the old payloads.

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
  `<meta name="tkd-server-url">` may override it.
- **Override:** `arena.html?server=wss://host/arena` uses that URL for this visit; `?server=off` forces in-browser mode;
  `?demo` never connects.
- **`wss://` is required** whenever the page is served over https (all three hosts are): browsers block `ws://` from an
  https page as mixed content. `ws://` is only for local tests (`http://localhost`).
- **The page's origin must be in the server's `ALLOWED_ORIGINS`** (6.3), or the upgrade is refused with HTTP 403 and
  the page falls back to in-browser mode. Deployed list: `https://cooloutlawsstudio.github.io`,
  `https://tkd-net.netlify.app`, `https://tkd-net.onrender.com`.
- HTTP endpoints derive from it: replace `wss:` with `https:` and `/arena` with `/health` or `/state`.
- Hosting targets: **Render free web service** (Toml: "Deploy on render"; repo `CoolOutlawsStudio/tkd-server`, URL like
  `wss://tkd-arena-server.onrender.com/arena`) and the box behind a Cloudflare relay. The page never hard-codes a host;
  only `TKD_SERVER_URL` changes. Render specifics: 6.11.

## 6.3 Endpoints
| Endpoint | Purpose |
|---|---|
| `WS /arena` | the live stream (JSON text frames). Other paths answer 404. |
| `GET /health` | `{ ok, state, uptime, version }`; **200** while booting or training, **503** if the trainer is stopped or silent for 30 s (watchdog). For host health checks. |
| `GET /state` | small JSON (about 1.3 KB): `{ server (incl. viewers, watching), elo:{rounds,a,b,se,anchors,at}, stats:{roundsPerSec,stepsPerSec,liveRounds,practiceRounds,wins,updates,droppedTrajectories}, live:{round,t}, framesSent, framesDropped, restored, net }`. For a status badge without opening a socket. A GET to `/state` is an inbound HTTP request, so on Render it also keeps the service awake for 15 min: poll it only on a viewer action. |
| `GET /` | `{ name, ws:'/arena', health, state, protocol }` |

- **CORS** (`/health`, `/state`): `Access-Control-Allow-Origin` echoes the request origin only if it is in
  `ALLOWED_ORIGINS` (default and Render value: `https://cooloutlawsstudio.github.io,https://tkd-net.netlify.app,https://tkd-net.onrender.com`),
  `Vary: Origin`, GET/OPTIONS only.
- **WebSocket Origin check:** a browser `Origin` not in `ALLOWED_ORIGINS` gets HTTP 403 on upgrade. Requests without an
  `Origin` header (curl, test clients, health probes) are allowed unless `ALLOW_NO_ORIGIN=0`.

## 6.4 Messages: server -> page
Every message is one JSON text frame `{ type, ..., epoch }`. Field names and meanings are **those of the worker messages
of section 3**, plus the additive fields below. Typed arrays become plain JSON arrays.
**`WIRE=page` (default) sends a subset** of the ★ messages: only the fields the page (`arena-view.js`) reads, same names
and nesting, numbers rounded to what the page shows, and a field equal to the page's default left out. A client must
treat a missing optional field as its default (listed below). `WIRE=full` sends the section 3 shapes verbatim, at the old rates.
- `frame.state` (page): `t, step, round, timeLeft, fighters[2], score, wins, actions`, plus `done:true` + `endReason` on
  the end-of-round frame and `events` (`[{type, by}]`) when not empty. Left out: `roundSeconds`, `winner`, `mat` (sent
  only if it is not `{size:8, bodyRadius:0.3}`), `done:false`, `endReason:null`, `events:[]`. Each fighter: `x, z, yaw`
  (2 decimals), `action`, `health` (1 decimal), `stamina` (2 decimals), plus `pose` unless `'ready-stance'`, `motion`
  unless `'idle'`, `phase` + `phaseProgress` (2 decimals) unless `phase` is `'none'`, `guarding:true`, `blocking:true`.
  Left out: `y, actionId, poseClass, frame, frames, points, hits, vulnerable, exhausted, blockCooldown`.
  Events of frames skipped by the `FRAME_HZ` limit are merged into the next frame sent (only while someone watches; a replay
  frame carries its own events only), and neither the end-of-round frame nor a frame where a fighter enters the `active`
  phase (the strike) is skipped, so FRAME_HZ 5 sends about 5.5 frames/s.
- `viz` (page): `{ id, fighters:[{probs}] }`, probabilities to 4 decimals (no `layers`/`activations`).
- `learn` (page): `{ fighter, updates, entropy, approxKl, clipFrac }` (4 significant digits), at most every 5 s per fighter (`LEARN_HZ`, page default 0.2).
- `stats` (page): `roundsPerSec, stepsPerSec, practiceRounds, liveRounds, rounds, wins, trainSeconds, updates, practice, speed`
  + `server:{host, bootId, uptime, state, viewers, watching, persistence:{mode}}`, at most every 5 s (`STATS_MS`).
  `trainSeconds` is a whole number, other integers are exact, other floats have 5 significant digits.
  The replay `stats` on connect and on `watch:true` still carries the full `server` field; `/state` has everything.
- `round` (page): `{ round, live, winner, hits, kind }`. Live rounds are always sent; practice rounds at most one per 2 s
  (`PRACTICE_ROUND_MS`), since the page only advances its counter with `max(counter + 1, round)`.
- `hello{heartbeat:true}` (page): `server` is the short form above and `version` is left out (both are in the first `hello`).

| type | when | fields (beyond section 3) |
|---|---|---|
| `hello` | **always the first message**, then on every state change (`change:true`), every 20 s (`heartbeat:true`), as the reply to a client `hello` or `watch` (`reply:true`; after `watch` also `watch:true|false`), after an admin reset (`reset:true`) | `protocol:1, state, since, message, rounds, viewers, watching, persistence, version, server` (6.5) |
| `ready` | after `hello` (replay) and whenever the trainer (re)starts | section 3 `ready` + `mode:'server'`, `persistence:'supabase'|'file'|'memory'`, `storage` (true if persisted), `server` |
| `status` | replay, then on change | section 3 + `mode:'server'`. `state` is the trainer's (`loading`/`running`/`paused`/`error`). The page should show `hello.state` as the headline. |
| `history` | after `ready` (replay and on each trainer start) | the `arena-store` `history` record, bounded: `{ rounds:[{round,winner,hitsA,hitsB,live,kind}] (last 100), elo:[{rounds,a,b,vsScripted,vsPast,games,trainSeconds,at}] (last 120), replay:true }` (`WIRE=full`). `WIRE=page` (default) leaves out `rounds` (the page reads `elo` only) and sends `{ elo, replay:true }`: the same last 120 entries thinned to at most 60 points (the newest 20 as they are, the older ones evenly spaced, the first always kept), each `{rounds,a,b}` with `a`/`b` rounded to 0.1; the last entry is exact `{rounds,a,b,at}`. About 2 KB instead of ~22 KB. This replaces `store.loadHistory()` in server mode. |
| `frame` ★ | live match, **10/s** (at most `FRAME_HZ`, default 15, coalesced: only the newest frame is sent) | section 3 `frame` + `seq` (server frame counter); `state` slimmed under `WIRE=page` (above). One `frame` with `replay:true` on connect and on `watch:true`. |
| `round` ★ | every finished live round; practice rounds ~4-5/s (`WIRE=full`) or at most 1 per 2 s (`WIRE=page`) | section 3 `round` (`WIRE=page`: subset above) |
| `elo` | every ~25 rounds; the newest one again as replay on connect | section 3 `elo` unchanged |
| `stats` ★ | every ~2 s (`WIRE=page`: at most every 5 s, subset above) | section 3 `stats` + `server`. `stats.wins` counts **all** rounds (live + practice): show it in the stats panel only. The HUD shows the **live match's** wins, counted from live `round` messages (`live:true`). |
| `viz` ★ | every `VIZ_MS` (default 1 s, Render 5 s), computed only while at least one viewer is watching (`id:'server-<n>'`) | `WIRE=page`: policy `probs` only (above). `WIRE=full`: section 3 `viz`, activations rounded to 4 decimals; `weightDelta` is the change since the previous server `viz` |
| `learn` ★ | at most 1/s per fighter with `WIRE=full`, every 5 s with `WIRE=page` (the newest) | section 3 `learn` (`WIRE=page`: subset above) |
| `saved` | after each **successful remote** save (not the worker's local 5 s saves); the newest one again as replay on connect | `{ ok:true, remote:true, persistence, generation, rounds, trainSeconds, bytes, stateBytes, poolBytes, pool, at, ms, why }`. Only successes are sent as `saved`, so `ok` is always `true`. A failed upload is reported as today: `status{state:'running', message:'could not save the brains: …'}` and in `persistence.failures/lastError` (6.5). Memory-only servers never send `saved`: show "not saved (server memory only)" from `ready.persistence`/`hello.persistence.mode`. |
| `error` | trainer error, or a refused client message | `{ message, code? }` with `code`: `full`, `protocol`, `forbidden`, `not-accepted`, `rate`, `invalid` |
| `pong` | reply to `ping` | `{ t, serverTime }` |

★ = high-rate. A socket that sent `watch` with `on:false` gets **none** of the ★ messages (6.6); it still gets `hello`
(changes, the 20 s heartbeat and replies), `ready`, `status`, `history`, `elo`, `saved`, `error` and `pong`. Measured
(`test/test-watch.js`, default config, permessage-deflate): **about 0.02 KB/s** on the wire. A watching viewer: 6.10.

**`epoch`:** the server's reset counter, persisted with the brains. It only changes on an admin reset (it does **not**
go back to 0 when the server restarts). A page that sees a higher `epoch` clears its charts and keeps going; older
epochs are ignored, as in section 3. A server restart is visible as a new `server.bootId`.
**A restart (new `bootId`) with the same `epoch` is silent:** keep the charts and the round list, don't announce the
restart. Only a higher `epoch` (admin reset) clears them.

**Order on connect** (after the client's `hello`, or after 1 s if it sends none):
`hello`, `ready`, `status`, `history`, `elo`, `stats`, `saved`, `frame` (each only if available; all but `hello`
carry `replay:true`; `stats` and `frame` are left out if the socket already sent `watch:false`). Total about 30-60 KB.
Then live messages.

## 6.5 `hello` and the `server` field
```
{ type:'hello', protocol:1, epoch:0,
  state: 'waking'|'resuming'|'training'|'paused'|'offline',
  since: ISO time the state began, message: text or null,
  rounds, viewers, watching, persistence:{...}, version:{ server:'1.0.0', protocol:1, files:{'arena-sim.js':'6952e844', ...}, rl, sim },
  server:{ host, bootId, startedAt, uptime (s), state, since, message, trainSeconds, rounds, viewers, watching, maxViewers,
           frameHz, restarts, epoch, persistence, version, memory:{ rssMB, mainHeapMB, workerHeapMB, at } },
  change?:true, heartbeat?:true, reply?:true, reset?:true, watch?:true|false (only in the reply to a `watch`) }
```
`viewers` = open sockets; `watching` = sockets with `watch` on (the default), i.e. visible tabs. Show
"Training with `watching` watching". Counts are current in every `hello` (including the 20 s heartbeat), in
`stats.server` and in `/state`; a change of `watching` alone does not broadcast a `hello`.
| state | meaning | page shows (suggestion) |
|---|---|---|
| `waking` | process just started (loading saved brains, under 1 s), or starting fresh brains (first run, memory-only, load failed). Before the process exists (Render spinning up, ~1 min) the page shows its own "Waking the server…" (6.9) | "Server starting…" |
| `resuming` | restoring saved brains, or restarting the trainer after a crash | "Resuming saved fighters…" |
| `training` | live match running, both fighters learning | "Live from server: training with N watching" (N = `watching`) |
| `paused` | saving before a restart/deploy, or trainer crashed (auto-restart with backoff 5 s .. 5 min) | "Server paused: `message`" |
| `offline` | sent once just before a clean shutdown; the page also uses it when it cannot connect | "Server offline, training in your browser" |

`persistence` = `{ mode:'supabase'|'file'|'memory', where, note, generation, poolGeneration, savedAt, bytes,
poolSavedAt, poolBytes, loadedAt, loadedGeneration, saves, failures, lastError, lastErrorAt, fallbacks, conflicts }`
(`conflicts` = `ARS409` generation conflicts resolved by adopting the stored generation, 6.7).
`mode:'memory'` with a `note` means nothing survives a restart. The page should say so.

## 6.6 Messages: page -> server
Only these are accepted (anything else gets `error{code:'not-accepted'}` and is ignored; the match is shared, so
`start`, `pause`, `resume`, `speed`, `practice`, `flush`, `viz`, `export` are **not** honoured):
| type | fields | reply |
|---|---|---|
| `hello` | `{ protocol:1, epochSeen }` | the first one triggers the replay snapshot; later ones get `hello{reply:true, epochChanged}`. A different `protocol` gets `error{code:'protocol'}` and close 4000. |
| `ping` | `{ t }` | `pong{t, serverTime}`. Send only while connected **and the tab is visible** (6.9). |
| `watch` | `{ on: true\|false }` | `on:false`: the server stops sending the ★ messages of 6.4 to **this** socket (within one message; tested < 1 s) and it no longer counts in `watching`. `on:true`: `hello{reply:true, watch:true}`, then `status`, `stats` and the last `frame` again with `replay:true`, then the live stream resumes. Every socket starts with `on:true`. The reply to both is `hello{reply:true, watch}` with the new counts. Anything but a boolean `on` gets `error{code:'invalid'}`. Send it **only on a visibility change** (`visibilitychange`): `watch:false` when the tab is hidden, `watch:true` when it is visible again. It is an ordinary inbound message (same rate limit), not a keep-alive: never send it periodically. |
| `reset` | `{ token }` | **admin only**: `token` must equal the `ADMIN_TOKEN` env var (>= 16 chars; unset = reset disabled), compared in constant time, at most 1 per minute. Deletes both brains, pool, history and every stored generation, then `epoch` + 1. Otherwise `error{code:'forbidden'}`. |
Limits: messages up to 4 KB; 2 messages/s sustained (burst 20), more closes the socket with 1008.

## 6.7 Persistence (Supabase, anon key + server secret, never service_role)
- Records are exactly the `arena-store.js` records (`brains`, `pool`, `history`, `meta`, section 4). The worker
  saves them into its in-memory IndexedDB every ~5 s as in the browser. The main thread uploads the newest:
  - kind **`state`** = `{brains, history, meta}`: every 60 s (`SAVE_EVERY_S`) if anything changed, and on SIGTERM/SIGINT.
    Measured about **134-136 KB** (brains alone 133 KB).
  - kind **`pool`** = `{pool}` (opponent snapshots + frozen milestones): on the first save, then at most every 10 min
    (`POOL_SAVE_EVERY_S`) when it changed, and on SIGTERM. **Bigger than the 100-200 KB target**: 0.2 MB early, about
    **1.3 MB** once the pool is full (26 networks of 12,517 floats). Saving it rarely keeps writes to about 190 MB/day at the 10 min default; Render uses `POOL_SAVE_EVERY_S` 3600 (about 1.3 MB/h).
- Encoding: JSON with typed arrays as `{"__ta":"Float32Array","b64":...}` (lossless), gzipped, base64 text.
  `sha256` of that text is checked by SQL on save and by the server on load.
- **Generations:** every upload has a generation number, monotonic per kind. The newest 2 per kind are kept. On load the
  server takes the newest generation that passes the sha/format checks and falls back to the older one otherwise.
  A writer whose generation is not newer is refused (`ARS409`), so a stale second instance can't overwrite newer brains.
  On `ARS409` the server adopts the stored generation and retries that upload once (`persistence.conflicts` counts it).
- **Security** (`supabase_arena_server.sql` sha 8fc7d3c4, Waffle-reviewed, **applied live** to the project on 2026-10-30 at 8:40 pm PT, with the secret's hash inserted): tables
  `public.arena_brains` and `public.arena_server_config` with RLS on and **no policies** (not FORCEd, so the definer
  functions still see the rows), and no table privileges for `anon`/`authenticated`, so the REST table API can't touch
  them. No Nova table is touched. The only way in is 3 `SECURITY DEFINER` functions (`search_path=''`), executable by
  `anon` only: `arena_save`, `arena_load` and `arena_clear`; the internal `arena_secret_ok` is not callable by
  `anon`/`authenticated`. Each one requires `p_secret` (32-256 bytes), whose SHA-256 (built-in `pg_catalog.sha256()`,
  no pgcrypto needed) must equal the single row of `public.arena_server_config`. All three are `VOLATILE`, so PostgREST
  accepts them by POST only and the secret never appears in a GET query string. The script is idempotent and runs in
  one transaction; the secret's hash is inserted as a separate step. The secret exists only in the host's
  `SERVER_SECRET` env var, and the database stores only its hash. The public anon key alone can do nothing. The server
  refuses to start persistence with a key whose JWT role is `service_role` or that starts with `sb_secret_`
  (anon JWTs and `sb_publishable_` keys are fine).
  **One server per Supabase project at a time:** the box and Render must not both run against the same project, or
  they overwrite each other's generations in turns (the `ARS409` adoption makes a deploy overlap safe, not two live
  instances).
  Errors: `ARS401` bad secret, `ARS400` bad args, `ARS409` stale generation, `ARS413` payload > 4 MB or meta > 16 KiB, `ARS422` sha mismatch.
  - Rejected alternative: a private Storage bucket. Storage RLS policies can only see the JWT role/uid, not a
    per-request secret, so either the anon key could write it or we'd need the service_role key (forbidden) or a
    signed-in Supabase user for the server (a signup).
- **Optional:** with `SUPABASE_*`/`SERVER_SECRET` unset the server runs **memory-only** and says so (`persistence.mode`,
  `note`, `hello.message`). With `DATA_DIR` set (and no Supabase), it uses atomic JSON files there: same envelope,
  generations and keep-2 rule. That's useful on the box. If the initial load fails (bad secret, outage), the server
  retries it after 5, 15 and 45 s (not on `ARS401`), then runs memory-only **and does not save**, so it never overwrites good stored brains with fresh ones.
- **Loss bound:** a crash loses at most 60 s of training (the 5 s bound of the browser is for its local IndexedDB).
  A clean SIGTERM loses nothing: pause -> local save -> upload of state + pool -> `hello{state:'offline'}` -> close
  1012, about 0.1 s in tests (timeout `SHUTDOWN_TIMEOUT_S`, default 20 s).

## 6.8 Flow control, limits, idle
- **Frames:** the trainer posts 10 frames/s. The main thread keeps only the newest and sends at most `FRAME_HZ`
  (default 15, Render 5 since render.yaml b351830c)/s, serialised **once** for all viewers. The server offers permessage-deflate (`WS_DEFLATE`),
  but **Render's proxy does not negotiate it** (Waffle's live QA, 2026-10-30), so on Render every byte goes out
  uncompressed. That is why `WIRE=page` slims the payloads (6.4, 6.10).
- **Message volume knobs:** `WIRE` (`page` default, `full`), `FRAME_HZ`, `VIZ_MS` (viz push period, default 1000,
  Render 5000), `LEARN_HZ` (default 0.2 with `WIRE=page`, 1 with `full`), `STATS_MS` (5000 / 0), `PRACTICE_ROUND_MS`
  (2000 / 0), `ROUND_MSGS=live` (forward only live-round `round` messages; default `all`).
- **Backpressure:** a viewer with more than 64 KB unsent skips frames (counted in `framesDropped`; other messages
  still go). Above 2 MB unsent it is disconnected. The trainer never waits for a socket.
- **Max viewers:** `MAX_VIEWERS` (default 100). Viewer 101 gets `error{code:'full'}` and close 1013, then falls back.
- **Heartbeat:** every 20 s, a WebSocket ping (no pong by the next round = terminated) and a `hello{heartbeat:true}`.
  That is under Cloudflare's 100 s idle-socket timeout, so a relayed socket stays open.
- **Idle (0 viewers, or only `watch:false` viewers):** training continues at full speed (that's the point). Frames
  are not serialised and `viz` is not computed.
- **Memory guard:** RSS, main heap and trainer heap are logged every 60 s and shown in `server.memory`. Histories are
  capped (worker: 500 rounds and 2,000 Elo points, thinned. Server: 500 rounds and 200 Elo points; replay 100/120, `WIRE=page` 0 rounds and the last 120 Elo points thinned to at most 60).
  The trainer thread has a V8 heap cap (`WORKER_HEAP_MB`, 512). If it crashes or stops talking for 30 s, it is
  restarted from the newest records in memory (backoff 5 s .. 5 min).

## 6.9 Page fallback (Kai)
The page shows which mode is active ("Live from server" / "In your browser") plus the honest server state of 6.5.
1. If `TKD_SERVER_URL` is empty or `?server=off`: in-browser worker as today.
2. Otherwise open the WebSocket and show "Connecting to server…". **Start the in-browser worker** if any of these
   happen: no `hello` within 8 s, a close before the first `hello`, `error{code:'full'|'protocol'}`, or `hello.state`
   is `offline`. Say which mode is active ("Live from server" / "Training in your browser: server offline").
   **Waking a sleeping Render service:** a sleeping host is woken only by a viewer's action: the page open, or a
   click on "Try server again". The first connection attempt wakes it (~1 min; until then Render answers with its own
   loading page without CORS, so the socket or fetch simply fails). So retry the socket every 5 s for **at most 90 s**
   while showing "Waking the server…", with the in-browser match running meanwhile, and switch to the server stream
   when its `hello` arrives. **After 90 s stop retrying**: show "Server offline, running in your browser" and a
   **"Try server again"** button, which starts one more 90 s window. Never retry in the background forever.
   **While connected and the tab is visible, send `{type:'ping'}` every 60 s.** On Render free, inbound WebSocket
   messages keep the service awake (protocol-level pongs may not count).
   **Hidden tabs** (`document.hidden`): send `{type:'watch', on:false}` once, stop the 60 s `ping`, and send nothing
   else. Back to visible: `{type:'watch', on:true}` (the server replays status, stats and the last frame) and resume
   the `ping`. So a service whose only viewers are hidden tabs sleeps after 15 min, which is intended (no external
   keep-alive). When it went to sleep under a hidden tab, the socket closes; handle that like rule 3 when the tab is
   visible again.
3. While connected: a socket close (1012 = server restarting, 1006 = network) -> "Reconnecting…", retry with backoff
   (1, 2, 4 … 30 s), within the same 90 s limit. Then switch to in-browser with the "Try server again" button, as in
   rule 2. Optionally poll `/state` first to see `state` without a socket (also only on a viewer action).
4. Ignore messages with an older `epoch`. On a higher `epoch`, clear the charts and the round list. A new
   `server.bootId` with the same `epoch` (restart, deploy, wake from sleep) is silent: keep everything, no message.
5. Never send `pause`/`speed`/`practice`/`flush`/`reset` in server mode. Hide those controls and show "shared match".
   The page sends only `hello`, `ping` and `watch`.
6. HUD: show the **live match's** wins (from live `round` messages); `stats.wins` (all rounds, incl. practice) belongs
   in the stats panel.
7. In-browser mode and server mode have separate brains. The server never reads the page's IndexedDB. When switching
   to the server, flush the local worker (wait for its `saved`, at most 1.5 s) and terminate it: never two sims or two
   sockets at once.

## 6.10 Bandwidth (measured on the box 2026-10-30/31, `test/bandwidth.js 60` and Waffle wire-qa r2, one watching viewer, permessage-deflate OFF as on Render)
**Render does not compress.** Its proxy does not offer permessage-deflate (Waffle's live QA: ~10.7 KB/s per watching
viewer on the live service), so the earlier "~1.2 KB/s" (measured with deflate on the box) was wrong for Render.
Render-like env: `WS_DEFLATE=0 VIZ_MS=5000`. KB = 1024 B, MB = 10^6 B. Each run is 60 s after warm-up.
| setting | frame | other msgs | **per viewer** | per hour | viewer-hours per 5 GB |
|---|---|---|---|---|---|
| `WIRE=full`, FRAME_HZ 10 (what Render ran, pre-F1) | 9.08 KB/s (935 B x 9.95/s) | 2.74 KB/s | **11.82 KB/s** | 43.6 MB | 115 |
| `WIRE=page`, no throttles (`STATS_MS=0 LEARN_HZ=1 PRACTICE_ROUND_MS=0`), FRAME_HZ 10 | 4.01 KB/s (412 B) | 0.90 KB/s | 4.91 KB/s | 18.1 MB | 276 |
| `WIRE=page` (default), FRAME_HZ 10 | 4.01 KB/s (410 B x 10/s) | 0.28 KB/s | **4.29 KB/s** | 15.8 MB | 316 |
| `WIRE=page`, FRAME_HZ 6 | 2.68 KB/s (415 B x 6.62/s) | 0.26 KB/s | 2.94 KB/s | 10.8 MB | 462 |
| `WIRE=page`, FRAME_HZ 5 (`render.yaml`) | 2.25 KB/s (417 B x 5.53/s) | 0.27 KB/s | **2.52 KB/s** | 9.3 MB | 539 |
| `WIRE=page`, FRAME_HZ 4 | 1.92 KB/s (421 B x 4.67/s) | 0.25 KB/s | **2.17 KB/s** | 8.0 MB | 626 |
The `WIRE=page` rows were re-measured after wire-qa P6 (the frame where a strike starts is sent even between
`FRAME_HZ` ticks, so 5-15% more frames than `FRAME_HZ`); `test/test-wire.js` measured 2.56 KB/s at FRAME_HZ 5 over 20 s.
Pre-F1 per type (`WIRE=full`, FRAME_HZ 10): frame 9,300 B/s, viz 797 (3,986 B every 5 s), stats 692 (1,432 B, 1,028 of it
the `server` field), round 674 (150 B x 4.5/s practice rounds), learn 439, hello heartbeat 91, elo 45.
With `WIRE=page`: frame 4,096 B/s at 10 Hz, stats 52, elo 45, round 43, learn 39, viz 37, hello 36 (B/s).
Rounding floats alone saves about 1% of a frame (the sim already rounds), so the frame saving comes from leaving out
unused and default-valued fields. The ~410 B frame is about the floor for this JSON shape: at 10 Hz the 2 KB/s target
needs a client change (a compact array frame, about 90-120 B, or a delta encoding), which is not implemented.
`test/test-wire.js` (in `npm test`) asserts <= 4.8 KB/s at FRAME_HZ 10 and <= 2.9 KB/s at FRAME_HZ 5 (uncompressed).
A `watch:false` viewer gets only the hello heartbeat (712 B per 20 s) and the `elo` messages (~280 B each): 0.06-0.08 KB/s uncompressed (Waffle wire-qa r2), 0 frames (pre-F1 ~1.8 KB per 20 s; Waffle measured 0.084 KB/s live).
On connect a viewer also gets the replay snapshot (6.4: hello, ready, status, history, elo, stats, frame). Measured
`WIRE=page`, FRAME_HZ 5, one connect at each uptime (KB = 1024 B):
| uptime | boot (first s) | 2 min | 5 min | 8 min | 11 min | 15 min (history full) |
|---|---|---|---|---|---|---|
| before (b158748a, P1-P7: all 120 Elo entries in full; Waffle r2: 29.4 KB plateau, history 23.5 KB) | 3.59 | 9.42 | 15.67 | 21.46 | 26.92 | **27.46** |
| now (thinned, slim Elo points) | 3.59 | 6.48 | 7.55 | 7.73 | 7.77 | **7.83** |
At 15 min: hello 1.8 KB, ready 1.7 KB, history 2.1 KB (60 points over the last 120 benchmarks, 10.5-15 min of
training depending on CPU), stats 1.4 KB, elo 0.3 KB, frame 0.4 KB, status 0.1 KB. The boot column is the first seconds (no stats, elo or
frame yet); once those exist and before the first benchmark it is about 5.9 KB (Waffle r2). A reconnect to a warm
server now costs about 3 s of watching at FRAME_HZ 5 (was about 11 s). `test/test-file-and-limits.js` seeds a 300-entry Elo history and
asserts the `WIRE=page` snapshot stays under 10 KB, and that `WIRE=full` still sends the 120 stored entries verbatim.
The Supabase checkpoints are outbound too (below), so a single-viewer awake hour at FRAME_HZ 5 costs about
9.3 MB (viewer) + 8.2 MB (state) + ~1.3 MB (pool) = ~18.8 MB: about 265 such hours per 5 GB (Waffle r2: 18.7 MB, 267 h),
not 540; each extra viewer adds 9.3 MB/h.
Plus the server's own uploads to Supabase (also outbound on Render): state 136 KB per 60 s = **8.2 MB per awake hour**,
and the pool 1.3-1.5 MB hourly plus on every SIGTERM (each spin-down). So an always-awake service would use about
6-7 GB/month in checkpoints alone. On Render free it is only awake while watched, plus 15 min. Use
`SAVE_EVERY_S=120..300` if the 5 GB gets tight.

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
- `viz` is pushed every `VIZ_MS` instead of on request (`WIRE=page`: policy `probs` only). `learn` is throttled to one per 5 s per fighter (`WIRE=page`; 1/s with `WIRE=full`). High-rate messages are slimmed (6.4).
- `epoch` is the persisted reset counter. `ready.sessions` counts server boots. The practice RNG is re-seeded per boot,
  as the browser does per page open. The seed is `ARENA_SEED` (default 1).
- The worker's "IndexedDB unavailable" status text never appears (the server's store is always there). The persistence
  state is in `hello`/`ready` instead.

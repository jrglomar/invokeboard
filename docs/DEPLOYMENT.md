# Deployment Guide — InvokeBoard

How to run the stack with Docker, what to configure, and what to harden before a
real (non-local) deployment. For local dev without Docker, see `docs/SETUP.md`.
For how the pieces connect, see `docs/ARCHITECTURE.md`.

> **What gets deployed:** the two MCP **HTTP bridges** (`mcp-jira`, `mcp-github`)
> and the **web** SPA. The **stdio** MCP servers are a local VS Code Copilot
> integration and are **not** containerized.

---

## 1. Prerequisites

- **Docker Desktop / Engine 24+** with Compose v2 (`docker compose version`).
- A **Jira Cloud API token** (Atlassian → Account → Security → API tokens) and the
  account email.
- A **GitHub token** (PAT, `repo` scope) if you want PR tools.
- The Jira **board IDs** + project keys for your Dev and PO boards.
- *(Optional)* An AI key — GitHub Models token or Anthropic key — for AI drafting.

---

## 2. Quick start (single host)

```bash
# 1) Configure
cp .env.docker.example .env
#    edit .env → real JIRA_*, GITHUB_*, board IDs (and optional AI keys)

# 2) Build + run
docker compose up --build -d

# 3) Open the dashboard
#    http://localhost:8080
```

That's it. `web` serves the SPA on `:8080` and proxies API calls to the bridges
over the internal network — so the browser only ever talks to `:8080`.

Check health:

```bash
curl http://localhost:8080/jira/api/health      # via the proxy
curl http://localhost:8080/github/api/health
# bridges are also exposed directly (optional, for debugging):
curl http://localhost:4001/api/health
curl http://localhost:4002/api/health
```

Tear down:

```bash
docker compose down            # stop + remove containers
docker compose down -v         # …and delete the invokeboard-data volume (leaves/team JSON)
```

---

## 3. Configuration

### 3.1 Environment variables

All services read from the single root `.env` (`env_file: .env`). Each reads only
the keys it needs; extras are ignored. Full annotated list: `.env.docker.example`.

| Variable | Service(s) | Required | Purpose |
|---|---|---|---|
| `JIRA_BASE_URL` | jira, github | ✅ | `https://your-org.atlassian.net` |
| `JIRA_EMAIL` | jira, github | ✅ | Atlassian account email |
| `JIRA_API_TOKEN` | jira, github | ✅ | Atlassian API token |
| `JIRA_DEV_BOARD_ID` / `JIRA_PO_BOARD_ID` | jira | ✅ | numeric board IDs |
| `JIRA_DEV_PROJECT_KEY` / `JIRA_PO_PROJECT_KEY` | jira, github | default DEV/PO | project keys |
| `JIRA_STORY_POINTS_FIELD` | jira | default `customfield_10016` | story-points custom field |
| `JIRA_LINK_TYPE`, `JIRA_FLAGGED_FIELD`, `JIRA_CODE_REVIEW_STATUSES`, `JIRA_VELOCITY_SPRINTS` | jira | defaults | field/behaviour mapping |
| `GITHUB_TOKEN` | github | ✅ | PR reads + comments |
| `GITHUB_REPO` | github | optional | default `owner/repo` |
| `AI_PROVIDER` (+ `GITHUB_MODELS_TOKEN` / `ANTHROPIC_API_KEY`) | jira | optional | enables AI drafting; unset = deterministic templates |
| `CORS_ORIGINS` | jira, github | optional | allowlist when the browser hits the bridges cross-origin (not needed with the proxy) |
| `JIRA_LEAVES_FILE` / `JIRA_TEAM_FILE` | jira | set by compose | JSON store paths (→ `/data` volume) |
| `STORAGE_DRIVER` | jira | optional, default `json` | `json` (per-file), `sqlite` (one db file — §3.3) or `mysql` (v1.74 — §3.4, §9) |
| `STORAGE_SQLITE_FILE` | jira | optional, default `.invokeboard-stores.sqlite` | sqlite db path; only used when `STORAGE_DRIVER=sqlite` |
| `STORAGE_MYSQL_URL` | jira | required iff `STORAGE_DRIVER=mysql` | `mysql://user:pass@mysql:3306/invokeboard` — `docker-compose.prod.yml` builds it from `MYSQL_*` |
| `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD` | mysql (prod compose) | ✅ in prod | MySQL bootstrap; URL-safe passwords (`openssl rand -hex 24`) |
| `CF_TUNNEL_TOKEN` | cloudflared | ✅ if tunnelling | Cloudflare Tunnel token |
| `MCP_JIRA_HTTP_PORT` / `MCP_GITHUB_HTTP_PORT` | jira / github | default 4001 / 4002 | bridge ports |

### 3.2 The SPA's bridge URLs are baked at BUILD time

The React app resolves `VITE_MCP_JIRA_URL` / `VITE_MCP_GITHUB_URL` when Vite
builds — **not** at runtime. `docker-compose.yml` passes them as build args
(default `/jira`, `/github` — the same-origin proxy paths). If you change them you
must **rebuild** the `web` image:

```bash
docker compose build web && docker compose up -d web
```

### 3.3 Persistent state

`mcp-jira` keeps two JSON files (per-sprint leaves, curated team roster). Compose
mounts the named volume `invokeboard-data` at `/data` and points `JIRA_LEAVES_FILE` /
`JIRA_TEAM_FILE` there, so they survive `up`/`down`/rebuilds. Back them up by
copying out of the volume:

```bash
docker run --rm -v invokeboard_invokeboard-data:/data -v "$PWD":/backup alpine \
  sh -c "cp /data/.invokeboard-*.json /backup/ 2>/dev/null || true"
```

Store writes are crash-atomic as of v1.63 (ADR-075): each write lands in a same-directory
`*.tmp` file first and is renamed over the target, so a hard crash or `kill -9` mid-write
can't corrupt a store — a stray `*.tmp` left behind by such a crash is harmless leftover
(every store's read path only ever opens the real filename) and safe to delete.

**Storage driver option — `sqlite` (v1.65, ADR-077).** Every store's IO now goes through one
storage port with two drivers. `STORAGE_DRIVER=json` (the default) is exactly the behavior
above — per-file JSON, `*_FILE` overrides honored, and it has **no native dependency**, so the
image builds and runs in any environment. `sqlite` mode uses the **optional** `better-sqlite3`
native module: it installs from a prebuilt binary on common platforms, but if your build host
can't fetch that binary and lacks a C/Python toolchain, `better-sqlite3` simply doesn't install
(it's an `optionalDependency`, so `npm ci` still succeeds and the app runs fine on `json`). To
actually use `STORAGE_DRIVER=sqlite`, build in an environment where `better-sqlite3` can install
— either one that can download its prebuilt binary, or one with `python3` + a C compiler
(`make`, `g++`) available for the source build. Requesting `sqlite` without the module installed
fails at startup with a clear message pointing back to `STORAGE_DRIVER=json`. Setting
`STORAGE_DRIVER=sqlite` moves ALL
11 stores (not just leaves/team — impediments, PRs, post-scrum, meeting-goal, meeting-notes,
retro, offset, users, and every per-user journal too) into ONE `better-sqlite3` database file,
`STORAGE_SQLITE_FILE` (default `.invokeboard-stores.sqlite`, resolved the same way the JSON
defaults are). `docker-compose.yml`'s jira service has both lines ready, commented out —
uncomment `STORAGE_DRIVER: sqlite` and `STORAGE_SQLITE_FILE: /data/.invokeboard-stores.sqlite`
to put the db file on the same persisted volume as the JSON stores. Per-store `*_FILE`
overrides don't apply in sqlite mode (there's one file, not eleven).

**Switching to sqlite on an existing deployment auto-imports once.** The first time the
bridge opens a sqlite file whose `docs` table is empty, it scans the JSON stores at their
current (json-driver) paths and imports every doc it finds in one transaction, logging a
loud multi-line summary of what was imported to the container's stdout/stderr (`docker
compose logs jira`). The original JSON files are left untouched — they become a natural,
human-readable backup of the pre-switch state. This import runs exactly once: any later
restart sees a non-empty `docs` table and skips it, even if you leave the old JSON files in
place.

**Backup.** With `STORAGE_DRIVER=sqlite`, back up `STORAGE_SQLITE_FILE` — one file instead of
eleven-plus-per-user; it lives on the same `invokeboard-data` volume, so the existing backup
command above (and the nightly-cron example in §5, item 5) already covers it once `docker
cp`/tar picks up the whole volume. The same `.env`-never-travels-with-the-data-volume rule
applies — `.invokeboard-stores.sqlite` holds the same sealed tokens `.invokeboard-users.json` did.

### 3.4 MySQL storage (v1.74, ADR-085)

`STORAGE_DRIVER=mysql` keeps the exact same one-table shape (`docs`: scope, name, data, updated_at) in
MySQL. The storage port is synchronous, so the bridge **loads every doc into memory at startup**. You'll
see `[storage] STORAGE_DRIVER=mysql (...): loaded N doc(s)` in `docker compose logs jira`. Reads come
from that cache, and writes are saved to MySQL **behind** it through one serialized queue. If MySQL
blips, the queue retries with backoff, and `docker compose stop/down` flushes it. Operationally:

- **Run exactly one `jira` replica** (§5.8). A second one would serve a stale cache.
- A **hard kill** (SIGKILL, OOM, power loss) can drop writes still in the queue, which are typically
  milliseconds old. Normal stops and redeploys flush first (`stop_grace_period: 15s`).
- **Edits made directly in MySQL** (manual SQL, a restore) are not seen until `jira` restarts.
  `scripts/restore-mysql.sh` stops and starts it for you.

### 3.5 Exporting all data (any driver → a portable bundle)

```bash
node scripts/export-data.mjs                                          # local stack (docker-compose.yml)
node scripts/export-data.mjs --compose-file docker-compose.prod.yml   # a sqlite/json-backed prod stack
```

This writes `./backups/<timestamp>/`, containing:
- `invokeboard-export-*.json`: the portable bundle, with every (scope, name) doc.
- `invokeboard-stores-*.sqlite`: a consistent online copy (sqlite driver).
- `invokeboard-data-volume.tar.gz`: a raw `/data` tar.

It then checks the bundle's doc count against the live table. `backups/` is git-ignored and
docker-ignored. **The bundle contains sealed tokens**, so store it apart from `.env` (§5.5). On a MySQL
deployment, back up with `scripts/backup-mysql.sh` instead (§9.5).

---

## 4. Operations

```bash
docker compose ps                     # status + health
docker compose logs -f jira           # follow one service
docker compose logs -f                # all services
docker compose up -d --build jira     # rebuild + restart one service
docker compose restart web            # restart without rebuild
```

Each bridge has a Docker `HEALTHCHECK` hitting its own `/api/health`; `docker
compose ps` shows `healthy`/`unhealthy`.

---

## 5. Production hardening

This repo is a POC. Before exposing it beyond a trusted host, work through this
checklist (TLS, `NODE_ENV`, token scope, backups, and the one-replica rule below
were added/expanded per a v1.63 security review — ADR-075):

1. **TLS / HTTPS — mandatory, not optional.** Two things cross this hop in clear
   if you skip it: a Jira/GitHub/AI token pasted into the Connections tab
   (`CONTRACTS.md` §8.4), and the Task Helper session cookie itself (whose
   `secure` flag only means anything once there's HTTPS to be secure over — see
   the next item). Terminate TLS in front of `web`; the two lowest-ceremony
   options are **Caddy** (point it at the `web` container and it gets you
   auto-renewing Let's Encrypt HTTPS in a ~5-line Caddyfile, no cert management)
   or **nginx + certbot** (run certbot against `docker/nginx.conf`'s server block
   and cron its renewal). Either way: don't serve creds-bearing traffic over
   plain HTTP.
2. **`NODE_ENV=production` — required for the session cookie's `secure` flag.**
   `sessionCookieOptions()` in `packages/mcp-jira/src/routes/taskHelper.ts` sets
   `secure: process.env.NODE_ENV === "production"` on the Task Helper session
   cookie; anything else ships that cookie over HTTP too, even behind TLS.
   **Verified for this repo's own images:** `docker/jira.Dockerfile` and
   `docker/github.Dockerfile` both bake `ENV NODE_ENV=production` in at build
   time, and neither `docker-compose.yml`'s `environment:` block nor
   `.env.docker.example` overrides it — so `docker compose up --build` already
   ships this correctly out of the box. If you run `mcp-jira` outside these
   images (bare `node`/`tsx`, your own compose file, PM2, a serverless wrapper),
   set `NODE_ENV=production` yourself in that environment.
3. **Secrets.** Never commit `.env`. Use your platform's secret store (Docker/
   Swarm secrets, Kubernetes Secrets, cloud secret managers) and inject at
   runtime.
4. **Token scope.** Prefer **fine-grained GitHub PATs** over classic
   account-wide `repo`-scope tokens — `docs/SETUP.md` already documents the
   exact permissions to grant (Pull requests + Issues: Read and Write, plus the
   Models: Read account permission if you're using GitHub Models for AI).
   Prefer **Atlassian API tokens with scopes** over classic account-wide ones
   where your Atlassian plan offers them. Set expiries on every token. Rotation
   is just a reconnect: paste the new token into the Connections tab and it
   seals + replaces the stored one — no restart needed.
5. **Back up the data volume — and never bundle it with `.env`.** Schedule a
   periodic backup of the `invokeboard-data` volume (the per-sprint JSON stores —
   see §3.3), e.g. a nightly cron on the Docker host:
   ```bash
   # crontab -e
   0 2 * * * docker run --rm -v invokeboard_invokeboard-data:/data \
     -v /backups/invokeboard:/backup alpine \
     tar czf /backup/invokeboard-data-$(date +\%Y\%m\%d).tar.gz -C /data .
   ```
   **Hard rule: `.env` must NEVER travel in the same backup artifact as the data
   volume.** `.env` holds `TOKEN_ENC_KEY`, the AES-256-GCM key that decrypts
   every sealed Jira/GitHub/AI token sitting in `.invokeboard-users.json` inside
   that same volume — ship them together and whoever gets the backup gets the
   plaintext tokens too, no different from committing `.env` outright. Keep
   `TOKEN_ENC_KEY` (and `SESSION_SECRET`) in your platform's secret manager, or
   at minimum in a separately-encrypted location the data backups never touch.
6. **Auth.** There is no user auth in front of the dashboard itself — anyone who
   can reach `:8080` can drive the tools with the service account's credentials.
   Put it behind SSO/an authenticating proxy, or restrict network access. (The
   Task Helper's own `/api/auth/*` login — `CONTRACTS.md` §8, ADR-054 — is
   separate and only guards the dormant Task Helper backend, not the main
   dashboard.)
7. **CORS.** Not needed in the default proxy topology (same-origin). If you split
   the SPA and bridges across origins (see §6), set `CORS_ORIGINS` to the exact
   SPA origin(s) — avoid `*` in production.
8. **Statefulness — exactly ONE replica per bridge.** The stores (leaves,
   team, impediments, PRs, post-scrum, meeting-goal, offset, meeting-notes,
   retro, journal, users — all of `packages/mcp-jira/src/lib/*Store.ts`) are
   per-instance local state, not a shared DB. Two `jira` replicas (or two
   `github` replicas) behind a load balancer will each see only their own half
   of the writes and silently diverge — there is no locking or replication
   between them. Scale `web` (nginx, stateless) freely; keep `jira` and `github`
   at a single replica each until the stores move to a shared DB. **This is
   unchanged by `STORAGE_DRIVER=sqlite` (v1.65)** — a local `better-sqlite3` file
   is still one file on one instance's disk, not a network database; it collapses
   eleven-plus-per-user files into one for backup/porting convenience, it does
   not add multi-replica sharing. The one-replica rule stands either way. **With
   `STORAGE_DRIVER=mysql` (v1.74) the rule is load-bearing.** MySQL *is* a network database, but the
   bridge serves reads from an in-memory cache loaded at startup (§3.4). A second replica would read
   stale data, and the two would overwrite each other.
9. **Image slimming (optional).** The bridge images currently run via `tsx` and
   include devDependencies. To slim: add a JS emit (`tsc` with `outDir`), run
   `node dist/http.js`, and `npm prune --omit=dev` (or a multi-stage copy of just
   `dist` + prod deps).
10. **Rate limits / retries.** No backoff today; transient upstream failures
    surface as `502 UPSTREAM`. Add retry/backoff in the REST clients for
    higher-traffic use.
11. **Observability.** Ship `docker compose logs` to your log stack; consider
    adding structured logging + request tracing.
12. **Login throttling — know what you have.** `POST /api/auth/login` is
    rate-limited per email (10 failed attempts per 15 minutes → `429`, cleared on
    success — `routes/taskHelper.ts`), which blunts online guessing against a
    known account. Know the limits of it: **signup has no limiter**, the key is
    the email (not the caller's IP, so spraying many emails isn't throttled), and
    the counter is in-process memory — it resets on restart and is per-instance
    (one more reason for the one-replica rule above). If the app ever faces the
    open internet rather than a team, add an IP-based limiter at the reverse
    proxy (both Caddy and nginx can do this in a few lines) rather than in the
    app.

---

## 6. Alternative topologies

**A. Single-origin reverse proxy (default).** Browser → `web` (nginx) → bridges.
No CORS, bridge ports private. Best for single-host. *(This is what
`docker-compose.yml` ships.)*

**B. Split SPA + API (e.g. SPA on a CDN, bridges on a server).**
- Build `web` (or just the static `dist/`) with absolute bridge URLs:
  `--build-arg VITE_MCP_JIRA_URL=https://api.example.com/jira` (etc.), or host the
  bridges on their own domains and point the VITE vars at them.
- Set `CORS_ORIGINS=https://your-dashboard.example.com` on **both** bridges.
- Serve the bridges over HTTPS.

**C. Direct exposed bridges (no nginx proxy).** Point the SPA's VITE vars at
`http://host:4001` / `:4002` and set `CORS_ORIGINS` to the SPA origin. Simplest to
reason about, but exposes the bridge ports and requires CORS.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard loads but board toggle/data missing | bridge unreachable from the browser | `docker compose ps` (is `jira` healthy?); `curl :8080/jira/api/health` |
| API calls 404 under `/jira` or `/github` | proxy path mismatch / SPA built with wrong `VITE_MCP_*_URL` | rebuild `web` with the right build args (§3.2) |
| CORS error in console | split topology without `CORS_ORIGINS` | set `CORS_ORIGINS` to the SPA origin on both bridges, redeploy |
| `jira` container exits at startup | missing required env (`JIRA_BASE_URL`/board IDs) | check `docker compose logs jira`; fill `.env` |
| `EADDRINUSE` on 4001/4002 | a host process already owns the port | stop it, or remove the `ports:` mapping (proxy still works) |
| Leaves/team reset after redeploy | volume not mounted / `down -v` used | ensure `invokeboard-data` volume exists; don't use `-v` unless you mean it |
| AI drafting shows "off" | `AI_PROVIDER` unset or wrong key | set `AI_PROVIDER` + the matching token, `docker compose up -d jira` |

---

## 8. File map

| Artifact | Purpose |
|---|---|
| `docker-compose.yml` | the 3-service stack (web/jira/github) + `invokeboard-data` volume |
| `docker/jira.Dockerfile`, `docker/github.Dockerfile` | bridge images (node:20 + `tsx`) |
| `docker/web.Dockerfile` | multi-stage: Vite build → nginx |
| `docker/nginx.conf` | SPA serving + `/jira`,`/github` reverse proxy |
| `.dockerignore` | keeps `node_modules`, secrets, stores out of the build context |
| `.env.docker.example` | template for `.env` |
| `docker-compose.prod.yml` | server stack: adds `mysql:8.4`, no host-exposed bridge/db ports, loopback `web`, log rotation (v1.74) |
| `.env.prod.example` | template for the server's `.env` (adds `MYSQL_*`, `CF_TUNNEL_TOKEN`, secrets) |
| `scripts/export-data.mjs` | pull all data out of a running stack into `./backups/<ts>/` (§3.5) |
| `packages/mcp-jira/scripts/storage-export.ts` / `storage-import.ts` | bundle export / import + verify (§3.5, §9.3) |
| `scripts/backup-mysql.sh` / `scripts/restore-mysql.sh` | MySQL dump with rotation / restore (§9.5) |

---

## 9. Server deploy — production compose + MySQL (v1.74, ADR-085)

Target: one Linux server (Ubuntu/Debian, ≥ 2 GB RAM) with Docker Engine and Compose v2. Public access
goes through the bundled Cloudflare Tunnel (no inbound ports), or through a host TLS proxy (Caddy) in
front of `127.0.0.1:8080`.

### 9.1 On the OLD host: export

```bash
node scripts/export-data.mjs          # → ./backups/<ts>/invokeboard-export-<ts>.json (+ .sqlite + tar)
```

Note the doc count it prints (`verify: live docs=N … OK`). Also copy `TOKEN_ENC_KEY` and
`SESSION_SECRET` from the old `.env`, **using a separate channel from the bundle** (§5.5).

### 9.2 On the server: install and configure

```bash
curl -fsSL https://get.docker.com | sh            # Docker Engine + compose plugin
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/jrglomar/invokeboard.git /opt/invokeboard && cd /opt/invokeboard
cp .env.prod.example .env && chmod 600 .env
#  edit .env: Jira/GitHub vars, the OLD TOKEN_ENC_KEY + SESSION_SECRET verbatim,
#  MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD (openssl rand -hex 24), CF_TUNNEL_TOKEN
```

> **TOKEN_ENC_KEY must be identical to the old deployment's.** A different key leaves every stored
> Jira/GitHub/AI connection undecryptable, and users would have to reconnect.

### 9.3 Import the data into MySQL

```bash
mkdir -p import && chmod 700 import
# from your machine: scp backups/<ts>/invokeboard-export-<ts>.json server:/opt/invokeboard/import/
docker compose -f docker-compose.prod.yml up -d mysql            # wait for (healthy)
docker compose -f docker-compose.prod.yml build jira
docker compose -f docker-compose.prod.yml run --rm -v "$PWD/import:/import" jira \
  npx tsx packages/mcp-jira/scripts/storage-import.ts /import/invokeboard-export-<ts>.json
```

Expect `imported N` and `verified N/N`, where N matches the count from §9.1. The import refuses to
write into a non-empty database. Re-run with `--force` only if you mean to upsert over the existing
docs. Afterwards, run `shred -u import/*.json` or move the bundle to your backup location, because it
holds sealed tokens.

### 9.4 Start and check

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps                          # mysql/jira/github healthy
docker compose -f docker-compose.prod.yml logs jira | grep "loaded"   # loaded N doc(s)
curl -s http://127.0.0.1:8080/jira/api/health && curl -s http://127.0.0.1:8080/github/api/health
```

Then sign in through the public hostname and spot-check leaves, team, retro and journals. Point the
Cloudflare Tunnel's public hostname at `http://web:80`. Once the server is live, **stop the old host's
`cloudflared`** (or the whole old stack). Two connectors on one tunnel token split traffic between
the old and new hosts.

### 9.5 Backups

```bash
scripts/backup-mysql.sh                      # → /backups/invokeboard/invokeboard-mysql-<ts>.sql.gz (keeps 14)
# crontab -e
0 2 * * * cd /opt/invokeboard && scripts/backup-mysql.sh >> /var/log/invokeboard-backup.log 2>&1
scripts/restore-mysql.sh /backups/invokeboard/invokeboard-mysql-<ts>.sql.gz   # stops/starts jira
```

Ship `/backups/invokeboard` off the box (rclone/restic/S3), and **never together with `.env`**.

### 9.6 Updating

```bash
cd /opt/invokeboard && git pull
docker compose -f docker-compose.prod.yml up -d --build          # jira flushes its write queue on stop
```

### 9.7 Rollback to sqlite

`STORAGE_DRIVER` is set in the `environment:` block of the jira service in `docker-compose.prod.yml`.
To fall back:
1. Copy the §9.1 `.sqlite` file into the `invokeboard-data` volume as
   `/data/.invokeboard-stores.sqlite` (use `docker compose cp`).
2. Change `STORAGE_DRIVER: mysql` to `sqlite`.
3. Run `up -d jira`.

Alternatively, import a fresh bundle into an empty sqlite file with `storage-import.ts` under
`STORAGE_DRIVER=sqlite`.

# Deployment runbook

This runbook describes how to deploy, verify, and roll back the StellarPOS
backend (`@stellarpos/backend`) with the tooling that exists in this
repository. Where the repository does not provide a step, this document says
so and marks it as an **operator decision**.

File references are to `main` at the time of writing. Line numbers may drift.

## Scope and what the repo provides

| Area | Provided by the repo | Gap (operator decision) |
|---|---|---|
| Image build | `Dockerfile` (multi-stage, Node 22 Alpine) | No image registry push. CI builds with `push: false` (`.github/workflows/ci.yml:31-41`). |
| Run | `docker-compose.yml`, or `node dist/server.js` | No orchestrator, no Kubernetes or systemd unit. |
| Database | SQLite file, schema applied on every boot (`src/utils/database.ts:15-162`) | No migration runner, no migration files, no `migrate` script. |
| Backups | `npm run db:backup`, optional timer via `BACKUP_INTERVAL_HOURS` | No restore command. |
| Promotion | None. No deploy workflow, no per-environment config files | Promotion tooling, approval gates, and staging infrastructure. |
| Rollback | Re-run a previous image (manual) | Image retention and tagging, and any data rollback beyond backup restore. |

## 1. Prerequisites

- Docker with Compose v2 (`docker compose`), or Node.js 22.13 or newer
  (`package.json:8-10`, `.nvmrc`). The Docker image uses `node:22-alpine`
  (`Dockerfile:3`, `Dockerfile:11`).
- A host with a persistent disk for the SQLite file. The image declares
  `VOLUME ["/data"]` (`Dockerfile:21`), and `docker-compose.yml:13-14` mounts
  the named volume `stellarpos-data`.
- A secret store or a protected `.env` file on the host. `.env` is excluded
  from the image build context (`.dockerignore:6-7`) and is supplied at
  runtime through `env_file: .env` (`docker-compose.yml:7`).
- Network access from the host to the Stellar Horizon URL for the chosen
  network, if Stellar checkout is enabled (`STELLAR_HORIZON_URL`).
- Operator decision: which domain and TLS termination sit in front of the
  API. The app sets `trust proxy` to 1 (`src/app.ts:28`), so a single reverse
  proxy is expected.

## 2. Required environment variables

The server reads every variable through `src/config/config.ts`. A variable is
**required** when there is no fallback and an empty value is treated as unset
(`config.ts:5-10`).

### Required

| Variable | Default | Source and behaviour |
|---|---|---|
| `JWT_SECRET` | none | `config.ts:40`. Missing it throws `Missing required environment variable JWT_SECRET` at startup (`config.ts:9`). Also derives the key for 2FA secrets (`src/utils/secretBox.ts:10`). |

### Required only under a condition

| Variable | Condition | Source |
|---|---|---|
| `EMAIL_API_KEY` | `EMAIL_PROVIDER=resend` | `config.ts:93-95` |

### Production checks

| Rule | Source |
|---|---|
| `JWT_SECRET` must be at least 32 characters when `NODE_ENV=production` | `config.ts:90-92` |
| `TAX_RATE_BPS` must be between 0 and 10000 | `config.ts:96-98` |
| Integer variables must parse, or startup fails | `config.ts:12-18` |

### Full list with defaults

| Variable | Default | Source |
|---|---|---|
| `NODE_ENV` | `development` | `config.ts:26`. Use `production` for deployments (`docker-compose.yml:9` sets it). |
| `PORT` | `3000` | `config.ts:33`, `server.ts:26` |
| `CLIENT_URL` | `http://localhost:5173` | `config.ts:36`. Sets CORS origin (`app.ts:33`). |
| `LOG_LEVEL` | `info` in production, `debug` otherwise | `config.ts:34` |
| `JWT_EXPIRES_IN` | `12h` | `config.ts:41` |
| `DATABASE_PATH` | `./data/stellarpos.db` | `config.ts:44`. The image sets `/data/stellarpos.db` (`Dockerfile:14`). Compose sets it again (`docker-compose.yml:10`). |
| `BACKUP_INTERVAL_HOURS` | `0` (off) | `config.ts:54` |
| `BACKUP_DIR` | `./data/backups` | `config.ts:53` |
| `BACKUP_KEEP` | `14` | `config.ts:55` |
| `EMAIL_PROVIDER` | `log` | `config.ts:48`. `log` prints receipts to the console. `resend` sends through the Resend API. |
| `EMAIL_API_KEY` | empty | `config.ts:49` |
| `EMAIL_FROM` | `StellarPOS <receipts@example.com>` | `config.ts:50` |
| `STORE_NAME` | `StellarPOS Store` | `config.ts:58` |
| `STORE_CURRENCY` | `USD` | `config.ts:59` (upper-cased) |
| `TAX_RATE_BPS` | `0` | `config.ts:60` |
| `STELLAR_NETWORK` | `testnet` | `config.ts:27`. Any value other than `mainnet` is treated as testnet. |
| `STELLAR_HORIZON_URL` | testnet or mainnet Horizon, by network | `config.ts:64-67` |
| `STELLAR_MERCHANT_PUBLIC_KEY` | empty (checkout disabled) | `config.ts:72`. Public `G...` key only. |
| `STELLAR_ASSET_CODE` | `XLM` | `config.ts:74` |
| `STELLAR_ASSET_ISSUER` | empty (native XLM) | `config.ts:75` |
| `STELLAR_ASSET_RATE` | `1` | `config.ts:77` |
| `STELLAR_PAYMENT_TTL_MINUTES` | `15` | `config.ts:78` |
| `STELLAR_WATCHER_ENABLED` | `true`, or `false` when `NODE_ENV=test` | `config.ts:80` |
| `STELLAR_WATCHER_INTERVAL_MS` | `5000` | `config.ts:81` |
| `STELLAR_PAYMENT_PROCESSOR_ID` | empty | `config.ts:84` |
| `STELLAR_MERCHANT_REGISTRY_ID` | empty | `config.ts:85` |

`.env.example` documents the same variables (`.env.example:5-81`). Its
`STELLAR_ASSET_CODE=USDC` and `STELLAR_ASSET_ISSUER` values are an example,
not a default. Verify the issuer for the target network before you use it.

Never put a secret Stellar key (`S...`) in any variable. The backend only
watches the merchant public key and never signs (`docs/ENVIRONMENT.md:59-60`).

## 3. Build and image steps

1. Check out the commit to deploy. Use `main` or a release tag. The repo does
   not define release tags, so this is an operator decision.
2. Build the image. CI runs the same Dockerfile as a build check:
   ```bash
   docker build -t stellarpos-backend:<version> .
   ```
   The Dockerfile runs `npm ci`, then `npm run build`, then
   `npm prune --omit=dev`, and copies only `dist/` and `node_modules/` into the
   runtime stage (`Dockerfile:3-18`). The runtime user is `node`
   (`Dockerfile:20`). The entry point is `node dist/server.js`
   (`Dockerfile:24`).
3. Tag the image with a version you can roll back to. Compose tags its own
   builds as `<project>-api` and overwrites that tag on each build, so tag
   explicitly before you rebuild (see section 8).
4. Push to your registry, if you use one. The repo does not push images
   (`.github/workflows/ci.yml:38-40`). This is an operator decision.
5. Before deploy, run the checks CI runs on the same commit: `npm run check`,
   `npm run format:check`, and `npm run build` (`ci.yml:24-29`,
   `docs/DEVELOPMENT.md:115-116`).

## 4. Database migrations

**The repo has no migration tool.** The schema is a set of
`CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements,
applied on every boot (`src/utils/database.ts:15-141`, `database.ts:157`).
There is no `migrate` script in `package.json:11-26`.

What this means for an operator:

- A new table or index is created automatically on the first boot of the new
  version.
- A column added to an existing table is **not** added by this mechanism.
  `CREATE TABLE IF NOT EXISTS` skips an existing table. Treat any column or
  constraint change as a manual schema change, and do not deploy it without
  an operator-approved SQL plan and a fresh backup. The repo has no such
  procedure.
- Search index setup runs at boot too: `db.exec(SEARCH_SCHEMA)` and
  `backfillSearchIndex(db)` (`database.ts:158-159`). The index contents were
  not reviewed for this runbook.

Order of operations for a deploy that changes the schema or data:

1. Take a backup of the live database (section 7). Keep a copy outside the
   volume.
2. Stop the old container so no writes race with the schema change. Compose
   stops the old container when you run `docker compose up` with a new image,
   but a planned stop is safer.
3. Start the new container. It connects to the database, applies the schema,
   and runs the search backfill before it listens (`server.ts:17-29`,
   `database.ts:143-162`).
4. Check the start-up log (section 5) before you send traffic.

If a boot fails during schema apply, the process exits with status 1
(`server.ts:48-51`). See the failure table, section 9.

**Seeding is not a migration step.** `npm run db:seed` refuses to run when
users exist (`src/scripts/seed.ts:57-60`). It is for demo data only, and the
demo accounts use the password `stellarpos-demo` (`seed.ts:18`,
`docs/DEVELOPMENT.md:49-57`). Do not seed a production database. The image
does not contain `tsx` or the `src/` tree, so `npm run db:seed` and
`npm run db:backup` cannot run inside the container (`Dockerfile:16-18`,
`package.json:23-25`). Run them from a checkout with the same
`DATABASE_PATH` pointing at the file you intend to change, and only when that
is deliberate.

## 5. Deploy

### Docker Compose (the supported path in the repo)

1. Create `.env` on the host from `.env.example`. Set at least `JWT_SECRET`
   (`docs/DEVELOPMENT.md:30-34`). For production, set `STELLAR_NETWORK` and
   `STELLAR_HORIZON_URL` for mainnet, and `STELLAR_MERCHANT_PUBLIC_KEY` if you
   take Stellar payments.
2. Start or update the service:
   ```bash
   docker compose up --build -d
   ```
   `docker-compose.yml:4-15` defines the service, the port mapping
   (`3000:3000`), the volume, and `restart: unless-stopped`.
3. Confirm the container is healthy:
   ```bash
   docker compose ps
   ```
   The image health check calls `wget -qO- http://localhost:3000/health` every
   30 seconds (`Dockerfile:23`).

### Bare Node

1. `npm ci && npm run build`.
2. Set the environment and run `npm start` (`package.json:14`,
   `docs/DEVELOPMENT.md:79`). The database directory is created if it does not
   exist (`database.ts:145`).
3. Run the server under a process supervisor of your choice. The repo does
   not include one (operator decision).

### Shutdown

The server handles `SIGTERM` and `SIGINT`. It stops the payment watcher and
backup timer, closes the queues and sockets, and then closes the database
(`server.ts:31-43`). If connections stay open, it force-exits after 10
seconds (`server.ts:42`). Compose sends `SIGTERM` on stop, so use
`docker compose stop` rather than `kill -9` to keep the database closed
cleanly.

## 6. Smoke check after deploy

Run these checks from the host or a machine that can reach the API.

1. Health endpoint. Expect HTTP 200, `"status":"OK"`, `"database":"up"`, and
   `"stellarNetwork"` matching the environment you intended
   (`src/app.ts:58-70`):
   ```bash
   curl -fsS http://localhost:3000/health
   ```
   HTTP 503 with `"database":"down"` means the database check failed
   (`app.ts:61`).
2. Store endpoint. Confirms the API routes and the store settings
   (`docs/DEVELOPMENT.md:45-47`):
   ```bash
   curl -fsS http://localhost:3000/api/v1/store
   ```
   Check the store name, currency, and any Stellar fields against the
   expected values.
3. Start-up log. Look for `StellarPOS API listening on ... (production)`
   (`server.ts:27`) and no `Failed to start` line (`server.ts:49`):
   ```bash
   docker compose logs --tail=100 api
   ```
   The logger module was not read for this runbook. Confirm the lines appear
   in your log output the first time you deploy.
4. Stellar watcher, if enabled. Expect the watcher to start with no warnings.
   Watcher errors are logged as warnings (`docs/DEVELOPMENT.md:144`).
5. Authenticated check. Sign in with an operator account and confirm the
   token is accepted. The repo does not define a dedicated smoke-test
   account. Create one through your normal admin process, not with the demo
   seed.

Do not run any smoke step that writes sales or stock data against production.

## 7. Backups

- On demand, inside a checkout with the same environment:
  `npm run db:backup [-- <dir>]` (`package.json:25`,
  `src/scripts/backup.ts:1-18`). It uses `VACUUM INTO`, which is safe while
  the server runs (`src/utils/backup.ts:9-21`).
- Automatic, when `BACKUP_INTERVAL_HOURS` is greater than 0. Files go to
  `BACKUP_DIR` and only the newest `BACKUP_KEEP` files are kept
  (`src/utils/backup.ts:23-51`). Automatic backups run inside the server
  process. Scheduling is not in the repo.
- Copying the live `.db` file by hand is unsafe. The database uses WAL mode
  (`src/utils/database.ts:154`), so recent writes can sit in `-wal` and
  `-shm` files. Use `db:backup` or stop the server before a file copy.
- Store backups off the host. The repo does not do this (operator decision).

**Restore is not supported by a repo command.** The only documented way to
recover data is to stop the server, replace the database file with a backup,
and start again. Doing this safely is an operator decision and needs the
server stopped first, the `-wal` and `-shm` files removed or restored with the
file, and a verified copy of the current file kept.

## 8. Environment promotion (staging to production)

The repo has no promotion tooling. It has no staging config, no deploy
workflow, and no image registry push. The following is what the repo does
support:

1. Build once. Use the same image tag for both environments, so the code
   under test is the code that goes live (section 3).
2. Keep one `.env` per environment. Each one sets its own `JWT_SECRET`,
   `DATABASE_PATH` or volume, `CLIENT_URL`, and Stellar settings. Never reuse
   a `JWT_SECRET` between environments.
   - Staging: `NODE_ENV=production` is still recommended, because it turns on
     the secret-length check and the production log format. Set
     `STELLAR_NETWORK=testnet` and the testnet Horizon URL.
   - Production: `NODE_ENV=production`, `STELLAR_NETWORK=mainnet`, and the
     mainnet Horizon URL (`config.ts:64-67`, `docs/ENVIRONMENT.md:58`).
3. Use separate volumes. Compose names the volume `stellarpos-data`
   (`docker-compose.yml:17-18`). Use a different project name or volume name
   for each environment, so the two databases never share a file. This is an
   operator decision, but without it staging and production can end up on
   the same database.
4. Promote by deploying the tested image tag to production with production
   `.env`. The repo has no approval gate, no automated smoke check, and no
   rollback automation.
5. Network mismatch guard. `STELLAR_NETWORK` must agree with
   `STELLAR_HORIZON_URL`. Any value other than `mainnet` is treated as
   testnet (`config.ts:27`), so a typo in production silently uses testnet.
   Check the `stellarNetwork` field in `/health` after every promotion.
6. Mainnet asset. Set `STELLAR_ASSET_CODE` and `STELLAR_ASSET_ISSUER` for the
   mainnet asset. The `.env.example` values are a testnet example
   (`.env.example:62-65`).

## 9. Rollback

### Application rollback (supported in principle, operator steps)

The repo does not define rollback. Use this procedure only with a tagged
previous image:

1. Identify the last good image tag (section 3, step 3).
2. Stop the current container: `docker compose stop api`.
3. Point Compose at the previous tag. Compose uses the image from
   `docker-compose.yml:6` (`build: .`), so change the service to an `image:`
   key for the old tag, or retag the old image as the local build name, for
   example:
   ```bash
   docker tag stellarpos-backend:<previous> <project>-api
   docker compose up -d --no-build
   ```
   The `<project>-api` name depends on the directory or `-p` project name.
   Check it with `docker images`.
4. Re-run the smoke check (section 6).

### Data rollback

- **Migration rollback is not supported.** The schema has no down migrations
  and no version table (`src/utils/database.ts:15-141`). The new code may
  have written data or created objects the old code does not expect.
- Rolling the application back to an older image is safe only if the schema
  change was additive. This is an operator judgement and must be checked
  against the change before you deploy it.
- The only documented data recovery is restoring a backup (section 7). Any
  sales or stock written after that backup are lost unless recovered by hand.

### Secret rotation is not a rollback

Changing `JWT_SECRET` invalidates login tokens and makes encrypted 2FA
secrets unreadable. Users must re-enrol 2FA (`src/utils/secretBox.ts:7-8`).
Do not change it as part of a rollback unless you intend that outcome.

## 10. Common failure scenarios

| Symptom | Cause | Fix | Source |
|---|---|---|---|
| Process exits at start with `Missing required environment variable JWT_SECRET` | `JWT_SECRET` is unset or empty | Set `JWT_SECRET` in `.env` and restart. Use `openssl rand -hex 32`. | `src/config/config.ts:9`, `config.ts:40`, `docs/DEVELOPMENT.md:138` |
| Process exits at start with `JWT_SECRET must be at least 32 characters in production` | `NODE_ENV=production` and a short secret | Generate a longer secret and restart. Users must sign in again. | `config.ts:90-92`, `docs/DEVELOPMENT.md:139` |
| Process exits at start with `EMAIL_API_KEY is required when EMAIL_PROVIDER=resend` | Resend selected without a key | Set `EMAIL_API_KEY` or set `EMAIL_PROVIDER=log`. | `config.ts:93-95` |
| Process exits at start with `TAX_RATE_BPS must be between 0 and 10000` | Rate given as a percentage, for example `7.5` or `750000` | Use basis points: `750` is 7.5%. | `config.ts:96-98`, `docs/DEVELOPMENT.md:141` |
| Process exits at start with `... must be an integer, got "..."` | A numeric variable has a non-integer value | Fix the value, for example `PORT=3000` and not `3000 ` with a word. | `config.ts:16` |
| Container runs but `/health` returns 503 with `"database":"down"` | The SQLite file is missing, unwritable, or locked | Check the volume mount and that the `node` user owns `/data` (`Dockerfile:19`). Check `DATABASE_PATH`. | `src/app.ts:58-64`, `src/utils/database.ts:145`, `Dockerfile:19` |
| Container restarts repeatedly on a fresh host | Volume was not created or the path is wrong | Confirm `DATABASE_PATH=/data/stellarpos.db` under Compose and that `stellarpos-data` exists. | `docker-compose.yml:10,17`, `Dockerfile:14` |
| Startup error that mentions the database file on an existing volume | Database written by a different image version or corrupted | Stop the service. Restore the latest verified backup if the file is damaged. Do not delete the volume without a backup. | `src/utils/database.ts:143-162`, section 7 |
| `Failed to start:` in the log, then exit 1 | Any error thrown in `start()` (database, Redis stand-in, or listen) | Read the error after `Failed to start:` and fix its cause. | `src/server.ts:17-29`, `server.ts:48-51` |
| Port already in use | Another process holds `PORT` | Change `PORT` in `.env`, or stop the other process. Update the port mapping in `docker-compose.yml:12`. | `config.ts:33`, `docs/DEVELOPMENT.md:145` |
| Stellar endpoints return 503 | `STELLAR_MERCHANT_PUBLIC_KEY` is empty | Set the public key (`G...`). This is expected when checkout is off. | `docs/DEVELOPMENT.md:95-97`, `config.ts:72` |
| Stellar payments stay pending | Watcher disabled, or `STELLAR_HORIZON_URL` does not match `STELLAR_NETWORK` | Set `STELLAR_WATCHER_ENABLED=true`, align the network and Horizon URL, and check logs for watcher warnings. | `config.ts:80`, `config.ts:27,64-67`, `docs/DEVELOPMENT.md:144` |
| Production payments go to testnet | `STELLAR_NETWORK` typo, for example `Mainnet` with a trailing space | Use exactly `mainnet` (lower case). The value is compared with `===`. Check `stellarNetwork` in `/health`. | `config.ts:27` |
| Browser requests fail CORS | `CLIENT_URL` does not match the POS web app origin | Set `CLIENT_URL` to the exact origin, including scheme and port. | `config.ts:36`, `src/app.ts:31-38` |
| Users cannot sign in after a deploy with a new secret | `JWT_SECRET` was changed | Restore the old secret, or accept that all sessions end. 2FA users must re-enrol. | `config.ts:40`, `src/utils/secretBox.ts:7-8` |
| Backup files are not created | `BACKUP_INTERVAL_HOURS=0`, or `BACKUP_DIR` is not writable | Set `BACKUP_INTERVAL_HOURS` above 0 and make `BACKUP_DIR` writable by `node`. Or run `db:backup` manually. | `config.ts:53-54`, `src/utils/backup.ts:33-51` |
| `npm run db:seed` or `db:backup` not found in the container | Image has no `tsx` and no `src/` | Run these from a checkout, or use a host-side process. | `Dockerfile:16-18`, `package.json:23-25` |
| Seed refuses to run | Users already exist | Expected for existing data. Set `SEED_FORCE=1` only on a database you can discard. | `src/scripts/seed.ts:57-60`, `docs/ENVIRONMENT.md:73` |
| Service stops taking traffic after deploy, no error | Old container still holds the port or old volume | Stop the old container and confirm the port mapping. | `docker-compose.yml:11-12` |

## 11. Open items for the operator

- Choose and document an image registry and tag policy.
- Add a process supervisor or orchestrator, if you do not use Compose.
- Decide how migrations are handled once the schema changes. The repo
  currently has none.
- Set up off-host backup storage and a tested restore procedure.
- Set up log collection and alerting on `/health` returning 503. The repo
  has no monitoring configuration.
- Define staging and production hosts and their separate volumes and secrets.

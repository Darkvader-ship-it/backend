# Developer setup

This guide takes you from a fresh clone to a running API with demo data, and
explains how to run the tests and checks CI runs. For the full list of
environment variables, see [ENVIRONMENT.md](ENVIRONMENT.md). For endpoints, see
[api.md](api.md). For the Stellar checkout flow, see
[stellar-payments.md](stellar-payments.md).

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 22.13 or newer (`.nvmrc` pins 22) | The built-in `node:sqlite` module is used for storage. CI runs on Node 22 and 24. |
| npm | Ships with Node | Installs dependencies and runs scripts. `package-lock.json` is committed, so use `npm install` or `npm ci`. |
| Docker | Optional | Only needed for `docker compose up` and the Docker build CI job. |
| Stellar CLI | Optional | Only needed to generate a testnet merchant key from the command line. Any Stellar wallet works too. |

No database server, Redis or message broker is required. Storage is an
embedded SQLite file, and Redis and queues are in-process stand-ins.

## First-time setup

```bash
git clone https://github.com/<you>/backend.git
cd backend
npm install
cp .env.example .env
```

Open `.env` and set `JWT_SECRET`. Generate a value with:

```bash
openssl rand -hex 32
```

Then load the demo store and start the API:

```bash
npm run db:seed    # products, customers and two weeks of sample sales
npm run dev        # watch mode on http://localhost:3000
```

Check that it is up:

```bash
curl http://localhost:3000/api/v1/store
```

### Demo accounts

The seed creates three users, all with the password `stellarpos-demo`:

| Email | Role |
|---|---|
| `admin@stellarpos.dev` | admin |
| `manager@stellarpos.dev` | manager |
| `cashier@stellarpos.dev` | cashier |

Without the seed, the first account you register becomes the admin.

`db:seed` refuses to run when users already exist. Set `SEED_FORCE=1` to
seed anyway, and only do that on a database you do not mind changing.

## Database

- The database is one SQLite file at `DATABASE_PATH`, which defaults to
  `./data/stellarpos.db`.
- Set `DATABASE_PATH=:memory:` for a throwaway run. Nothing is kept.
- `npm run db:backup` takes a snapshot right away. Automatic snapshots are
  controlled by `BACKUP_INTERVAL_HOURS`, `BACKUP_DIR` and `BACKUP_KEEP`.
- Delete the file to start over, then run `npm run db:seed` again.

## Running

| Command | What it does |
|---|---|
| `npm run dev` | Runs `src/server.ts` with `tsx` and restarts on change |
| `npm run build` | Compiles to `dist/` and rewrites the `@/` path aliases |
| `npm start` | Runs the compiled server from `dist/` (build first) |

The server listens on `PORT` (default `3000`). All routes live under
`/api/v1`.

### Stellar checkout locally

Stellar checkout is optional. It is off until `STELLAR_MERCHANT_PUBLIC_KEY`
is set. Only the public key goes in `.env`. The backend never needs a secret
key.

1. Create a testnet account, for example with
   `stellar keys generate shop --network testnet --fund`.
2. If you take USDC, add a USDC trustline from that account.
3. Set `STELLAR_MERCHANT_PUBLIC_KEY` and restart.

With the default `STELLAR_WATCHER_ENABLED=true`, the watcher polls Horizon
every `STELLAR_WATCHER_INTERVAL_MS` milliseconds. Until the key is set,
Stellar endpoints answer `503`.

## Tests and checks

Tests use Jest and Supertest against an in-memory database.
`tests/setup.ts` sets the environment for the test run, and the Horizon
client is mocked at `@/services/horizon`, so tests never reach the network.

| Command | What it does |
|---|---|
| `npm test` | Runs the full Jest suite once |
| `npm run test:watch` | Reruns tests on change |
| `npm run test:coverage` | Runs the suite with a coverage report |
| `npm run lint` | ESLint over the whole project |
| `npm run format:check` | Prettier check over `src/` and `tests/` |
| `npm run type-check` | TypeScript with `--noEmit` |
| `npm run check` | Lint, type-check and tests, as listed in [CONTRIBUTING.md](../CONTRIBUTING.md) |

Before you open a pull request, run `npm run check` and
`npm run format:check`. CI also runs `npm run build` and a Docker build.

To run one test file:

```bash
npx jest tests/payments.test.ts
```

## Docker

```bash
docker compose up --build
```

This builds the image, runs it with `NODE_ENV=production` and stores data in
the `stellarpos-data` volume. Put `JWT_SECRET` in `.env` first. In production
it must be at least 32 characters, or the server refuses to start.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Missing required environment variable JWT_SECRET` | Set `JWT_SECRET` in `.env`. Restart after editing. |
| `JWT_SECRET must be at least 32 characters in production` | Use `openssl rand -hex 32`. |
| `EMAIL_API_KEY is required when EMAIL_PROVIDER=resend` | Set the key, or keep `EMAIL_PROVIDER=log`. |
| `TAX_RATE_BPS must be between 0 and 10000` | Use basis points: `750` is 7.5%. |
| `node:sqlite` import errors | Your Node version is older than 22.13. Run `node -v`, then switch with `nvm use`. |
| Stellar endpoints return 503 | `STELLAR_MERCHANT_PUBLIC_KEY` is empty. See the Stellar section above. |
| Payments stay pending | Check that the watcher is enabled and that `STELLAR_HORIZON_URL` matches `STELLAR_NETWORK`. Watcher errors are logged as warnings. |
| Port 3000 already in use | Set `PORT` in `.env` to another value. |

## Next steps

- [ENVIRONMENT.md](ENVIRONMENT.md): every environment variable, its default and its valid values
- [api.md](api.md): endpoints and response shapes
- [stellar-payments.md](stellar-payments.md): how Stellar checkout is verified
- [GLOSSARY.md](GLOSSARY.md): Stellar and point-of-sale terms used in the code
- [CONTRIBUTING.md](../CONTRIBUTING.md): branches, commits and pull requests

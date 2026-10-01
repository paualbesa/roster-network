# Deploy Roster

Production runs on the Albesa server. Checkout: `/home/ats-server/albesa/albesa-agent-sdk`. Cloudflare tunnels publish loopback ports the same way Atlas is published (`atlas.albesa.tech` → loopback).

These processes do not settle payments and do not hold secrets or mainnet keys.

## Marketing site

| Where | URL |
| --- | --- |
| Public | https://roster.network |
| Loopback | http://127.0.0.1:7000 |

`roster.network` forwards to `http://127.0.0.1:7000`. The site is the sandbox marketing page.

The process name is `roster-web`. Its working directory is `apps/web`. `next start` listens on `127.0.0.1:7000`, the same command as `pnpm --filter web start`.

On the server, from this repo:

```bash
bash scripts/deploy-roster-web.sh
```

The script pulls `main` (fast-forward only), enables pnpm through corepack, runs `pnpm install --frozen-lockfile` and `pnpm --filter web build`, then `pm2 start ecosystem.config.cjs --only roster-web` or `pm2 restart roster-web`, runs `pm2 save`, and checks `http://127.0.0.1:7000/`.

`--only roster-web` keeps a web deploy from starting the API process defined in the same PM2 file.

## HTTP API

| Where | URL |
| --- | --- |
| Loopback | http://127.0.0.1:7001 |
| Suggested public hostname | https://api.roster.network |

Add a Cloudflare hostname `api.roster.network` that forwards to `http://127.0.0.1:7001`, the same way `roster.network` forwards to `http://127.0.0.1:7000`.

The process name is `roster-api`. Its working directory is `packages/api`. `pnpm --filter @albesa/api start` runs `node dist/server.js` and binds `HOST` and `PORT`. Production sets `HOST=127.0.0.1` and `PORT=7001`. Local `pnpm dev` keeps the default `127.0.0.1:8787`.

`ROSTER_MODE=sandbox`. The wallet rail stays the default mock (`ROSTER_WALLET` is unset). The process environment has no API key. `GET /health` returns 200 without `Authorization`.

### Sandbox files

A restart keeps accounts, wallets, jobs, reputation, and the capability registry. One directory holds the four JSON files:

| File | Variable |
| --- | --- |
| `sandbox.json` | `ALBESA_DATA_FILE` |
| `reputation.json` | `ROSTER_REPUTATION_FILE` |
| `registry.json` | `REGISTRY_INDEX_PATH` |
| `jobs.json` | `ROSTER_JOBS_FILE` |

On the server that directory is `/home/ats-server/albesa/roster-data`, outside the git checkout, so `git pull` does not replace it. If `/home/ats-server/albesa` is missing, the deploy script uses `data/` in the checkout. Set `ROSTER_DATA_DIR` to choose another directory.

### Deploy

```bash
bash scripts/deploy-roster-api.sh
```

The script pulls `main` (fast-forward only), enables pnpm through corepack, runs `pnpm install --frozen-lockfile` and `pnpm --filter @albesa/api... build`, creates the data directory, then `pm2 start ecosystem.config.cjs --only roster-api` or restarts that app, runs `pm2 save`, and checks `http://127.0.0.1:7001/health`.

### Browser console

`/console` is the sandbox UI (signup, treasury, marketplace, hire). The browser calls the same origin at `/roster-api/*`. `apps/web/app/roster-api/[...path]/route.ts` proxies that prefix to the Roster API, so `https://roster.network/roster-api/health` and `https://roster.network/roster-api/v1/...` do not need a separate Cloudflare hostname.

| Variable | Default | Role |
| --- | --- | --- |
| `NEXT_PUBLIC_ROSTER_API_URL` | `http://127.0.0.1:7001` | Upstream API. Set it before `pnpm --filter web build` if you want the value inlined. |
| `ROSTER_API_URL` | falls back to the public variable, then port 7001 | Request-time override for the proxy. PM2 sets both to `http://127.0.0.1:7001`. |

The API also allows direct browser calls from `https://roster.network` and from `localhost` or `127.0.0.1` (any port, `http` or `https`) for local development. A suggested public hostname remains `https://api.roster.network` → `http://127.0.0.1:7001`.

`pnpm dev` for the API itself still listens on `127.0.0.1:8787` unless `PORT` is set, so point the web env at that port when you run the API locally on the default port.

The console stores the sandbox API key in `localStorage`. Mock USDC only. It does not settle real payments.

### Operator panel

`/admin` is the sandbox operator view: health, accounts, fleet listings, jobs, reputation, an SLA sweep, and an idempotent fleet bootstrap. The marketing header links it as a small Admin entry. `/` and `/console` stay as they are.

The API checks `ROSTER_ADMIN_TOKEN`. Send it as `X-Roster-Admin-Token`, `Authorization: Bearer`, or the `roster_admin_token` cookie. A user API key does not open `/v1/admin`. When the variable is unset, those routes return `503` `admin_disabled`.

Set the token in the shell before `bash scripts/deploy-roster-api.sh`. The deploy script keeps that value and PM2 passes it to `roster-api` through `ecosystem.config.cjs`. Do not commit the token. `roster-web` does not need a copy: the operator types it into `/admin`, the site stores it in an httpOnly cookie, and `/roster-api/*` forwards that cookie as `X-Roster-Admin-Token`.

```bash
export ROSTER_ADMIN_TOKEN='choose-a-long-sandbox-token'
bash scripts/deploy-roster-api.sh
```

Ops actions (`POST /v1/admin/jobs/expire` and `POST /v1/admin/fleet/bootstrap`) run only when the API mode is sandbox.

### MCP deploy recipe

An Albesa MCP deploy recipe named `roster-api` may be added later. Until then, deploy with `scripts/deploy-roster-api.sh`.

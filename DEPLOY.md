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

Prefer a same-origin Next.js proxy. The console on `https://roster.network` should call a path on that host, and Next.js should rewrite it to `http://127.0.0.1:7001`. The browser stays on one origin.

The API also allows direct browser calls from `https://roster.network` and from `localhost` or `127.0.0.1` (any port, `http` or `https`) for local development.

Example rewrite in `apps/web/next.config.ts`:

```ts
async rewrites() {
  return [
    {
      source: "/roster-api/:path*",
      destination: "http://127.0.0.1:7001/:path*",
    },
  ];
}
```

A page on `https://roster.network` would then call `/roster-api/health` and `/roster-api/v1/...`.

### MCP deploy recipe

An Albesa MCP deploy recipe named `roster-api` may be added later. Until then, deploy with `scripts/deploy-roster-api.sh`.

# Deploy the Roster marketing site

Production runs the Next.js app in `apps/web` with PM2 on the Albesa server. A Cloudflare tunnel publishes it the same way Atlas is published (`atlas.albesa.tech` → loopback).

| Where | URL |
| --- | --- |
| Public | https://roster.network |
| Loopback | http://127.0.0.1:7000 |

`roster.network` forwards to `http://127.0.0.1:7000`. The site is the sandbox marketing page. It does not settle payments and it does not hold secrets or mainnet keys.

The process name is `roster-web`. Its working directory is `apps/web`. `next start` listens on `127.0.0.1:7000`, the same command as `pnpm --filter web start`.

## Deploy

On the server, from this repo:

```bash
bash scripts/deploy-roster-web.sh
```

The script pulls `main` (fast-forward only), enables pnpm through corepack, runs `pnpm install` and `pnpm --filter web build`, then `pm2 start ecosystem.config.cjs` or `pm2 restart roster-web`, runs `pm2 save`, and checks `http://127.0.0.1:7000/`.

Checkout on the server: `/home/ats-server/albesa/albesa-agent-sdk`.

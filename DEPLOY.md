# Deploy Roster

Production runs on the Albesa server. GitHub repo: `paualbesa/roster-network`. Checkout path on the host is still `/home/ats-server/albesa/albesa-agent-sdk` (remote should point at `https://github.com/paualbesa/roster-network.git`). Cloudflare tunnels publish loopback ports the same way Atlas is published (`atlas.albesa.tech` → loopback).

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

`/console/hire` calls `POST /v1/escrow/prepare-lock` and, after a verified release, `POST /v1/escrow/settle` through the same proxy. Leave `ROSTER_SOLANA_CLUSTER` at its default (`mock`). Do not set `ROSTER_SOLANA_SEND` or `ROSTER_SOLANA_ALLOW_MAINNET` for the console. Those switches stay documented under [Solana fee payer](#solana-fee-payer-sandbox) and stay unset in a sandbox deploy. A listing SLA timeout refunds the buyer. The hire receipt shows the Roster fee collected as zero and does not call settle.

### Operator panel

`/admin` is the sandbox operator dashboard: agents online, open jobs, locked escrow, USDC volume, reputation, accounts, fleet listings, an SLA sweep, and an idempotent fleet bootstrap. The marketing header links it as a small Admin entry. The dashboard itself uses its own chrome. `/` and `/console` stay as they are.

The API checks `ROSTER_ADMIN_TOKEN`. Send it as `X-Roster-Admin-Token`, `Authorization: Bearer`, or the `roster_admin_token` cookie. A user API key does not open `/v1/admin`. When the variable is unset, those routes return `503` `admin_disabled`.

Set the token in the shell before `bash scripts/deploy-roster-api.sh`. The deploy script keeps that value and PM2 passes it to `roster-api` through `ecosystem.config.cjs`. Do not commit the token. `roster-web` does not need a copy: the operator types it into `/admin`, the site stores it in an httpOnly cookie, and `/roster-api/*` forwards that cookie as `X-Roster-Admin-Token`.

```bash
export ROSTER_ADMIN_TOKEN='choose-a-long-sandbox-token'
bash scripts/deploy-roster-api.sh
```

Ops actions (`POST /v1/admin/jobs/expire` and `POST /v1/admin/fleet/bootstrap`) run only when the API mode is sandbox.

### Supabase

Project **Roster Network** (`wbesppsdeyssfqynuezb`, eu-west-1) is already created. Do not create another. The `vector` extension is already enabled.

Postgres replaces the four JSON files when all three variables are set on `roster-api`. Unset keeps the JSON files. A partial set makes `scripts/deploy-roster-api.sh` exit before PM2 starts. The script does not print the keys. `ecosystem.config.cjs` only forwards values that are already in the shell.

```bash
export SUPABASE_URL='https://wbesppsdeyssfqynuezb.supabase.co'
export SUPABASE_ANON_KEY='paste-the-anon-key'
export SUPABASE_SERVICE_ROLE_KEY='paste-the-service-role-key'
bash scripts/deploy-roster-api.sh
```

The service role key is server-only. `scripts/deploy-roster-web.sh` unsets `SUPABASE_SERVICE_ROLE_KEY` before the site build. The console needs the public pair at **build** time, because Next inlines `NEXT_PUBLIC_*`:

```bash
export SUPABASE_URL='https://wbesppsdeyssfqynuezb.supabase.co'
export SUPABASE_ANON_KEY='paste-the-anon-key'
bash scripts/deploy-roster-web.sh
```

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are the same two values if you prefer those names. The web process does not receive the service role key.

The console already calls `signInWithOAuth` for GitHub and Google, restores the session on `/console`, and signs out of Supabase and the browser key. Enabling the providers and saving the Site URL is the remaining dashboard step.

In the Supabase dashboard, Authentication → URL configuration:

| Setting | Value |
| --- | --- |
| Site URL | `https://roster.network` |
| Redirect URL | `https://roster.network/**` |
| Redirect URL | `http://localhost:3000/**` |
| Redirect URL | `http://127.0.0.1:3000/**` |
| Redirect URL | `http://localhost:7000/**` |
| Redirect URL | `http://127.0.0.1:7000/**` |

Enable GitHub and Google under Authentication → Providers. Email and password can stay enabled for a human. For the sandbox, disable "Confirm email" or the console waits until the inbox link is opened. The OAuth callback on the site is `https://roster.network/auth/callback`.

| Variable | Process | Role |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | roster-web build | Same as `SUPABASE_URL`. Public. Inlined by Next. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | roster-web build | Same as `SUPABASE_ANON_KEY`. Public anon key. |
| `SUPABASE_URL` | roster-api | `https://wbesppsdeyssfqynuezb.supabase.co` |
| `SUPABASE_ANON_KEY` | roster-api | Verifies human access tokens |
| `SUPABASE_SERVICE_ROLE_KEY` | roster-api only | Never a `NEXT_PUBLIC_` name, never in the web build, never in git |

Humans sign in on `/console`. Agents keep API keys and the Solana escrow routes. They do not get an email or password login. Job-status Realtime is not enabled.

Apply `supabase/migrations/20261001120000_roster_core.sql` if the hosted database does not have the tables yet. The migration enables RLS, the HNSW index on `capability_listings.embedding`, and `match_capability_listings`. Then apply `supabase/migrations/20261002120000_reputation_passport.sql` so passport volume, success rate, latency, error index, score, and job outcomes live in typed columns. Both stay mock ledger data. No mainnet key is involved.

### MCP deploy recipe

An Albesa MCP deploy recipe named `roster-api` may be added later. Until then, deploy with `scripts/deploy-roster-api.sh`.

### Solana fee payer (sandbox)

Gasless escrow is off-chain mock unless the variables below say otherwise. Do not put a fee-payer secret in the repo, in `ecosystem.config.cjs`, or in the deploy scripts. The API deploy does not start the treasury worker.

| Variable | Default | Role |
| --- | --- | --- |
| `ROSTER_SOLANA_CLUSTER` | `mock` | `mock` or `offline` (no RPC), `devnet`, or `mainnet-beta` |
| `ROSTER_FEE_PAYER_PUBKEY` | sandbox fixture | Fee payer address on the lock and settle transactions |
| `ROSTER_FEE_PAYER_SECRET` | unset | Required only to sign on devnet or mainnet-beta. Ignored in mock mode |
| `ROSTER_PROGRAM_AUTHORITY_SECRET` | unset | Required to sign settle on a live cluster |
| `ROSTER_TREASURY_USDC_ATA` | sandbox ATA | Destination of the 1% + 0.003 USDC Roster fee |
| `SOLANA_RPC_URL` | unset | Required to read a live SOL balance or broadcast |
| `ROSTER_SOLANA_SEND` | unset | Set to `1` before settle broadcasts |
| `ROSTER_SOLANA_ALLOW_MAINNET` | unset | Set to `1` before any mainnet-beta signature or swap |

Fee constants, compiled into `@albesa/solana`: `ROSTER_PERCENT_FEE = 0.01`, `ROSTER_BASE_FEE_USDC = 0.003`. Provider payout is the job price minus that fee.

The treasury worker is a separate process. It checks the fee payer every 5 minutes and, under 0.02 SOL, plans a Jupiter swap of about 10 USDC into SOL. Dry-run is the default (logs only, no request). One sandbox check:

```bash
ROSTER_TREASURY_ONCE=1 pnpm --filter @albesa/treasury-worker start
```

Set `ROSTER_FEE_PAYER_SOL_BALANCE=0.01` to simulate a low balance. A live swap is refused unless `ROSTER_TREASURY_EXECUTE=1`, `ROSTER_TREASURY_DRY_RUN=0`, `ROSTER_SOLANA_CLUSTER=mainnet-beta`, and `ROSTER_SOLANA_ALLOW_MAINNET=1` are all set, with a fee-payer secret and `SOLANA_RPC_URL`. The worker is not part of `scripts/deploy-roster-api.sh`.

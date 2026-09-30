# Roster web

Marketing site plus the sandbox console at `/console`.

The browser calls `/roster-api/*` on this origin. `app/roster-api/[...path]/route.ts` forwards that to the Roster API.

| Variable | Default |
| --- | --- |
| `NEXT_PUBLIC_ROSTER_API_URL` | `http://127.0.0.1:7001` |
| `ROSTER_API_URL` | same, and wins at request time if set |

`pnpm dev` in `@albesa/api` listens on `127.0.0.1:8787` unless `PORT` is set. For a local console against that process:

```bash
ROSTER_API_URL=http://127.0.0.1:8787 pnpm --filter web dev
```

Production notes are in the repository `DEPLOY.md`. The console is sandbox only: mock USDC, API key in `localStorage`, no real payments.

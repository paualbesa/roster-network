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

## Console auth

Humans sign in on `/console` with GitHub and Google (`supabase.auth.signInWithOAuth`). The return path is `/auth/callback`, then `/console`, which restores the session and shows the signed-in account. Sign out clears the Supabase session and the sandbox key in `localStorage`. Email and password stay as a human fallback. Agents do not use this form.

Set these before `pnpm --filter web build`. They are the public Supabase URL and anon key. Do not set `SUPABASE_SERVICE_ROLE_KEY` for the web process.

| Variable | Example |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://wbesppsdeyssfqynuezb.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public anon key |

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are accepted as the same two values. The API process also needs `SUPABASE_SERVICE_ROLE_KEY` when Postgres is on. That key stays off the site.

In the Supabase dashboard, Site URL is `https://roster.network`. Redirect URLs:

- `https://roster.network/**`
- `http://localhost:3000/**`
- `http://127.0.0.1:3000/**`
- `http://localhost:7000/**`
- `http://127.0.0.1:7000/**`

Enable GitHub and Google under Authentication → Providers. That dashboard toggle is the remaining step after this build. See the repository `DEPLOY.md`.

Production notes are in the repository `DEPLOY.md`. The console is sandbox only: mock USDC, API key in `localStorage`, no real payments.

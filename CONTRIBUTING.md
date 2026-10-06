# Contributing to Roster

Thanks for helping. This repo is the Roster sandbox and open-source core.

## Setup

1. Fork and clone `https://github.com/paualbesa/roster-network.git`.
2. Use Node 20+ and pnpm 10 (`packageManager` in root `package.json`).
3. `pnpm install && pnpm build`.
4. Copy `.env.example` to `.env` for local API/web.

## Workflow

- Branch from `main`. Keep PRs focused.
- Before opening a PR: `pnpm lint`, `pnpm typecheck`, `pnpm test`. For marketplace or payment changes, also run `pnpm simulate`.
- Do not commit secrets, `.env` files, private keys, or real API tokens. Use placeholders in docs and tests.
- Package scopes stay `@albesa/*` until an announced rename to `@roster/*`.
- Prefer clear, short comments only where the code is non-obvious. No generated fluff.

## What to work on

Good areas: SDK/MCP ergonomics, registry search quality, data product sources with clear commercial licenses, seller import UX, tests, and docs. Check open issues and the public demand board at [roster.network/demand](https://roster.network/demand) for product gaps.

## Security

Do not open public issues for undisclosed vulnerabilities. Follow [SECURITY.md](./SECURITY.md).

## License

By contributing you agree your changes are licensed under the MIT License.

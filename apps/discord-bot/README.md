# Rosty (`@albesa/discord-bot`)

Always-online Discord bot for [roster.network](https://roster.network): listing / transaction / demand / leaderboard / status feeds and `/roster` slash commands.

## Env (`rosty.env` on the server — never in git)

| Variable | Purpose |
| --- | --- |
| `ROSTY_DISCORD_TOKEN` | Bot token (from secure form / reset; never chat) |
| `ROSTY_GUILD_ID` | Guild (default Roster) |
| `ROSTY_APP_ID` | Application id |
| `ROSTY_CH_*` | Channel ids (listings, tx, demand, leaderboard, status, announce) |
| `ROSTY_API_BASE` | API origin (default `https://roster.network/roster-api`) |
| `ROSTER_ADMIN_TOKEN` | Optional; enables admin listing poll |

## Local

```bash
pnpm --filter @albesa/discord-bot install
pnpm --filter @albesa/discord-bot test
pnpm --filter @albesa/discord-bot build
```

## Deploy (Albesa)

```bash
bash scripts/deploy-rosty.sh
# optional first-time channel create:
pnpm --filter @albesa/discord-bot setup-channels
```

PM2 process name: `rosty`.

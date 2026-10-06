/** Rosty env + defaults. Channel IDs fall back to general when unset. */

export const ROSTER_PUBLIC_BASE = process.env.ROSTY_PUBLIC_BASE?.trim() || "https://roster.network";
export const ROSTER_API_BASE =
  process.env.ROSTY_API_BASE?.trim() || process.env.ROSTER_API_URL?.trim() || "https://roster.network/roster-api";

export const GUILD_ID = process.env.ROSTY_GUILD_ID?.trim() || "1555161640209621062";
export const APP_ID = process.env.ROSTY_APP_ID?.trim() || "1556946835111673906";
export const CATEGORY_ID = process.env.ROSTY_CATEGORY_ID?.trim() || "1555161640960532610";
export const GENERAL_CHANNEL_ID = process.env.ROSTY_CH_GENERAL?.trim() || "1555161640960532612";

export interface RostyChannels {
  listings: string;
  tx: string;
  demand: string;
  leaderboard: string;
  status: string;
  announce: string;
}

function channel(envName: string): string {
  const raw = process.env[envName]?.trim();
  return raw && raw.length > 0 ? raw : GENERAL_CHANNEL_ID;
}

export function resolveChannels(): RostyChannels {
  return {
    listings: channel("ROSTY_CH_LISTINGS"),
    tx: channel("ROSTY_CH_TX"),
    demand: channel("ROSTY_CH_DEMAND"),
    leaderboard: channel("ROSTY_CH_LEADERBOARD"),
    status: channel("ROSTY_CH_STATUS"),
    announce: channel("ROSTY_CH_ANNOUNCE"),
  };
}

export function requireToken(): string {
  const token = process.env.ROSTY_DISCORD_TOKEN?.trim() ?? "";
  if (!token) {
    throw new Error("ROSTY_DISCORD_TOKEN is required (never commit it; load from rosty.env).");
  }
  return token;
}

export const STATE_FILE =
  process.env.ROSTY_STATE_FILE?.trim() ||
  (process.env.ROSTER_DATA_DIR
    ? `${process.env.ROSTER_DATA_DIR.replace(/\/$/, "")}/rosty-state.json`
    : "/home/ats-server/albesa/roster-data/rosty-state.json");

export const ADMIN_TOKEN = process.env.ROSTER_ADMIN_TOKEN?.trim() || "";

/** Aggregate Roster Fleet buyer jobs into a summary every N minutes. */
export const FLEET_SUMMARY_MIN = Number.parseInt(process.env.ROSTY_FLEET_SUMMARY_MIN ?? "15", 10) || 15;

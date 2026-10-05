/**
 * PM2 on the Albesa server.
 *
 * roster-web  Next.js on 127.0.0.1:7000
 *   Cloudflare: roster.network → http://127.0.0.1:7000
 *   bash scripts/deploy-roster-web.sh
 *
 * roster-api  Roster HTTP API on 127.0.0.1:7001
 *   Suggested Cloudflare hostname: api.roster.network → http://127.0.0.1:7001
 *   bash scripts/deploy-roster-api.sh
 *
 * Sandbox only. No mainnet and no API keys in this file.
 * An MCP deploy recipe named roster-api may be added later.
 */
const fs = require("fs");
const path = require("path");

function rosterDataDir() {
  const configured = process.env.ROSTER_DATA_DIR;
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  if (fs.existsSync("/home/ats-server/albesa")) return "/home/ats-server/albesa/roster-data";
  return path.join(__dirname, "data");
}

/** Operator gate for /v1/admin. Unset leaves the admin API disabled. Never invent a token here. */
function adminTokenEnv() {
  const token = process.env.ROSTER_ADMIN_TOKEN;
  if (typeof token !== "string" || token.trim() === "") return {};
  return { ROSTER_ADMIN_TOKEN: token.trim() };
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Passed through from the shell. This file never contains a real key. */
function supabaseServerEnv() {
  const url = trimmed(process.env.SUPABASE_URL);
  const anon = trimmed(process.env.SUPABASE_ANON_KEY);
  const service = trimmed(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const env = {};
  if (url) env.SUPABASE_URL = url;
  if (anon) env.SUPABASE_ANON_KEY = anon;
  if (service) env.SUPABASE_SERVICE_ROLE_KEY = service;
  return env;
}

/** Public URL and anon key only. The service role stays off the web process. */
function supabaseWebEnv() {
  const url = trimmed(process.env.NEXT_PUBLIC_SUPABASE_URL) || trimmed(process.env.SUPABASE_URL);
  const anon = trimmed(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) || trimmed(process.env.SUPABASE_ANON_KEY);
  if (!url && !anon) return {};
  const env = {};
  if (url) {
    env.NEXT_PUBLIC_SUPABASE_URL = url;
    env.SUPABASE_URL = url;
  }
  if (anon) {
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon;
    env.SUPABASE_ANON_KEY = anon;
  }
  return env;
}

/** Commit reported by /health. Set by scripts/deploy-roster-api.sh. */
function releaseEnv() {
  const sha = trimmed(process.env.ROSTER_GIT_SHA);
  return sha ? { ROSTER_GIT_SHA: sha } : {};
}

const dataDir = rosterDataDir();

module.exports = {
  apps: [
    {
      name: "roster-web",
      cwd: path.join(__dirname, "apps", "web"),
      script: path.join(
        __dirname,
        "apps",
        "web",
        "node_modules",
        "next",
        "dist",
        "bin",
        "next",
      ),
      args: "start --hostname 127.0.0.1 --port 7000",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_restarts: 30,
      min_uptime: 5000,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        PORT: "7000",
        HOSTNAME: "127.0.0.1",
        TZ: "Europe/Madrid",
        NEXT_PUBLIC_ROSTER_API_URL: "http://127.0.0.1:7001",
        ROSTER_API_URL: "http://127.0.0.1:7001",
        ...supabaseWebEnv(),
      },
    },
    {
      name: "roster-api",
      cwd: path.join(__dirname, "packages", "api"),
      script: path.join(__dirname, "packages", "api", "dist", "server.js"),
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_restarts: 30,
      min_uptime: 5000,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "7001",
        ROSTER_MODE: "sandbox",
        TZ: "Europe/Madrid",
        ALBESA_DATA_FILE: path.join(dataDir, "sandbox.json"),
        ROSTER_REPUTATION_FILE: path.join(dataDir, "reputation.json"),
        REGISTRY_INDEX_PATH: path.join(dataDir, "registry.json"),
        ROSTER_JOBS_FILE: path.join(dataDir, "jobs.json"),
        ...adminTokenEnv(),
        ...supabaseServerEnv(),
        ...releaseEnv(),
      },
    },
  ],
};

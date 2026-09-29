/**
 * PM2 — Roster marketing site on the Albesa server.
 * Next.js production on 127.0.0.1:7000.
 * Cloudflare tunnel: roster.network → http://127.0.0.1:7000
 *
 *   bash scripts/deploy-roster-web.sh
 */
const path = require("path");

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
      },
    },
  ],
};

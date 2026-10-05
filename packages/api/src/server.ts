import { join } from "node:path";
import { serve } from "@hono/node-server";
import { resolveRuntimeMode, resolveWalletRail } from "@albesa/core";
import { CapabilityRegistry } from "@albesa/registry";
import { createApp, type AppHttpOptions } from "./app.js";
import { bootstrapSandboxFleet } from "./fleet.js";
import { resolveRateLimitConfig } from "./http.js";
import { readListenAddress } from "./listen.js";
import { resolveExpireIntervalMs, startExpirySweeper } from "./sweeper.js";
import { openSupabaseApp } from "./supabase/boot.js";
import { readSupabaseConfig } from "./supabase/env.js";

async function main(): Promise<void> {
  const mode = resolveRuntimeMode();
  const walletRail = resolveWalletRail();
  const { hostname, port } = readListenAddress();
  const supabase = readSupabaseConfig();
  const dataFile = process.env.ALBESA_DATA_FILE?.trim() || join(process.cwd(), "data", "sandbox.json");
  const http: AppHttpOptions = {
    rateLimit: resolveRateLimitConfig(),
    // On by default in the server. ROSTER_ACCESS_LOG=0 silences it.
    accessLog: process.env.ROSTER_ACCESS_LOG?.trim() !== "0",
    ...(process.env.ROSTER_GIT_SHA?.trim() ? { version: process.env.ROSTER_GIT_SHA.trim() } : {}),
  };
  const expireIntervalMs = resolveExpireIntervalMs();
  let app: { fetch: typeof import("hono").Hono.prototype.fetch };
  let where = dataFile;
  if (supabase) {
    const opened = await openSupabaseApp({ config: supabase, mode, walletRail, http: { ...http, storage: "supabase" } });
    app = opened.app;
    where = "supabase";
    if (mode === "sandbox") {
      const fleet = await bootstrapSandboxFleet(opened.app);
      console.log(
        `Roster Labs fleet: ${fleet.listings.length.toString()} listings on ${fleet.sellerAgentId}`,
      );
    }
    await opened.mirror.flush();
    startExpirySweeper({ app: opened.app, intervalMs: expireIntervalMs, afterSweep: () => opened.mirror.flush() });
  } else {
    const reputationFile = process.env.ROSTER_REPUTATION_FILE?.trim() || join(process.cwd(), "data", "reputation.json");
    const registryPath = process.env.REGISTRY_INDEX_PATH?.trim() || join(process.cwd(), "data", "registry.json");
    const jobsFile = process.env.ROSTER_JOBS_FILE?.trim() || join(process.cwd(), "data", "jobs.json");
    const jsonApp = createApp({
      ...http,
      storage: "json",
      mode,
      walletRail,
      dataFile,
      reputationFile,
      jobsFile,
      registry: new CapabilityRegistry({ filePath: registryPath }),
    });
    app = jsonApp;
    if (mode === "sandbox") {
      const fleet = await bootstrapSandboxFleet(jsonApp);
      console.log(
        `Roster Labs fleet: ${fleet.listings.length.toString()} listings on ${fleet.sellerAgentId}`,
      );
    }
    startExpirySweeper({ app: jsonApp, intervalMs: expireIntervalMs });
  }
  serve({ fetch: app.fetch, hostname, port }, (info) => {
    console.log(
      `Roster API on http://${hostname}:${info.port.toString()} (${mode}, ${walletRail} USDC, ${where}, rate limits ${http.rateLimit ? "on" : "off"}, SLA sweep ${expireIntervalMs > 0 ? `${expireIntervalMs.toString()} ms` : "off"})`,
    );
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

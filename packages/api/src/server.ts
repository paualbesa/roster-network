import { join } from "node:path";
import { serve } from "@hono/node-server";
import { resolveRuntimeMode, resolveWalletRail } from "@albesa/core";
import { CapabilityRegistry } from "@albesa/registry";
import { createApp } from "./app.js";
import { bootstrapSandboxFleet } from "./fleet.js";
import { readListenAddress } from "./listen.js";
import { openSupabaseApp } from "./supabase/boot.js";
import { readSupabaseConfig } from "./supabase/env.js";

async function main(): Promise<void> {
  const mode = resolveRuntimeMode();
  const walletRail = resolveWalletRail();
  const { hostname, port } = readListenAddress();
  const supabase = readSupabaseConfig();
  const dataFile = process.env.ALBESA_DATA_FILE?.trim() || join(process.cwd(), "data", "sandbox.json");
  let app: { fetch: typeof import("hono").Hono.prototype.fetch };
  let where = dataFile;
  if (supabase) {
    const opened = await openSupabaseApp({ config: supabase, mode, walletRail });
    app = opened.app;
    where = "supabase";
    if (mode === "sandbox") {
      const fleet = await bootstrapSandboxFleet(opened.app);
      console.log(
        `Roster Labs fleet: ${fleet.listings.length.toString()} listings on ${fleet.sellerAgentId}`,
      );
    }
    await opened.mirror.flush();
  } else {
    const reputationFile = process.env.ROSTER_REPUTATION_FILE?.trim() || join(process.cwd(), "data", "reputation.json");
    const registryPath = process.env.REGISTRY_INDEX_PATH?.trim() || join(process.cwd(), "data", "registry.json");
    const jobsFile = process.env.ROSTER_JOBS_FILE?.trim() || join(process.cwd(), "data", "jobs.json");
    const jsonApp = createApp({
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
  }
  serve({ fetch: app.fetch, hostname, port }, (info) => {
    console.log(
      `Roster API on http://${hostname}:${info.port.toString()} (${mode}, ${walletRail} USDC, ${where})`,
    );
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

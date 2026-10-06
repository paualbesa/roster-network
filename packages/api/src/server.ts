import { join } from "node:path";
import { serve } from "@hono/node-server";
import { resolveRuntimeMode, resolveWalletRail } from "@albesa/core";
import { CapabilityRegistry } from "@albesa/registry";
import { createApp, warmSolanaDevnetRail, type AppHttpOptions } from "./app.js";
import { LocalKycDocumentStore } from "./kyc.js";
import {
  appDataCatalog,
  bootstrapDataProducts,
  appService,
  bootstrapSandboxFleet,
  initSellers,
  resolveFleetBuyerIntervalMin,
  startFleetBuyer,
} from "./fleet.js";
import { FileSellerPersistence, foundingConfigFromEnv, SellerDirectory } from "./sell/sellers.js";
import { LocalDataStore } from "./data/store.js";
import { DemandLog, FileDemandPersistence } from "./demand.js";
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
    // Warm Devnet fee-payer (airdrop) BEFORE fleet fund so mint/ATA can succeed when SOL is available.
    if (walletRail === "solana-devnet") {
      const service = appService(opened.app);
      if (service) await warmSolanaDevnetRail(service.walletProvider);
    }
    if (mode === "sandbox") {
      const fleet = await bootstrapSandboxFleet(opened.app);
      console.log(
        `Roster Labs fleet: ${fleet.listings.length.toString()} listings on ${fleet.sellerAgentId}`,
      );
      await startDataProducts(opened.app);
    }
    await initSellers(opened.app);
    await opened.mirror.flush();
    if (mode === "sandbox") startFleetBuyer(opened.app, { intervalMin: resolveFleetBuyerIntervalMin(), afterBuy: () => opened.mirror.flush() });
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
      kycDocuments: new LocalKycDocumentStore({
        directory: process.env.ROSTER_KYC_DIR?.trim() || join(process.cwd(), "data", "kyc-documents"),
      }),
      dataStore:
        process.env.ROSTER_DATA_PRODUCTS?.trim() === "0"
          ? null
          : new LocalDataStore({ directory: process.env.ROSTER_DATA_DIR?.trim() || join(process.cwd(), "data", "data-products") }),
      demandLog: new DemandLog(new FileDemandPersistence(join(process.cwd(), "data", "unmet-needs.json"))),
      sellers: new SellerDirectory(new FileSellerPersistence(join(process.cwd(), "data", "sellers.json")), foundingConfigFromEnv()),
    });
    app = jsonApp;
    if (walletRail === "solana-devnet") {
      const service = appService(jsonApp);
      if (service) await warmSolanaDevnetRail(service.walletProvider);
    }
    if (mode === "sandbox") {
      const fleet = await bootstrapSandboxFleet(jsonApp);
      console.log(
        `Roster Labs fleet: ${fleet.listings.length.toString()} listings on ${fleet.sellerAgentId}`,
      );
      await startDataProducts(jsonApp);
    }
    await initSellers(jsonApp);
    if (mode === "sandbox") startFleetBuyer(jsonApp, { intervalMin: resolveFleetBuyerIntervalMin() });
    startExpirySweeper({ app: jsonApp, intervalMs: expireIntervalMs });
  }
  // Dynamic path avoids a workspace edge (mcp lists api as a dep) while still
  // loading the built remote MCP attach helper after packages/mcp is built.
  const mcpModule = (await import(new URL("../../mcp/dist/index.js", import.meta.url).href)) as {
    attachRosterMcp: (app: { fetch: typeof import("hono").Hono.prototype.fetch }, options: { mode: typeof mode }) => void;
  };
  mcpModule.attachRosterMcp(app, { mode });

  serve({ fetch: app.fetch, hostname, port }, (info) => {
    console.log(
      `Roster API on http://${hostname}:${info.port.toString()} (${mode}, ${walletRail} USDC, ${where}, rate limits ${http.rateLimit ? "on" : "off"}, SLA sweep ${expireIntervalMs > 0 ? `${expireIntervalMs.toString()} ms` : "off"})`,
    );
  });
}

/**
 * Publish the Roster Data listings and start the ingestion scheduler.
 * Refreshes run in the background, one product at a time; boot never waits on upstreams.
 * ROSTER_DATA_REFRESH=0 publishes the listings without fetching anything.
 */
async function startDataProducts(app: object): Promise<void> {
  const catalog = appDataCatalog(app);
  if (!catalog) return;
  try {
    await catalog.init();
    const data = await bootstrapDataProducts(app);
    console.log(`Roster Data: ${data.listings.length.toString()} data products on ${data.sellerAgentId} (${catalog.storeKind} store)`);
    if (process.env.ROSTER_DATA_REFRESH?.trim() !== "0") {
      catalog.start({ intervalMs: 5 * 60_000, initialDelayMs: 15_000 });
    }
  } catch (error) {
    // Data products must never take the payments API down.
    console.error("Roster Data bootstrap failed", error);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

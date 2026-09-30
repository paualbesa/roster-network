import { join } from "node:path";
import { serve } from "@hono/node-server";
import { resolveRuntimeMode, resolveWalletRail } from "@albesa/core";
import { CapabilityRegistry } from "@albesa/registry";
import { createApp } from "./app.js";
import { readListenAddress } from "./listen.js";

const mode = resolveRuntimeMode();
const walletRail = resolveWalletRail();
const { hostname, port } = readListenAddress();

const dataFile = process.env.ALBESA_DATA_FILE?.trim() || join(process.cwd(), "data", "sandbox.json");
const reputationFile = process.env.ROSTER_REPUTATION_FILE?.trim() || join(process.cwd(), "data", "reputation.json");
const registryPath = process.env.REGISTRY_INDEX_PATH?.trim() || join(process.cwd(), "data", "registry.json");
const jobsFile = process.env.ROSTER_JOBS_FILE?.trim() || join(process.cwd(), "data", "jobs.json");
const app = createApp({
  mode,
  walletRail,
  dataFile,
  reputationFile,
  jobsFile,
  registry: new CapabilityRegistry({ filePath: registryPath }),
});
serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(
    `Roster API on http://${hostname}:${info.port.toString()} (${mode}, ${walletRail} USDC, ${dataFile})`,
  );
});

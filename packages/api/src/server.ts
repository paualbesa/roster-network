import { join } from "node:path";
import { serve } from "@hono/node-server";
import { resolveRuntimeMode } from "@albesa/core";
import { createApp } from "./app.js";

const mode = resolveRuntimeMode();
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("PORT must be a positive integer.");
}

const dataFile = process.env.ALBESA_DATA_FILE?.trim() || join(process.cwd(), "data", "sandbox.json");
const reputationFile = process.env.ROSTER_REPUTATION_FILE?.trim() || join(process.cwd(), "data", "reputation.json");
const app = createApp({ mode, dataFile, reputationFile });
serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `Roster API on http://127.0.0.1:${info.port.toString()} (${mode}, mock USDC, ${dataFile})`,
  );
});

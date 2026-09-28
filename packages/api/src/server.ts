import { serve } from "@hono/node-server";
import { resolveRuntimeMode } from "@albesa/core";
import { join } from "node:path";
import { createApp } from "./app.js";

const mode = resolveRuntimeMode();
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("PORT must be a positive integer.");
}

const dataFile = process.env.ALBESA_DATA_FILE?.trim() || join(process.cwd(), "data", "sandbox.json");
const app = createApp({ mode, dataFile });
serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `Albesa Agent Finance API on http://127.0.0.1:${info.port.toString()} (${mode}, mock USDC, ${dataFile})`,
  );
});

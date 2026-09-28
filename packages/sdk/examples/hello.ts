/**
 * Roster sandbox payment demo.
 * In an app you would import { Albesa } from "@albesa/sdk" and point at a running API.
 * This file boots that API on a local sandbox file so `pnpm demo` works with no keys and no chain.
 */
import { serve } from "@hono/node-server";
import { createApp } from "@albesa/api";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Albesa, createSandboxOrganization } from "../src/index.js";

const port = Number(process.env.PORT ?? 8787);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataFile = process.env.ALBESA_DATA_FILE ?? join(repoRoot, "data", "sandbox.json");
const app = createApp({ mode: "sandbox", dataFile });
const server = serve({ fetch: app.fetch, port });
await new Promise<void>((resolve, reject) => {
  server.once("listening", () => resolve());
  server.once("error", reject);
});

try {
  const baseUrl = `http://127.0.0.1:${port.toString()}`;
  const { apiKey } = await createSandboxOrganization({ name: "Acme", baseUrl });
  process.env.ALBESA_API_KEY = apiKey;

  const albesa = new Albesa({ apiKey: process.env.ALBESA_API_KEY!, baseUrl });
  const agent = await albesa.agents.create({ name: "buyer", dailySpendLimitUsdc: "10.00", vendorAllowlist: ["vendor_data"] });
  await albesa.agents.fund(agent.id, "5.00");
  const payment = await albesa.agents.pay(agent.id, { vendorId: "vendor_data", amountUsdc: "0.15" });

  console.log(
    `Roster sandbox payment ${payment.status}: ${payment.amountUsdc} USDC to ${payment.vendorId} from ${agent.address} (${payment.id})`,
  );

  const restored = createApp({ mode: "sandbox", dataFile });
  const balanceResponse = await restored.request(`/v1/agents/${agent.id}/balance`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!balanceResponse.ok) {
    throw new Error(`Restored balance read failed (${balanceResponse.status.toString()}).`);
  }
  const restoredBody = (await balanceResponse.json()) as { balanceUsdc?: string };
  if (restoredBody.balanceUsdc !== payment.balanceUsdc) {
    throw new Error("Restored balance did not match the settled payment.");
  }
  console.log(`Roster restored ${restoredBody.balanceUsdc} USDC for ${agent.id} from ${dataFile}`);
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Runnable hello path. The five statements below are the developer example.
 * In an app you would import { Albesa } from "@albesa/sdk" and point at a running API.
 * This file boots that API locally so `pnpm demo` works with no keys and no chain.
 */
import { serve } from "@hono/node-server";
import { createApp } from "@albesa/api";
import { Albesa, createSandboxOrganization } from "../src/index.js";

const port = Number(process.env.PORT ?? 8787);
const app = createApp({ mode: "sandbox" });
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
    `${payment.status} ${payment.amountUsdc} USDC to ${payment.vendorId} from ${agent.address} (${payment.id})`,
  );
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

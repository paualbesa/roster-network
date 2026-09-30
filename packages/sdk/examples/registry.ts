/**
 * Roster sandbox capability search.
 * Registers three manifests and prints the ranked hits.
 * No chain and no API key file: the process boots the API and throws the key away.
 */
import { serve } from "@hono/node-server";
import { createApp } from "@albesa/api";
import { Albesa, createSandboxOrganization } from "../src/index.js";

const port = Number(process.env.REGISTRY_DEMO_PORT ?? 8797);
const app = createApp({ mode: "sandbox" });
const server = serve({ fetch: app.fetch, port });
await new Promise<void>((resolve, reject) => {
  server.once("listening", () => resolve());
  server.once("error", reject);
});

try {
  const baseUrl = `http://127.0.0.1:${port.toString()}`;
  const { client } = await createSandboxOrganization({ name: "Acme", baseUrl });
  const albesa: Albesa = client;
  const schema = {
    inputSchema: { type: "object", properties: { documentUrl: { type: "string" } } },
    outputSchema: { type: "object", properties: { total: { type: "string" } } },
  };

  await albesa.registry.register({
    name: "Invoice extractor",
    description: "Extract structured fields from invoices and receipts.",
    ...schema,
    pricing: { model: "per_call", amountUsdc: "0.02" },
    latency: { p95Ms: 400 },
    tags: ["invoice", "extract"],
  });
  await albesa.registry.register({
    name: "Invoice extractor",
    description: "Extract structured fields from invoices and receipts.",
    ...schema,
    pricing: { model: "per_call", amountUsdc: "0.75" },
    latency: { p95Ms: 2200 },
    tags: ["invoice", "extract"],
  });
  await albesa.registry.register({
    name: "Weather forecast",
    description: "Hourly weather for a city.",
    ...schema,
    pricing: { model: "per_call", amountUsdc: "0.01" },
    latency: { p95Ms: 80 },
    tags: ["weather"],
  });

  const hits = await albesa.registry.search({ q: "parse receipts" });
  if (hits.length !== 2) {
    throw new Error(`Expected the two invoice extractors, got ${hits.length.toString()} hits.`);
  }
  const [first, second] = hits;
  if (!first || !second || !(first.score > second.score) || !(first.priceHint > second.priceHint)) {
    throw new Error("Cheaper, faster invoice extractor should rank first.");
  }
  console.log(`query "parse receipts" -> ${hits.length.toString()} candidates`);
  for (const [index, hit] of hits.entries()) {
    console.log(
      `${(index + 1).toString()}. ${hit.listing.name} score=${hit.score.toFixed(4)} price=${hit.listing.pricing.amountUsdc} p95=${hit.listing.latency.p95Ms.toString()}ms`,
    );
  }

  const semanticHits = await albesa.registry.search({ q: "invioce extractr", semantic: true });
  if (semanticHits[0]?.listing.name !== "Invoice extractor") {
    throw new Error("Semantic search should rank the invoice extractor for a near-miss query.");
  }
  console.log(
    `semantic "invioce extractr" -> ${semanticHits[0].listing.name} relevance=${semanticHits[0].relevance.toFixed(4)}`,
  );
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Roster sandbox marketplace.
 * Creates a buyer organization and a seller organization, credits the buyer,
 * publishes a listing, ranks it with reputation, runs a paid job, and prints
 * the seller passport delta. No chain and no API key file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp, sandboxExecute, sandboxJobSchema, sandboxSellerBindRequests } from "@albesa/api";
import { AlbesaError, createSandboxOrganization, type RegistrySearchHit } from "../src/index.js";

const port = Number(process.env.MARKETPLACE_DEMO_PORT ?? 8799);
const directory = mkdtempSync(join(tmpdir(), "roster-marketplace-"));
const app = createApp({
  mode: "sandbox",
  dataFile: join(directory, "sandbox.json"),
  reputationFile: join(directory, "reputation.json"),
  jobsFile: join(directory, "jobs.json"),
});
const server = serve({ fetch: app.fetch, port });
await new Promise<void>((resolve, reject) => {
  server.once("listening", () => resolve());
  server.once("error", reject);
});

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["total"],
  properties: { total: { type: "string", minLength: 1 } },
};

try {
  const baseUrl = `http://127.0.0.1:${port.toString()}`;
  const buyerOrg = await createSandboxOrganization({ name: "Northwind", baseUrl });
  const sellerOrg = await createSandboxOrganization({ name: "Harbor", baseUrl });
  const rivalOrg = await createSandboxOrganization({ name: "Drift", baseUrl });

  const buyer = await buyerOrg.client.agents.create({
    name: "buyer",
    dailySpendLimitUsdc: "10.00",
    vendorAllowlist: [],
  });
  const seller = await sellerOrg.client.agents.create({
    name: "seller",
    dailySpendLimitUsdc: "10.00",
    vendorAllowlist: [],
  });
  const rival = await rivalOrg.client.agents.create({
    name: "rival",
    dailySpendLimitUsdc: "10.00",
    vendorAllowlist: [],
  });
  const credited = await buyerOrg.client.agents.fund(buyer.id, "5.00");

  const catalog = await sellerOrg.client.registry.seed();
  const receipt = catalog.find((listing) => listing.name === "Receipt parser");
  const arb = catalog.find((listing) => listing.name === "Compute arb");
  if (!receipt) throw new Error("Sample catalog did not include Receipt parser.");
  if (!arb?.manifest) throw new Error("Sample catalog did not include Compute arb.");
  const bindings = sandboxSellerBindRequests(catalog, seller.id);
  if (bindings.length !== catalog.length || !bindings.some((binding) => binding.listingId === arb.id)) {
    throw new Error("Seed helpers did not map the first-party catalog onto the seller.");
  }
  await sellerOrg.client.jobs.bindSeller(receipt.id, seller.id);
  await sellerOrg.client.jobs.bindSeller(arb.id, seller.id);

  const rivalListing = await rivalOrg.client.registry.register({
    name: receipt.name,
    description: receipt.description,
    inputSchema: receipt.inputSchema,
    outputSchema: receipt.outputSchema,
    pricing: { model: "per_call", amountUsdc: "0.01" },
    latency: { p95Ms: 80 },
    tags: receipt.tags,
  });
  await rivalOrg.client.jobs.bindSeller(rivalListing.id, rival.id);
  await rivalOrg.client.reputation.recordEvent(rival.id, {
    outcome: "failure",
    latencyMs: 400,
    volumeUsdc: "1.00",
    error: true,
  });

  const before = await sellerOrg.client.reputation.passport(seller.id);
  const hits = await buyerOrg.client.registry.search({
    q: "parse receipts",
    tags: ["receipt"],
    withReputation: true,
  });
  const top = hits[0];
  const second = hits[1];
  if (!top || top.listing.id !== receipt.id || top.reputationScore !== 50) {
    throw new Error(`Reputation search did not rank Harbor first: ${hits.map(describeHit).join("; ")}`);
  }
  if (!second || second.listing.id !== rivalListing.id || second.reputationScore !== 20) {
    throw new Error(`Reputation search did not rank Drift second: ${hits.map(describeHit).join("; ")}`);
  }

  const held = await buyerOrg.client.jobs.create({
    buyerAgentId: buyer.id,
    query: "parse receipts",
    amountUsdc: "1.00",
    schema,
    tags: ["receipt"],
  });
  if (held.listingId !== receipt.id || held.sellerAgentId !== seller.id || held.status !== "held") {
    throw new Error("Job did not lock escrow against Harbor.");
  }
  try {
    await buyerOrg.client.jobs.submit(held.id, { total: "12.50" });
    throw new Error("Buyer organization was allowed to deliver the result.");
  } catch (error) {
    if (!(error instanceof AlbesaError) || error.code !== "forbidden") throw error;
  }
  const settled = await sellerOrg.client.jobs.submit(held.id, { total: "12.50" }, { latencyMs: 400 });
  const after = await sellerOrg.client.reputation.passport(seller.id);
  if (settled.status !== "released" || settled.takeRateUsdc !== "0.010000" || settled.sellerNetUsdc !== "0.990000") {
    throw new Error("Job did not release net of the 1% take-rate.");
  }
  if (before.score !== "0.0000" || after.score !== "85.0100" || settled.passport?.scoreAfter !== after.score) {
    throw new Error(`Expected passport 0.0000 -> 85.0100, got ${before.score} -> ${after.score}.`);
  }

  const quotes = {
    quotes: [
      { provider: "spot-b", priceUsdc: "0.006" },
      { provider: "spot-a", priceUsdc: "0.004" },
    ],
  };
  const arbHits = await buyerOrg.client.registry.search({ q: "compute arb", tags: ["arb"], withReputation: true });
  if (arbHits[0]?.listing.id !== arb.id) {
    throw new Error(`Search did not rank Compute arb first: ${arbHits.map(describeHit).join("; ")}`);
  }
  const arbHeld = await buyerOrg.client.jobs.create({
    buyerAgentId: buyer.id,
    query: "compute arb",
    amountUsdc: "0.50",
    schema: sandboxJobSchema("Compute arb"),
    tags: ["arb"],
  });
  if (arbHeld.listingId !== arb.id || arbHeld.sellerAgentId !== seller.id || arbHeld.status !== "held") {
    throw new Error("Job did not lock escrow against Compute arb.");
  }
  const arbSettled = await sellerOrg.client.jobs.submit(arbHeld.id, sandboxExecute("Compute arb", quotes), {
    latencyMs: 60,
  });
  if (
    arbSettled.status !== "released" ||
    arbSettled.takeRateUsdc !== "0.005000" ||
    arbSettled.sellerNetUsdc !== "0.495000" ||
    arbSettled.listingName !== "Compute arb"
  ) {
    throw new Error("Compute arb job did not release net of the 1% take-rate.");
  }

  console.log("Roster sandbox marketplace");
  console.log(`catalog: ${catalog.map((listing) => listing.name).join(", ")}`);
  console.log(
    `buyer ${buyerOrg.organizationId} agent ${buyer.id} credited ${credited.amountUsdc} USDC (balance ${credited.balanceUsdc})`,
  );
  console.log(`seller ${sellerOrg.organizationId} agent ${seller.id} listing ${receipt.id} (${receipt.name})`);
  console.log('search "parse receipts" with reputation:');
  for (const [index, hit] of hits.entries()) {
    console.log(`  ${index + 1}. ${describeHit(hit)}`);
  }
  console.log(
    `job ${settled.id} released: locked ${settled.amountUsdc} USDC, seller net ${settled.sellerNetUsdc}, take-rate ${settled.takeRateUsdc} (1%)`,
  );
  console.log(
    `balances buyer ${settled.buyerBalanceUsdc} USDC, seller ${settled.sellerBalanceUsdc} USDC`,
  );
  console.log(`passport ${seller.id} ${before.score} -> ${after.score}`);
  console.log(
    `job ${arbSettled.id} released on ${arb.name} (${arb.manifest.mcp.name}): locked ${arbSettled.amountUsdc} USDC, seller net ${arbSettled.sellerNetUsdc}, take-rate ${arbSettled.takeRateUsdc}`,
  );
  console.log(
    `result provider ${String((arbSettled.result as { provider?: string } | null)?.provider ?? "")} price ${(arbSettled.result as { priceUsdc?: string } | null)?.priceUsdc ?? ""}`,
  );
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function describeHit(hit: RegistrySearchHit): string {
  const reputation = hit.reputationScore === undefined ? "n/a" : hit.reputationScore.toString();
  return `${hit.listing.name} (${hit.listing.id}) score=${hit.score.toFixed(4)} reputation=${reputation} price=${hit.listing.pricing.amountUsdc}`;
}

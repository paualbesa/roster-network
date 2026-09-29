/**
 * Roster sandbox marketplace job.
 * Discovers a receipt parser, locks escrow, delivers a schema-valid result,
 * releases net of the take-rate, and prints the seller passport score change.
 * No chain and no API key file: the process boots the API and throws the key away.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp, sandboxReceiptListing } from "@albesa/api";
import { Albesa, createSandboxOrganization } from "../src/index.js";

const port = Number(process.env.JOB_DEMO_PORT ?? 8798);
const directory = mkdtempSync(join(tmpdir(), "roster-job-"));
const dataFile = join(directory, "sandbox.json");
const reputationFile = join(directory, "reputation.json");
const jobsFile = join(directory, "jobs.json");
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["total"],
  properties: { total: { type: "string", minLength: 1 } },
};

const app = createApp({ mode: "sandbox", dataFile, reputationFile, jobsFile });
const server = serve({ fetch: app.fetch, port });
await new Promise<void>((resolve, reject) => {
  server.once("listening", () => resolve());
  server.once("error", reject);
});

try {
  const baseUrl = `http://127.0.0.1:${port.toString()}`;
  const { apiKey, client } = await createSandboxOrganization({ name: "Acme", baseUrl });
  const albesa: Albesa = client;
  const buyer = await albesa.agents.create({
    name: "buyer",
    dailySpendLimitUsdc: "10.00",
    vendorAllowlist: [],
  });
  const seller = await albesa.agents.create({
    name: "seller",
    dailySpendLimitUsdc: "10.00",
    vendorAllowlist: [],
  });
  await albesa.agents.fund(buyer.id, "5.00");
  const listing = await albesa.registry.register(sandboxReceiptListing());
  await albesa.jobs.bindSeller(listing.id, seller.id);

  const before = await albesa.reputation.passport(seller.id);
  const held = await albesa.jobs.create({
    buyerAgentId: buyer.id,
    query: "parse receipts",
    amountUsdc: "1.00",
    schema,
    tags: ["receipt"],
  });
  if (held.status !== "held" || held.listingId !== listing.id || held.sellerAgentId !== seller.id) {
    throw new Error("Job did not lock escrow against the receipt parser.");
  }
  const settled = await albesa.jobs.submit(held.id, { total: "12.50" }, { latencyMs: 400 });
  const after = await albesa.reputation.passport(seller.id);
  if (settled.status !== "released" || settled.sellerNetUsdc !== "0.990000" || settled.takeRateUsdc !== "0.010000") {
    throw new Error("Job did not release net of the take-rate.");
  }
  if (after.score !== "85.0100" || settled.passport?.scoreAfter !== after.score) {
    throw new Error(`Expected passport 85.0100, got ${after.score}.`);
  }
  const read = await albesa.jobs.get(settled.id);
  if (read.status !== "released") throw new Error("Stored job was not released.");

  console.log(
    `Roster job ${settled.id} released: discover "parse receipts" -> ${settled.listingName} (${settled.listingId})`,
  );
  console.log(
    `escrow ${settled.escrowId} locked ${settled.amountUsdc} USDC, seller net ${settled.sellerNetUsdc} (take-rate ${settled.takeRateUsdc})`,
  );
  console.log(`passport ${seller.id} ${before.score} -> ${after.score}`);

  const restored = createApp({ mode: "sandbox", dataFile, reputationFile, jobsFile });
  const restoredJob = await restored.request(`/v1/jobs/${settled.id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!restoredJob.ok) throw new Error(`Reloaded job read failed (${restoredJob.status.toString()}).`);
  const restoredBody = (await restoredJob.json()) as { job?: { status?: string; passport?: { scoreAfter?: string } } };
  if (restoredBody.job?.status !== "released" || restoredBody.job.passport?.scoreAfter !== after.score) {
    throw new Error("Reloaded job did not keep the release or the passport score.");
  }
  console.log(`Roster reloaded ${settled.id} (${restoredBody.job.status}) from ${jobsFile}`);
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

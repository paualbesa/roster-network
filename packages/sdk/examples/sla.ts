/**
 * Roster sandbox SLA timeout.
 * Locks a paid marketplace job, waits until the listing p95 deadline, then
 * refunds the buyer. The seller passport records a failure. No take-rate.
 * No chain and no API key file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "@albesa/api";
import { AlbesaError, createSandboxOrganization } from "../src/index.js";

const port = Number(process.env.SLA_DEMO_PORT ?? 8801);
const directory = mkdtempSync(join(tmpdir(), "roster-sla-"));
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
  await buyerOrg.client.agents.fund(buyer.id, "1.00");

  const listing = await sellerOrg.client.registry.register({
    name: "Receipt parser",
    description: "Parse receipts and invoices into a structured total.",
    inputSchema: { type: "object", properties: { documentUrl: { type: "string" } } },
    outputSchema: { type: "object", properties: { total: { type: "string" } } },
    pricing: { model: "per_call", amountUsdc: "0.02" },
    latency: { p95Ms: 400 },
    tags: ["receipt", "invoice", "extract"],
  });
  await sellerOrg.client.jobs.bindSeller(listing.id, seller.id);

  const held = await buyerOrg.client.jobs.create({
    buyerAgentId: buyer.id,
    query: "parse receipts",
    amountUsdc: "1.00",
    schema,
    tags: ["receipt"],
  });
  if (held.status !== "held" || held.slaMs !== 400 || held.deadlineAt === null) {
    throw new Error("Job did not lock escrow with the listing SLA.");
  }
  if (Date.parse(held.deadlineAt) > Date.now()) {
    const early = await buyerOrg.client.jobs.expire();
    if (early.length !== 0) throw new Error("Job expired before the SLA deadline.");
  }
  const remaining = Date.parse(held.deadlineAt) - Date.now();
  if (remaining > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, remaining + 25);
    });
  }

  const expired = await buyerOrg.client.jobs.expire();
  const timedOut = expired[0];
  if (!timedOut || expired.length !== 1) throw new Error("SLA sweep did not time the job out.");
  if (timedOut.status !== "timed_out" || timedOut.buyerBalanceUsdc !== "1.000000" || timedOut.sellerBalanceUsdc !== "0.000000") {
    throw new Error("SLA timeout did not refund the buyer in full.");
  }
  if (timedOut.validationErrors?.[0] !== "SLA deadline passed before a valid result.") {
    throw new Error("SLA timeout did not record the deadline reason.");
  }
  const passportChange = timedOut.passport;
  if (!passportChange || passportChange.scoreBefore !== "0.0000" || passportChange.scoreAfter !== "20.0000") {
    throw new Error(
      `Expected passport 0.0000 -> 20.0000, got ${passportChange?.scoreBefore ?? "missing"} -> ${passportChange?.scoreAfter ?? "missing"}.`,
    );
  }

  const history = await buyerOrg.client.agents.transactions(buyer.id);
  const refund = history.find((tx) => tx.type === "escrow_refund");
  if (!refund || refund.amountUsdc !== "1.000000" || refund.feeUsdc !== "0.000000") {
    throw new Error("Refund did not return the locked principal with a zero fee.");
  }
  if (history.some((tx) => tx.type === "escrow_release")) {
    throw new Error("SLA timeout collected a take-rate.");
  }
  const passport = await sellerOrg.client.reputation.passport(seller.id);
  if (passport.metrics.failureCount !== 1 || passport.metrics.volumeSettledUsdc !== "0.000000") {
    throw new Error("Seller passport did not record a failure with zero settled volume.");
  }
  if ((await buyerOrg.client.jobs.expire()).length !== 0) {
    throw new Error("A second sweep refunded the job again.");
  }
  try {
    await sellerOrg.client.jobs.submit(timedOut.id, { total: "12.50" });
    throw new Error("A timed out job accepted a delivery.");
  } catch (error) {
    if (!(error instanceof AlbesaError) || error.code !== "invalid_state") throw error;
  }

  console.log("Roster sandbox SLA timeout");
  console.log(`job ${timedOut.id} timed_out after ${timedOut.slaMs?.toString() ?? "?"} ms (deadline ${timedOut.deadlineAt ?? ""})`);
  console.log(
    `refunded ${timedOut.amountUsdc} USDC to the buyer. Quoted take-rate ${timedOut.takeRateUsdc} was not collected.`,
  );
  console.log(`balances buyer ${timedOut.buyerBalanceUsdc} USDC, seller ${timedOut.sellerBalanceUsdc} USDC`);
  console.log(`passport ${seller.id} ${passportChange.scoreBefore} -> ${passportChange.scoreAfter} (failure)`);
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

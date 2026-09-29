import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockWalletProvider } from "@albesa/core";
import { CapabilityRegistry } from "@albesa/registry";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { AgentFinanceService } from "./service.js";
import { sandboxReceiptListing } from "./jobs.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const totalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["total"],
  properties: { total: { type: "string", minLength: 1 } },
};

const rowsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: { rows: { type: "integer", minimum: 1 } },
};

interface OrgBody {
  apiKey: string;
  organization: { id: string };
}

interface AgentBody {
  agent: { id: string };
}

interface ListingBody {
  listing: { id: string; name: string };
}

interface JobBody {
  job: {
    id: string;
    status: string;
    listingId: string;
    listingName: string;
    sellerAgentId: string;
    buyerAgentId: string;
    sellerOrganizationId: string;
    escrowId: string;
    amountUsdc: string;
    takeRateUsdc: string;
    sellerNetUsdc: string;
    buyerBalanceUsdc: string;
    sellerBalanceUsdc: string;
    validationErrors: string[] | null;
    latencyMs: number | null;
    passport: { agentId: string; scoreBefore: string; scoreAfter: string } | null;
  };
  notification?: { type: string; sellerAgentId: string };
}

interface ErrorBody {
  error: { code: string };
}

interface PassportBody {
  passport: { score: string; metrics: { volumeSettledUsdc: string; successCount: number; failureCount: number } };
}

const invoice = {
  name: "Invoice extractor",
  description: "Extract structured fields from invoices and receipts.",
  inputSchema: { type: "object", properties: { documentUrl: { type: "string" } } },
  outputSchema: { type: "object", properties: { total: { type: "string" } } },
  pricing: { model: "per_call", amountUsdc: "0.02" },
  latency: { p95Ms: 400 },
  tags: ["invoice", "extract"],
};

async function organization(app: ReturnType<typeof createApp>, name = "Acme") {
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(created.status).toBe(201);
  const org = (await created.json()) as OrgBody;
  return {
    apiKey: org.apiKey,
    organizationId: org.organization.id,
    auth: { authorization: `Bearer ${org.apiKey}`, "content-type": "application/json" },
  };
}

async function createAgent(app: ReturnType<typeof createApp>, auth: Record<string, string>, name: string) {
  const response = await app.request("/v1/agents", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, dailySpendLimitUsdc: "10.00", vendorAllowlist: [] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as AgentBody).agent.id;
}

async function fund(app: ReturnType<typeof createApp>, auth: Record<string, string>, agentId: string, amountUsdc: string) {
  const response = await app.request(`/v1/agents/${agentId}/fund`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ amountUsdc }),
  });
  expect(response.status).toBe(200);
}

async function register(
  app: ReturnType<typeof createApp>,
  auth: Record<string, string>,
  body: unknown,
): Promise<string> {
  const response = await app.request("/v1/registry/listings", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as ListingBody).listing.id;
}

async function bind(
  app: ReturnType<typeof createApp>,
  auth: Record<string, string>,
  listingId: string,
  sellerAgentId: string,
) {
  const response = await app.request(`/v1/jobs/listings/${listingId}/seller`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ sellerAgentId }),
  });
  expect(response.status).toBe(200);
  return response;
}

describe("marketplace jobs", () => {
  it("discovers a listing, releases net of the take-rate, and raises the seller passport", async () => {
    const app = createApp({ mode: "sandbox" });
    const { auth } = await organization(app);
    const buyerId = await createAgent(app, auth, "buyer");
    const sellerId = await createAgent(app, auth, "seller");
    await fund(app, auth, buyerId, "5.00");
    const listingId = await register(app, auth, sandboxReceiptListing());
    await bind(app, auth, listingId, sellerId);

    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: totalSchema,
        tags: ["receipt"],
      }),
    });
    expect(created.status).toBe(201);
    const held = (await created.json()) as JobBody;
    expect(held.job.status).toBe("held");
    expect(held.job.listingId).toBe(listingId);
    expect(held.job.listingName).toBe("Receipt parser");
    expect(held.job.sellerAgentId).toBe(sellerId);
    expect(held.job.buyerBalanceUsdc).toBe("4.000000");
    expect(held.job.sellerBalanceUsdc).toBe("0.000000");
    expect(held.job.passport).toBeNull();
    expect(held.notification).toMatchObject({ type: "escrow.held", sellerAgentId: sellerId });

    const listed = await app.request("/v1/jobs", { headers: auth });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { jobs: { id: string }[] }).jobs.map((job) => job.id)).toEqual([held.job.id]);

    const delivered = await app.request(`/v1/jobs/${held.job.id}/result`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ result: { total: "12.50" } }),
    });
    expect(delivered.status).toBe(200);
    const released = (await delivered.json()) as JobBody;
    expect(released.job.status).toBe("released");
    expect(released.job.takeRateUsdc).toBe("0.010000");
    expect(released.job.sellerNetUsdc).toBe("0.990000");
    expect(released.job.buyerBalanceUsdc).toBe("4.000000");
    expect(released.job.sellerBalanceUsdc).toBe("0.990000");
    expect(released.job.validationErrors).toBeNull();
    expect(released.job.latencyMs).toBe(400);
    expect(released.job.passport).toEqual({
      agentId: sellerId,
      scoreBefore: "0.0000",
      scoreAfter: "85.0100",
    });

    const passport = await app.request(`/v1/agents/${sellerId}/passport`, { headers: auth });
    const body = (await passport.json()) as PassportBody;
    expect(body.passport.score).toBe("85.0100");
    expect(body.passport.metrics.successCount).toBe(1);
    expect(body.passport.metrics.volumeSettledUsdc).toBe("1.000000");

    const again = await app.request(`/v1/jobs/${held.job.id}/result`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ result: { total: "12.50" } }),
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorBody).error.code).toBe("invalid_state");

    const read = await app.request(`/v1/jobs/${held.job.id}`, { headers: auth });
    expect(((await read.json()) as JobBody).job.status).toBe("released");
  });

  it("refunds the buyer and records a passport failure when the result fails the schema", async () => {
    const app = createApp({ mode: "sandbox" });
    const { auth } = await organization(app);
    const buyerId = await createAgent(app, auth, "buyer");
    const sellerId = await createAgent(app, auth, "seller");
    await fund(app, auth, buyerId, "1.00");
    const listingId = await register(app, auth, sandboxReceiptListing());
    await bind(app, auth, listingId, sellerId);

    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: rowsSchema,
      }),
    });
    expect(created.status).toBe(201);
    const held = (await created.json()) as JobBody;
    expect(held.job.buyerBalanceUsdc).toBe("0.000000");

    const failed = await app.request(`/v1/jobs/${held.job.id}/result`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ result: { rows: 0 } }),
    });
    expect(failed.status).toBe(200);
    const refunded = (await failed.json()) as JobBody;
    expect(refunded.job.status).toBe("refunded");
    expect(refunded.job.validationErrors).toEqual(["result.rows: expected >= 1."]);
    expect(refunded.job.buyerBalanceUsdc).toBe("1.000000");
    expect(refunded.job.sellerBalanceUsdc).toBe("0.000000");
    expect(refunded.job.latencyMs).toBe(400);
    expect(refunded.job.passport).toEqual({
      agentId: sellerId,
      scoreBefore: "0.0000",
      scoreAfter: "20.0000",
    });

    const passport = await app.request(`/v1/agents/${sellerId}/passport`, { headers: auth });
    const body = (await passport.json()) as PassportBody;
    expect(body.passport.score).toBe("20.0000");
    expect(body.passport.metrics.failureCount).toBe(1);
    expect(body.passport.metrics.volumeSettledUsdc).toBe("0.000000");
  });

  it("picks the top ranked listing and refuses an unbound candidate without locking funds", async () => {
    const app = createApp({ mode: "sandbox" });
    const acme = await organization(app, "Acme");
    const other = await organization(app, "Other");
    const buyerId = await createAgent(app, acme.auth, "buyer");
    const cheapSeller = await createAgent(app, acme.auth, "cheap-seller");
    const priceySeller = await createAgent(app, acme.auth, "pricey-seller");
    await fund(app, acme.auth, buyerId, "3.00");

    const cheap = await register(app, acme.auth, invoice);
    const pricey = await register(app, acme.auth, {
      ...invoice,
      pricing: { model: "per_call", amountUsdc: "0.75" },
      latency: { p95Ms: 2200 },
    });
    const foreign = await register(app, other.auth, {
      ...invoice,
      pricing: { model: "per_call", amountUsdc: "0.01" },
      latency: { p95Ms: 50 },
    });
    await bind(app, acme.auth, cheap, cheapSeller);
    await bind(app, acme.auth, pricey, priceySeller);

    const blocked = await app.request("/v1/jobs", {
      method: "POST",
      headers: acme.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: totalSchema,
      }),
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as ErrorBody).error.code).toBe("seller_unbound");
    const untouched = await app.request(`/v1/agents/${buyerId}/balance`, { headers: acme.auth });
    expect(((await untouched.json()) as { balanceUsdc: string }).balanceUsdc).toBe("3.000000");
    expect(foreign).toBeTruthy();

    const paused = await app.request(`/v1/registry/listings/${foreign}`, {
      method: "PUT",
      headers: other.auth,
      body: JSON.stringify({ status: "paused" }),
    });
    expect(paused.status).toBe(200);

    const tooFast = await app.request("/v1/jobs", {
      method: "POST",
      headers: acme.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: totalSchema,
        maxP95Ms: 100,
      }),
    });
    expect(tooFast.status).toBe(404);
    expect(((await tooFast.json()) as ErrorBody).error.code).toBe("no_candidates");

    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: acme.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: totalSchema,
        tags: ["invoice"],
      }),
    });
    expect(created.status).toBe(201);
    const held = (await created.json()) as JobBody;
    expect(held.job.listingId).toBe(cheap);
    expect(held.job.sellerAgentId).toBe(cheapSeller);

    const weather = await register(app, acme.auth, {
      ...invoice,
      name: "Weather forecast",
      description: "Hourly weather for a city.",
      tags: ["weather"],
      pricing: { model: "per_call", amountUsdc: "0.01" },
      latency: { p95Ms: 80 },
    });
    const unbound = await app.request("/v1/jobs", {
      method: "POST",
      headers: acme.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "hourly weather",
        amountUsdc: "1.00",
        schema: totalSchema,
        tags: ["weather"],
      }),
    });
    expect(unbound.status).toBe(409);
    expect(((await unbound.json()) as ErrorBody).error.code).toBe("seller_unbound");
    expect(weather).toBeTruthy();

    const anonymous = await app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyerAgentId: buyerId, query: "parse receipts", amountUsdc: "1", schema: totalSchema }),
    });
    expect(anonymous.status).toBe(401);
  });

  it("reloads a held job from the jobs file and settles it after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "roster-job-"));
    directories.push(directory);
    const dataFile = join(directory, "sandbox.json");
    const reputationFile = join(directory, "reputation.json");
    const jobsFile = join(directory, "jobs.json");
    const registryPath = join(directory, "registry.json");
    const boot = () =>
      createApp({
        mode: "sandbox",
        dataFile,
        reputationFile,
        jobsFile,
        registry: new CapabilityRegistry({ filePath: registryPath }),
      });

    const first = boot();
    const { auth } = await organization(first);
    const buyerId = await createAgent(first, auth, "buyer");
    const sellerId = await createAgent(first, auth, "seller");
    await fund(first, auth, buyerId, "2.00");
    const listingId = await register(first, auth, sandboxReceiptListing());
    await bind(first, auth, listingId, sellerId);
    const created = await first.request("/v1/jobs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: totalSchema,
      }),
    });
    const held = (await created.json()) as JobBody;
    expect(held.job.status).toBe("held");
    expect(held.job.sellerOrganizationId).toBeTruthy();

    const onDisk = JSON.parse(readFileSync(jobsFile, "utf8")) as { jobs: Record<string, unknown>[] };
    delete onDisk.jobs[0]?.sellerOrganizationId;
    writeFileSync(jobsFile, `${JSON.stringify(onDisk, null, 2)}\n`);

    const second = boot();
    const read = await second.request(`/v1/jobs/${held.job.id}`, { headers: auth });
    expect(read.status).toBe(200);
    expect(((await read.json()) as JobBody).job.status).toBe("held");

    const delivered = await second.request(`/v1/jobs/${held.job.id}/result`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ result: { total: "4.00" } }),
    });
    expect(delivered.status).toBe(200);
    expect(((await delivered.json()) as JobBody).job.passport?.scoreAfter).toBe("85.0100");

    const third = boot();
    const restored = await third.request(`/v1/jobs/${held.job.id}`, { headers: auth });
    const job = ((await restored.json()) as JobBody).job;
    expect(job.status).toBe("released");
    expect(job.sellerBalanceUsdc).toBe("0.990000");
    expect(job.passport?.scoreAfter).toBe("85.0100");
    const passport = await third.request(`/v1/agents/${sellerId}/passport`, { headers: auth });
    expect(((await passport.json()) as PassportBody).passport.score).toBe("85.0100");
  });

  it("settles a paid job from a buyer organization to a seller organization", async () => {
    const wallets = new MockWalletProvider();
    const app = createApp({ mode: "sandbox", service: new AgentFinanceService({ mode: "sandbox", wallets }) });
    const buyerOrg = await organization(app, "Northwind");
    const sellerOrg = await organization(app, "Harbor");
    const rivalOrg = await organization(app, "Drift");
    const buyerId = await createAgent(app, buyerOrg.auth, "buyer");
    const sellerId = await createAgent(app, sellerOrg.auth, "harbor-seller");
    const rivalId = await createAgent(app, rivalOrg.auth, "drift-seller");
    await fund(app, buyerOrg.auth, buyerId, "5.00");

    const seeded = await app.request("/v1/registry/seed", { method: "POST", headers: sellerOrg.auth });
    expect(seeded.status).toBe(201);
    const catalog = ((await seeded.json()) as { listings: { id: string; name: string; agentId: string | null }[] }).listings;
    expect(catalog.map((listing) => listing.name)).toEqual(["Receipt parser", "Doc summarizer", "Unit converter"]);
    const receipt = catalog.find((listing) => listing.name === "Receipt parser");
    expect(receipt).toBeTruthy();
    await bind(app, sellerOrg.auth, receipt!.id, sellerId);

    const again = await app.request("/v1/registry/seed", { method: "POST", headers: sellerOrg.auth });
    expect(again.status).toBe(200);
    const seededAgain = ((await again.json()) as { listings: { id: string }[] }).listings;
    expect(seededAgain.map((listing) => listing.id)).toEqual(catalog.map((listing) => listing.id));

    const rivalListingId = await register(app, rivalOrg.auth, {
      ...sandboxReceiptListing(),
      pricing: { model: "per_call", amountUsdc: "0.01" },
      latency: { p95Ms: 80 },
    });
    await bind(app, rivalOrg.auth, rivalListingId, rivalId);
    const failed = await app.request(`/v1/agents/${rivalId}/reputation/events`, {
      method: "POST",
      headers: rivalOrg.auth,
      body: JSON.stringify({ outcome: "failure", latencyMs: 400, volumeUsdc: "1.00", error: true }),
    });
    expect(failed.status).toBe(201);

    const search = await app.request("/v1/registry/search?q=parse%20receipts&tags=receipt&withReputation=1", {
      headers: buyerOrg.auth,
    });
    expect(search.status).toBe(200);
    const hits = ((await search.json()) as { hits: { listing: { id: string }; reputationScore: number }[] }).hits;
    expect(hits.map((hit) => hit.listing.id)).toEqual([receipt!.id, rivalListingId]);
    expect(hits[0]?.reputationScore).toBe(50);
    expect(hits[1]?.reputationScore).toBe(20);

    const spec = await app.request("/openapi.json");
    expect(spec.status).toBe(200);
    const document = (await spec.json()) as { paths: Record<string, unknown> };
    expect(document.paths["/v1/jobs"]).toBeTruthy();
    expect(document.paths["/v1/registry/seed"]).toBeTruthy();

    const direct = await app.request("/v1/escrows", {
      method: "POST",
      headers: buyerOrg.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        amountUsdc: "1.00",
        schema: totalSchema,
      }),
    });
    expect(direct.status).toBe(404);

    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: buyerOrg.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: totalSchema,
        tags: ["receipt"],
      }),
    });
    expect(created.status).toBe(201);
    const held = (await created.json()) as JobBody;
    expect(held.job.status).toBe("held");
    expect(held.job.listingId).toBe(receipt!.id);
    expect(held.job.sellerAgentId).toBe(sellerId);
    expect(held.job.sellerOrganizationId).toBe(sellerOrg.organizationId);
    expect(held.job.buyerBalanceUsdc).toBe("4.000000");
    expect(held.job.takeRateUsdc).toBe("0.010000");
    expect(held.job.sellerNetUsdc).toBe("0.990000");

    const buyerList = await app.request("/v1/jobs", { headers: buyerOrg.auth });
    const sellerList = await app.request("/v1/jobs", { headers: sellerOrg.auth });
    const strangerList = await app.request("/v1/jobs", { headers: rivalOrg.auth });
    expect(((await buyerList.json()) as { jobs: { id: string }[] }).jobs.map((job) => job.id)).toEqual([held.job.id]);
    expect(((await sellerList.json()) as { jobs: { id: string }[] }).jobs.map((job) => job.id)).toEqual([held.job.id]);
    expect(((await strangerList.json()) as { jobs: { id: string }[] }).jobs).toEqual([]);

    const stranger = await app.request(`/v1/jobs/${held.job.id}`, { headers: rivalOrg.auth });
    expect(stranger.status).toBe(404);

    const buyerDelivery = await app.request(`/v1/jobs/${held.job.id}/result`, {
      method: "POST",
      headers: buyerOrg.auth,
      body: JSON.stringify({ result: { total: "12.50" } }),
    });
    expect(buyerDelivery.status).toBe(403);
    expect(((await buyerDelivery.json()) as ErrorBody).error.code).toBe("forbidden");

    const delivered = await app.request(`/v1/jobs/${held.job.id}/result`, {
      method: "POST",
      headers: sellerOrg.auth,
      body: JSON.stringify({ result: { total: "12.50" } }),
    });
    expect(delivered.status).toBe(200);
    const released = (await delivered.json()) as JobBody;
    expect(released.job.status).toBe("released");
    expect(released.job.takeRateUsdc).toBe("0.010000");
    expect(released.job.sellerNetUsdc).toBe("0.990000");
    expect(released.job.buyerBalanceUsdc).toBe("4.000000");
    expect(released.job.sellerBalanceUsdc).toBe("0.990000");
    expect(released.job.validationErrors).toBeNull();
    expect(released.job.passport).toEqual({
      agentId: sellerId,
      scoreBefore: "0.0000",
      scoreAfter: "85.0100",
    });
    expect(await wallets.getBalance(`mock:fees:${buyerOrg.organizationId}`)).toBe("0.010000");

    const sellerLedger = await app.request(`/v1/agents/${sellerId}/ledger`, { headers: sellerOrg.auth });
    const credits = ((await sellerLedger.json()) as { entries: { direction: string; amountUsdc: string }[] }).entries;
    expect(credits.map((entry) => `${entry.direction}:${entry.amountUsdc}`)).toEqual(["credit:0.990000"]);

    const sellerHistory = await app.request(`/v1/agents/${sellerId}/transactions`, { headers: sellerOrg.auth });
    const transactions = ((await sellerHistory.json()) as { transactions: { type: string; amountUsdc: string }[] }).transactions;
    expect(transactions.map((tx) => tx.type)).toContain("escrow_release");
  });

  it("refunds the buyer when a cross-organization delivery fails validation", async () => {
    const wallets = new MockWalletProvider();
    const app = createApp({ mode: "sandbox", service: new AgentFinanceService({ mode: "sandbox", wallets }) });
    const buyerOrg = await organization(app, "Northwind");
    const sellerOrg = await organization(app, "Harbor");
    const buyerId = await createAgent(app, buyerOrg.auth, "buyer");
    const sellerId = await createAgent(app, sellerOrg.auth, "seller");
    await fund(app, buyerOrg.auth, buyerId, "1.00");
    const listingId = await register(app, sellerOrg.auth, sandboxReceiptListing());
    await bind(app, sellerOrg.auth, listingId, sellerId);

    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: buyerOrg.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: rowsSchema,
        tags: ["receipt"],
      }),
    });
    expect(created.status).toBe(201);
    const held = (await created.json()) as JobBody;
    expect(held.job.buyerBalanceUsdc).toBe("0.000000");
    expect(held.job.sellerAgentId).toBe(sellerId);

    const failed = await app.request(`/v1/jobs/${held.job.id}/result`, {
      method: "POST",
      headers: sellerOrg.auth,
      body: JSON.stringify({ result: { rows: 0 } }),
    });
    expect(failed.status).toBe(200);
    const refunded = (await failed.json()) as JobBody;
    expect(refunded.job.status).toBe("refunded");
    expect(refunded.job.validationErrors).toEqual(["result.rows: expected >= 1."]);
    expect(refunded.job.buyerBalanceUsdc).toBe("1.000000");
    expect(refunded.job.sellerBalanceUsdc).toBe("0.000000");
    expect(refunded.job.takeRateUsdc).toBe("0.010000");
    expect(refunded.job.passport).toEqual({
      agentId: sellerId,
      scoreBefore: "0.0000",
      scoreAfter: "20.0000",
    });
    expect(await wallets.getBalance(`mock:fees:${buyerOrg.organizationId}`)).toBe("0.000000");

    const passport = await app.request(`/v1/agents/${sellerId}/passport`, { headers: buyerOrg.auth });
    const body = (await passport.json()) as PassportBody;
    expect(body.passport.score).toBe("20.0000");
    expect(body.passport.metrics.failureCount).toBe(1);
    expect(body.passport.metrics.volumeSettledUsdc).toBe("0.000000");

    const history = await app.request(`/v1/agents/${buyerId}/transactions`, { headers: buyerOrg.auth });
    const types = ((await history.json()) as { transactions: { type: string }[] }).transactions.map((tx) => tx.type);
    expect(types).toContain("escrow_refund");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@albesa/registry";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
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

  it("picks the top ranked listing and refuses an unbound or cross-organization candidate", async () => {
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
    expect(((await blocked.json()) as ErrorBody).error.code).toBe("cross_org");
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
});

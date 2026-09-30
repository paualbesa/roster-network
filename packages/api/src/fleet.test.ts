import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@albesa/registry";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { bootstrapSandboxFleet } from "./fleet.js";
import { resolveAutofillConfig, sandboxJobSchema, sandboxMarketplaceListings } from "./jobs.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface OrgBody {
  apiKey: string;
  organization: { id: string };
}

interface AgentBody {
  agent: { id: string };
}

interface ListingBody {
  listing: { id: string };
}

interface JobBody {
  job: {
    id: string;
    status: string;
    listingName: string;
    sellerAgentId: string;
    sellerOrganizationId: string;
    result: unknown;
    takeRateUsdc: string;
    sellerNetUsdc: string;
    buyerBalanceUsdc: string;
    sellerBalanceUsdc: string;
    validationErrors: string[] | null;
    latencyMs: number | null;
    passport: { agentId: string; scoreBefore: string; scoreAfter: string } | null;
  };
}

interface PassportBody {
  passport: { score: string; metrics: { successCount: number; failureCount: number; volumeSettledUsdc: string } };
}

const glyph = {
  name: "Glyph counter",
  description: "Count glyphs in a private note.",
  inputSchema: { type: "object", properties: { note: { type: "string" } } },
  outputSchema: { type: "object", properties: { total: { type: "string" } }, required: ["total"] },
  pricing: { model: "per_call" as const, amountUsdc: "0.02" },
  latency: { p95Ms: 400 },
  tags: ["glyph"],
};

async function organization(app: ReturnType<typeof createApp>, name = "Northwind") {
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(created.status).toBe(201);
  const org = (await created.json()) as OrgBody;
  return {
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

async function register(app: ReturnType<typeof createApp>, auth: Record<string, string>, body: unknown) {
  const response = await app.request("/v1/registry/listings", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as ListingBody).listing.id;
}

async function bind(app: ReturnType<typeof createApp>, auth: Record<string, string>, listingId: string, sellerAgentId: string) {
  const response = await app.request(`/v1/jobs/listings/${listingId}/seller`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ sellerAgentId }),
  });
  expect(response.status).toBe(200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("sandbox fleet autofill", () => {
  it("releases escrow and updates the passport without a seller submit", async () => {
    const app = createApp({ mode: "sandbox", autofill: "sync" });
    const fleet = await bootstrapSandboxFleet(app);
    const again = await bootstrapSandboxFleet(app);
    expect(again.createdOrganization).toBe(false);
    expect(again.organizationId).toBe(fleet.organizationId);
    expect(again.sellerAgentId).toBe(fleet.sellerAgentId);
    expect(again.listings.map((listing) => listing.id)).toEqual(fleet.listings.map((listing) => listing.id));
    expect(fleet.listings.map((listing) => listing.name)).toEqual(sandboxMarketplaceListings().map((listing) => listing.name));

    const buyer = await organization(app);
    const buyerId = await createAgent(app, buyer.auth, "buyer");
    await fund(app, buyer.auth, buyerId, "5.00");
    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: buyer.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: sandboxJobSchema("Receipt parser"),
        tags: ["receipt"],
        input: { total: "12.50" },
      }),
    });
    expect(created.status).toBe(201);
    const released = (await created.json()) as JobBody;
    expect(released.job.status).toBe("released");
    expect(released.job.listingName).toBe("Receipt parser");
    expect(released.job.sellerAgentId).toBe(fleet.sellerAgentId);
    expect(released.job.sellerOrganizationId).toBe(fleet.organizationId);
    expect(released.job.result).toEqual({ total: "12.50" });
    expect(released.job.takeRateUsdc).toBe("0.010000");
    expect(released.job.sellerNetUsdc).toBe("0.990000");
    expect(released.job.buyerBalanceUsdc).toBe("4.000000");
    expect(released.job.sellerBalanceUsdc).toBe("1.990000");
    expect(released.job.validationErrors).toBeNull();
    expect(released.job.latencyMs).toBe(0);
    expect(released.job.passport).toEqual({
      agentId: fleet.sellerAgentId,
      scoreBefore: "0.0000",
      scoreAfter: "90.0100",
    });

    const passport = await app.request(`/v1/agents/${fleet.sellerAgentId}/passport`, { headers: buyer.auth });
    expect(passport.status).toBe(200);
    const body = (await passport.json()) as PassportBody;
    expect(body.passport.score).toBe("90.0100");
    expect(body.passport.metrics.successCount).toBe(1);
    expect(body.passport.metrics.volumeSettledUsdc).toBe("1.000000");

    const manual = await app.request(`/v1/jobs/${released.job.id}/result`, {
      method: "POST",
      headers: buyer.auth,
      body: JSON.stringify({ result: { total: "12.50" } }),
    });
    expect(manual.status).toBe(403);
  });

  it("delivers a seeded listing after the configured delay", async () => {
    const app = createApp({ mode: "sandbox", autofill: "async", autofillDelayMs: 40 });
    const fleet = await bootstrapSandboxFleet(app);
    const buyer = await organization(app);
    const buyerId = await createAgent(app, buyer.auth, "buyer");
    await fund(app, buyer.auth, buyerId, "5.00");
    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: buyer.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "unit converter",
        amountUsdc: "0.50",
        schema: sandboxJobSchema("Unit converter"),
        tags: ["convert"],
        input: { value: "2", unit: "kg" },
      }),
    });
    expect(created.status).toBe(201);
    const held = (await created.json()) as JobBody;
    expect(held.job.status).toBe("held");
    expect(held.job.passport).toBeNull();

    await sleep(120);
    const read = await app.request(`/v1/jobs/${held.job.id}`, { headers: buyer.auth });
    const released = (await read.json()) as JobBody;
    expect(released.job.status).toBe("released");
    expect(released.job.result).toEqual({ value: "2000 g" });
    expect(released.job.sellerAgentId).toBe(fleet.sellerAgentId);
    expect(released.job.latencyMs).toBe(40);
    expect(released.job.passport?.scoreBefore).toBe("0.0000");
    expect(released.job.passport?.scoreAfter).not.toBe("0.0000");
    expect(released.job.sellerBalanceUsdc).toBe("1.495000");
  });

  it("times out when autofill runs after the listing SLA", async () => {
    let now = new Date("2026-09-30T00:00:00.000Z");
    const app = createApp({
      mode: "sandbox",
      now: () => now,
      autofill: "async",
      autofillDelayMs: 300,
    });
    const fleet = await bootstrapSandboxFleet(app);
    const buyer = await organization(app);
    const buyerId = await createAgent(app, buyer.auth, "buyer");
    await fund(app, buyer.auth, buyerId, "5.00");
    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: buyer.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: sandboxJobSchema("Receipt parser"),
        tags: ["receipt"],
        input: { total: "12.50" },
      }),
    });
    const held = (await created.json()) as JobBody;
    expect(held.job.status).toBe("held");
    now = new Date(now.getTime() + 60_000);
    await sleep(450);
    const read = await app.request(`/v1/jobs/${held.job.id}`, { headers: buyer.auth });
    const timedOut = (await read.json()) as JobBody;
    expect(timedOut.job.status).toBe("timed_out");
    expect(timedOut.job.validationErrors).toEqual(["SLA deadline passed before a valid result."]);
    expect(timedOut.job.buyerBalanceUsdc).toBe("5.000000");
    expect(timedOut.job.sellerBalanceUsdc).toBe("1.000000");
    expect(timedOut.job.passport).toEqual({
      agentId: fleet.sellerAgentId,
      scoreBefore: "0.0000",
      scoreAfter: "20.0000",
    });
  });

  it("does not autofill a listing outside the sandbox fleet", async () => {
    const app = createApp({ mode: "sandbox", autofill: "sync" });
    const seller = await organization(app, "Harbor");
    const buyerId = await createAgent(app, seller.auth, "buyer");
    const sellerId = await createAgent(app, seller.auth, "seller");
    await fund(app, seller.auth, buyerId, "5.00");
    const listingId = await register(app, seller.auth, glyph);
    await bind(app, seller.auth, listingId, sellerId);
    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: seller.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "glyph counter",
        amountUsdc: "1.00",
        schema: sandboxJobSchema("Receipt parser"),
        tags: ["glyph"],
      }),
    });
    expect(created.status).toBe(201);
    const held = (await created.json()) as JobBody;
    expect(held.job.status).toBe("held");
    expect(held.job.listingName).toBe("Glyph counter");
    expect(held.job.passport).toBeNull();
    expect(held.job.sellerBalanceUsdc).toBe("0.000000");
    await sleep(80);
    const read = await app.request(`/v1/jobs/${held.job.id}`, { headers: seller.auth });
    expect(((await read.json()) as JobBody).job.status).toBe("held");
  });

  it("does not autofill a user-seeded copy of the first-party catalog", async () => {
    const app = createApp({ mode: "sandbox", autofill: "sync" });
    const seller = await organization(app, "Harbor");
    const buyerId = await createAgent(app, seller.auth, "buyer");
    const sellerId = await createAgent(app, seller.auth, "seller");
    await fund(app, seller.auth, buyerId, "5.00");
    const seeded = await app.request("/v1/registry/seed", { method: "POST", headers: seller.auth });
    expect(seeded.status).toBe(201);
    const catalog = ((await seeded.json()) as { listings: { id: string; name: string }[] }).listings;
    const receipt = catalog.find((listing) => listing.name === "Receipt parser");
    expect(receipt).toBeTruthy();
    await bind(app, seller.auth, receipt!.id, sellerId);
    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: seller.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: sandboxJobSchema("Receipt parser"),
        tags: ["receipt"],
        input: { total: "9.00" },
      }),
    });
    expect(created.status).toBe(201);
    const held = (await created.json()) as JobBody;
    expect(held.job.status).toBe("held");
    expect(held.job.listingName).toBe("Receipt parser");
    expect(held.job.result).toBeNull();
    expect(held.job.passport).toBeNull();
    expect(held.job.sellerAgentId).toBe(sellerId);
  });

  it("reloads the fleet from disk and still autofills", async () => {
    const directory = mkdtempSync(join(tmpdir(), "roster-fleet-"));
    directories.push(directory);
    const dataFile = join(directory, "sandbox.json");
    const reputationFile = join(directory, "reputation.json");
    const jobsFile = join(directory, "jobs.json");
    const registryPath = join(directory, "registry.json");
    const boot = () =>
      createApp({
        mode: "sandbox",
        autofill: "sync",
        dataFile,
        reputationFile,
        jobsFile,
        registry: new CapabilityRegistry({ filePath: registryPath }),
      });
    const first = boot();
    const fleet = await bootstrapSandboxFleet(first);
    const second = boot();
    const again = await bootstrapSandboxFleet(second);
    expect(again.createdOrganization).toBe(false);
    expect(again.organizationId).toBe(fleet.organizationId);
    expect(again.sellerAgentId).toBe(fleet.sellerAgentId);
    expect(again.listings.map((listing) => listing.id)).toEqual(fleet.listings.map((listing) => listing.id));

    const buyer = await organization(second);
    const buyerId = await createAgent(second, buyer.auth, "buyer");
    await fund(second, buyer.auth, buyerId, "2.00");
    const created = await second.request("/v1/jobs", {
      method: "POST",
      headers: buyer.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "doc qa",
        amountUsdc: "0.25",
        schema: sandboxJobSchema("Doc Q&A"),
        tags: ["qa"],
        input: { document: "Pay in thirty days.", question: "When?" },
      }),
    });
    expect(created.status).toBe(201);
    const released = (await created.json()) as JobBody;
    expect(released.job.status).toBe("released");
    expect(released.job.listingName).toBe("Doc Q&A");
    expect(released.job.result).toEqual({ answer: "Pay in thirty days.", citations: 1 });
    expect(released.job.sellerAgentId).toBe(fleet.sellerAgentId);
    expect(released.job.passport?.scoreBefore).toBe("0.0000");
    expect(released.job.passport?.scoreAfter).not.toBe("0.0000");
  });

  it("refuses fleet bootstrap outside sandbox mode", async () => {
    const app = createApp({ mode: "testnet" });
    expect(() => bootstrapSandboxFleet(app)).toThrow(/API mode is sandbox/);
  });

  it("reads the autofill env knobs", () => {
    expect(resolveAutofillConfig({}, {})).toEqual({ mode: "async", delayMs: 50 });
    expect(resolveAutofillConfig({}, { ROSTER_AUTOFULFILL: "sync", ROSTER_AUTOFULFILL_DELAY_MS: "80" })).toEqual({
      mode: "sync",
      delayMs: 80,
    });
    expect(resolveAutofillConfig({ mode: "async", delayMs: 10 }, { ROSTER_AUTOFULFILL: "sync" })).toEqual({
      mode: "async",
      delayMs: 10,
    });
    expect(() => resolveAutofillConfig({}, { ROSTER_AUTOFULFILL_DELAY_MS: "soon" })).toThrow(/ROSTER_AUTOFULFILL_DELAY_MS/);
  });
});

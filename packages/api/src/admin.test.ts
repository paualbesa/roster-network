import { afterEach, describe, expect, it } from "vitest";
import { countOnlineAgents } from "./admin.js";
import { createApp } from "./app.js";
import { sandboxJobSchema, sandboxMarketplaceListings, sandboxReceiptListing } from "./jobs.js";

const TOKEN = "operator-sandbox-token";
const PASSWORD = "sandbox-pass-1";

afterEach(() => {
  delete process.env.ROSTER_ADMIN_TOKEN;
});

describe("admin operator API", () => {
  it("counts active agents as online", () => {
    expect(countOnlineAgents([{ status: "active" }, { status: "suspended" }, { status: "active" }])).toBe(2);
    expect(countOnlineAgents([])).toBe(0);
  });

  it("stays closed without a token, with a user key, and when the token is unset", async () => {
    const app = createApp({ mode: "sandbox", adminToken: TOKEN, autofill: "sync" });
    const missing = await app.request("/v1/admin/overview");
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("unauthorized");

    const signup = await signupAccount(app, "ada@example.com", "Ada");
    const userKey = await app.request("/v1/admin/accounts", {
      headers: { authorization: `Bearer ${signup.apiKey}` },
    });
    expect(userKey.status).toBe(401);

    const disabled = createApp({ mode: "sandbox", adminToken: null });
    const closed = await disabled.request("/v1/admin/overview", { headers: adminHeaders(TOKEN) });
    expect(closed.status).toBe(503);
    expect(((await closed.json()) as { error: { code: string } }).error.code).toBe("admin_disabled");

    process.env.ROSTER_ADMIN_TOKEN = "from-the-environment";
    const fromEnv = createApp({ mode: "sandbox" });
    expect((await fromEnv.request("/v1/admin/overview", { headers: adminHeaders(TOKEN) })).status).toBe(401);
    expect(
      (await fromEnv.request("/v1/admin/overview", { headers: { authorization: "Bearer from-the-environment" } }))
        .status,
    ).toBe(200);

    const optionWins = createApp({ mode: "sandbox", adminToken: TOKEN });
    expect((await optionWins.request("/v1/admin/overview", { headers: adminHeaders("from-the-environment") })).status).toBe(
      401,
    );
    expect((await optionWins.request("/v1/admin/overview", { headers: adminHeaders(TOKEN) })).status).toBe(200);
  });

  it("reads overview, accounts, fleet, jobs, and reputation, and keeps secrets out", async () => {
    const app = createApp({ mode: "sandbox", adminToken: TOKEN, autofill: "sync" });
    const ada = await signupAccount(app, "ada@example.com", "Ada");
    const boot = await app.request("/v1/admin/fleet/bootstrap", { method: "POST", headers: adminHeaders(TOKEN) });
    expect(boot.status).toBe(200);
    const fleet = (await boot.json()) as {
      fleet: { organizationId: string; sellerAgentId: string; listings: { id: string; name: string }[]; createdOrganization: boolean };
    };
    expect(fleet.fleet.createdOrganization).toBe(true);
    expect(fleet.fleet.listings.map((listing) => listing.name)).toEqual(
      sandboxMarketplaceListings().map((listing) => listing.name),
    );
    const again = await app.request("/v1/admin/fleet/bootstrap", { method: "POST", headers: adminHeaders(TOKEN) });
    const restored = (await again.json()) as { fleet: { organizationId: string; createdOrganization: boolean } };
    expect(restored.fleet.createdOrganization).toBe(false);
    expect(restored.fleet.organizationId).toBe(fleet.fleet.organizationId);
    expect(JSON.stringify(fleet)).not.toContain("apiKey");

    const cookie = await app.request("/v1/admin/listings", {
      headers: { cookie: `roster_admin_token=${encodeURIComponent(TOKEN)}` },
    });
    expect(cookie.status).toBe(200);
    const listings = (await cookie.json()) as {
      listings: { name: string; party: string; autofill: boolean; sellerAgentId: string | null; p95Ms: number }[];
    };
    const receipt = listings.listings.find((listing) => listing.name === "Receipt parser");
    expect(receipt?.party).toBe("first_party");
    expect(receipt?.autofill).toBe(true);
    expect(receipt?.sellerAgentId).toBe(fleet.fleet.sellerAgentId);
    expect(receipt?.p95Ms).toBeGreaterThan(0);

    const buyerId = await createAgent(app, ada.apiKey, "buyer");
    await fund(app, ada.apiKey, buyerId, "5.00");
    const hired = await app.request("/v1/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${ada.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: sandboxJobSchema("Receipt parser"),
        tags: ["receipt"],
        input: { total: "12.50" },
      }),
    });
    expect(hired.status).toBe(201);
    const released = (await hired.json()) as { job: { id: string; status: string; takeRateUsdc: string } };
    expect(released.job.status).toBe("released");

    const overview = await app.request("/v1/admin/overview", { headers: adminHeaders(TOKEN) });
    expect(overview.status).toBe(200);
    const snapshot = (await overview.json()) as {
      health: { ok: boolean; product: string; mode: string; rail: string; asset: string };
      counts: {
        accounts: number;
        organizations: number;
        agents: number;
        agentsOnline: number;
        listings: number;
        jobs: { locked: number; released: number; timedOut: number; failed: number };
      };
      gmv: { lockedUsdc: string; releasedUsdc: string; takeRateCollectedUsdc: string };
    };
    expect(snapshot.health).toMatchObject({ ok: true, product: "Roster", mode: "sandbox", asset: "USDC" });
    expect(snapshot.counts.accounts).toBe(1);
    expect(snapshot.counts.organizations).toBe(2);
    expect(snapshot.counts.agents).toBe(2);
    expect(snapshot.counts.agentsOnline).toBe(2);
    expect(snapshot.counts.listings).toBe(6);
    expect(snapshot.counts.jobs.released).toBe(1);
    expect(snapshot.counts.jobs.locked).toBe(0);
    expect(snapshot.gmv.releasedUsdc).toBe("1.000000");
    expect(snapshot.gmv.takeRateCollectedUsdc).toBe(released.job.takeRateUsdc);

    const accounts = await app.request("/v1/admin/accounts", { headers: adminHeaders(TOKEN) });
    const directory = (await accounts.json()) as {
      accounts: {
        email: string | null;
        organizationName: string;
        treasuryBalanceUsdc: string;
        organizationCreatedAt: string;
        userCreatedAt: string | null;
      }[];
    };
    const adaRow = directory.accounts.find((account) => account.email === "ada@example.com");
    expect(adaRow?.organizationName).toBe("Ada");
    expect(adaRow?.treasuryBalanceUsdc).toBe("995.000000");
    expect(adaRow?.userCreatedAt).toBeTruthy();
    const labs = directory.accounts.find((account) => account.organizationName === "Roster Labs");
    expect(labs?.email).toBeNull();
    expect(labs?.treasuryBalanceUsdc).toBe("999.000000");
    const serialized = JSON.stringify(directory);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(ada.apiKey);
    expect(serialized).not.toContain("passwordHashes");
    expect(serialized).not.toContain("apiKey");

    const jobs = await app.request("/v1/admin/jobs?status=released", { headers: adminHeaders(TOKEN) });
    const jobList = (await jobs.json()) as { jobs: { id: string; status: string; listingName: string; buyerOrganizationName: string }[] };
    expect(jobList.jobs).toHaveLength(1);
    expect(jobList.jobs[0]?.listingName).toBe("Receipt parser");
    expect(jobList.jobs[0]?.buyerOrganizationName).toBe("Ada");
    const locked = await app.request("/v1/admin/jobs?status=locked", { headers: adminHeaders(TOKEN) });
    expect(((await locked.json()) as { jobs: unknown[] }).jobs).toEqual([]);
    const badFilter = await app.request("/v1/admin/jobs?status=nope", { headers: adminHeaders(TOKEN) });
    expect(badFilter.status).toBe(400);

    const detail = await app.request(`/v1/admin/jobs/${released.job.id}`, { headers: adminHeaders(TOKEN) });
    expect(detail.status).toBe(200);
    const drilled = (await detail.json()) as {
      job: { escrowState: string };
      escrow: { state: string; result: unknown; takeRateCollectedUsdc: string };
    };
    expect(drilled.job.escrowState).toBe("released");
    expect(drilled.escrow.state).toBe("released");
    expect(drilled.escrow.result).toEqual({ total: "12.50" });
    expect(drilled.escrow.takeRateCollectedUsdc).toBe("0.010000");
    const missingJob = await app.request("/v1/admin/jobs/job_missing", { headers: adminHeaders(TOKEN) });
    expect(missingJob.status).toBe(404);

    const reputation = await app.request("/v1/admin/reputation", { headers: adminHeaders(TOKEN) });
    const passports = (await reputation.json()) as {
      agents: { agentId: string; score: string; successCount: number }[];
      recentFailures: unknown[];
    };
    expect(passports.agents[0]?.agentId).toBe(fleet.fleet.sellerAgentId);
    expect(passports.agents[0]?.score).toBe("90.0100");
    expect(passports.agents[0]?.successCount).toBe(1);
    expect(passports.recentFailures).toEqual([]);

    const spec = await app.request("/openapi.json");
    const document = (await spec.json()) as { paths: Record<string, unknown> };
    expect(document.paths["/v1/admin/overview"]).toBeTruthy();
    expect(document.paths["/v1/admin/accounts"]).toBeTruthy();
    expect(document.paths["/v1/admin/jobs"]).toBeTruthy();
    expect(document.paths["/v1/admin/jobs/expire"]).toBeTruthy();
    expect(document.paths["/v1/admin/fleet/bootstrap"]).toBeTruthy();
  });

  it("sweeps expired jobs for every organization and records a passport failure", async () => {
    let current = Date.parse("2026-09-30T12:00:00.000Z");
    const app = createApp({
      mode: "sandbox",
      adminToken: TOKEN,
      autofill: "async",
      autofillDelayMs: 60_000,
      now: () => new Date(current),
    });
    const ada = await signupAccount(app, "ada@example.com", "Ada");
    const buyerId = await createAgent(app, ada.apiKey, "buyer");
    const sellerId = await createAgent(app, ada.apiKey, "seller");
    await fund(app, ada.apiKey, buyerId, "2.00");
    const listing = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: { authorization: `Bearer ${ada.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(sandboxReceiptListing()),
    });
    expect(listing.status).toBe(201);
    const listingId = ((await listing.json()) as { listing: { id: string } }).listing.id;
    const bound = await app.request(`/v1/jobs/listings/${listingId}/seller`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ada.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ sellerAgentId: sellerId }),
    });
    expect(bound.status).toBe(200);
    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${ada.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: sandboxJobSchema("Receipt parser"),
        tags: ["receipt"],
        listingId,
      }),
    });
    expect(created.status).toBe(201);
    const held = (await created.json()) as { job: { id: string; status: string } };
    expect(held.job.status).toBe("held");

    const early = await app.request("/v1/admin/jobs/expire", { method: "POST", headers: adminHeaders(TOKEN) });
    expect(early.status).toBe(200);
    expect(((await early.json()) as { swept: number }).swept).toBe(0);

    current += 60_000;
    const swept = await app.request("/v1/admin/jobs/expire", { method: "POST", headers: adminHeaders(TOKEN) });
    expect(swept.status).toBe(200);
    const body = (await swept.json()) as { swept: number; jobs: { id: string; status: string; escrowState: string }[] };
    expect(body.swept).toBe(1);
    expect(body.jobs[0]?.id).toBe(held.job.id);
    expect(body.jobs[0]?.status).toBe("timed_out");
    expect(body.jobs[0]?.escrowState).toBe("refunded");

    const detail = await app.request(`/v1/admin/jobs/${held.job.id}`, { headers: adminHeaders(TOKEN) });
    const drilled = (await detail.json()) as { escrow: { takeRateCollectedUsdc: string; result: unknown } };
    expect(drilled.escrow.takeRateCollectedUsdc).toBe("0.000000");
    expect(drilled.escrow.result).toBeNull();

    const overview = await app.request("/v1/admin/overview", { headers: adminHeaders(TOKEN) });
    const counts = (await overview.json()) as { counts: { jobs: { timedOut: number; locked: number } }; gmv: { takeRateCollectedUsdc: string } };
    expect(counts.counts.jobs.timedOut).toBe(1);
    expect(counts.counts.jobs.locked).toBe(0);
    expect(counts.gmv.takeRateCollectedUsdc).toBe("0.000000");

    const reputation = await app.request("/v1/admin/reputation", { headers: adminHeaders(TOKEN) });
    const passports = (await reputation.json()) as { recentFailures: { agentId: string }[]; agents: { failureCount: number }[] };
    expect(passports.recentFailures[0]?.agentId).toBe(sellerId);
    expect(passports.agents[0]?.failureCount).toBe(1);

    const third = await app.request("/v1/admin/listings", { headers: adminHeaders(TOKEN) });
    const rows = (await third.json()) as { listings: { id: string; party: string; autofill: boolean }[] };
    const own = rows.listings.find((row) => row.id === listingId);
    expect(own?.party).toBe("third_party");
    expect(own?.autofill).toBe(false);
  });

  it("refuses operator actions outside sandbox mode", async () => {
    const app = createApp({ mode: "testnet", adminToken: TOKEN });
    const overview = await app.request("/v1/admin/overview", { headers: adminHeaders(TOKEN) });
    expect(overview.status).toBe(200);
    expect(((await overview.json()) as { health: { mode: string } }).health.mode).toBe("testnet");
    const expire = await app.request("/v1/admin/jobs/expire", { method: "POST", headers: adminHeaders(TOKEN) });
    expect(expire.status).toBe(403);
    const boot = await app.request("/v1/admin/fleet/bootstrap", { method: "POST", headers: adminHeaders(TOKEN) });
    expect(boot.status).toBe(403);
  });
});

function adminHeaders(token: string): Record<string, string> {
  return { "x-roster-admin-token": token };
}

async function signupAccount(
  app: ReturnType<typeof createApp>,
  email: string,
  name: string,
): Promise<{ apiKey: string }> {
  const response = await app.request("/v1/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { apiKey: string };
}

async function createAgent(app: ReturnType<typeof createApp>, apiKey: string, name: string): Promise<string> {
  const response = await app.request("/v1/agents", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ name, dailySpendLimitUsdc: "1000.00", vendorAllowlist: [] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { agent: { id: string } }).agent.id;
}

async function fund(app: ReturnType<typeof createApp>, apiKey: string, agentId: string, amountUsdc: string): Promise<void> {
  const response = await app.request(`/v1/agents/${agentId}/fund`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ amountUsdc }),
  });
  expect(response.status).toBe(200);
}

import { createHash } from "node:crypto";
import { MockWalletProvider } from "@albesa/core";
import { describe, expect, it } from "vitest";
import { createApp, MAX_BODY_BYTES } from "./app.js";
import { DEFAULT_RATE_LIMITS, type RateLimitConfig } from "./http.js";
import { sandboxReceiptListing } from "./jobs.js";
import { hashPassword, verifyPassword } from "./password.js";
import { AgentFinanceService } from "./service.js";
import { MemoryStore } from "./store.js";
import { startExpirySweeper } from "./sweeper.js";

type App = ReturnType<typeof createApp>;

const json = { "content-type": "application/json" };

async function organization(app: App, name: string): Promise<{ apiKey: string; auth: Record<string, string> }> {
  const response = await app.request("/v1/organizations", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { apiKey: string };
  return { apiKey: body.apiKey, auth: { ...json, authorization: `Bearer ${body.apiKey}` } };
}

async function agent(app: App, auth: Record<string, string>, name: string): Promise<string> {
  const response = await app.request("/v1/agents", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, dailySpendLimitUsdc: "100.00", vendorAllowlist: [] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { agent: { id: string } }).agent.id;
}

const strict: RateLimitConfig = {
  ...DEFAULT_RATE_LIMITS,
  auth: { limit: 3, windowMs: 60_000 },
  waitlist: { limit: 2, windowMs: 60_000 },
  authFailures: { limit: 3, windowMs: 60_000 },
};

describe("request ids, errors, and headers", () => {
  it("adds X-Request-Id, keeps a valid caller id, and answers unknown routes with JSON", async () => {
    const app = createApp({ mode: "sandbox" });
    const health = await app.request("/health");
    expect(health.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{24}$/);
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    const body = (await health.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, storage: "memory" });
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptimeS).toBe("number");

    const echoed = await app.request("/health", { headers: { "x-request-id": "trace-12345678" } });
    expect(echoed.headers.get("x-request-id")).toBe("trace-12345678");
    const replaced = await app.request("/health", { headers: { "x-request-id": "bad id\n" } });
    expect(replaced.headers.get("x-request-id")).toMatch(/^req_/);

    const missing = await app.request("/nope");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "No route for GET /nope." } });
  });

  it("rejects bodies over the limit with 413", async () => {
    const app = createApp({ mode: "sandbox" });
    const response = await app.request("/v1/organizations", {
      method: "POST",
      headers: { ...json, "content-length": String(MAX_BODY_BYTES + 1) },
      body: JSON.stringify({ name: "x".repeat(MAX_BODY_BYTES) }),
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("payload_too_large");
  });

  it("serves the OpenAPI document under /v1 without a key", async () => {
    const app = createApp({ mode: "sandbox" });
    const response = await app.request("/v1/openapi.json");
    expect(response.status).toBe(200);
  });
});

describe("rate limits", () => {
  it("limits sign-ups per client address and sends Retry-After", async () => {
    let now = 1_000_000;
    const app = createApp({ mode: "sandbox", rateLimit: strict, clock: () => now });
    const from = (ip: string) => ({ ...json, "x-forwarded-for": `${ip}, 10.0.0.1` });
    for (let index = 0; index < 3; index += 1) {
      const ok = await app.request("/v1/organizations", {
        method: "POST",
        headers: from("203.0.113.7"),
        body: JSON.stringify({ name: `Org ${index.toString()}` }),
      });
      expect(ok.status).toBe(201);
      expect(ok.headers.get("ratelimit-limit")).toBe("3");
    }
    const limited = await app.request("/v1/organizations", {
      method: "POST",
      headers: from("203.0.113.7"),
      body: JSON.stringify({ name: "Too many" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("rate_limited");

    const otherAddress = await app.request("/v1/organizations", {
      method: "POST",
      headers: from("198.51.100.2"),
      body: JSON.stringify({ name: "Other" }),
    });
    expect(otherAddress.status).toBe(201);

    now += 60_000;
    const afterWindow = await app.request("/v1/organizations", {
      method: "POST",
      headers: from("203.0.113.7"),
      body: JSON.stringify({ name: "Later" }),
    });
    expect(afterWindow.status).toBe(201);
  });

  it("locks out an address after repeated bad keys or admin tokens", async () => {
    const app = createApp({ mode: "sandbox", rateLimit: strict, adminToken: "operator-token-123" });
    const headers = { authorization: "Bearer sk_sandbox_wrong", "cf-connecting-ip": "192.0.2.9" };
    for (let index = 0; index < 3; index += 1) {
      expect((await app.request("/v1/account", { headers })).status).toBe(401);
    }
    expect((await app.request("/v1/account", { headers })).status).toBe(429);
    const admin = await app.request("/v1/admin/overview", {
      headers: { "x-roster-admin-token": "operator-token-123", "cf-connecting-ip": "192.0.2.9" },
    });
    expect(admin.status).toBe(429);
    const elsewhere = await app.request("/v1/admin/overview", {
      headers: { "x-roster-admin-token": "operator-token-123", "cf-connecting-ip": "192.0.2.10" },
    });
    expect(elsewhere.status).toBe(200);
  });

  it("stays off when rateLimit is omitted", async () => {
    const app = createApp({ mode: "sandbox" });
    for (let index = 0; index < 30; index += 1) {
      const response = await app.request("/v1/organizations", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name: `Org ${index.toString()}` }),
      });
      expect(response.status).toBe(201);
    }
  });
});

describe("Idempotency-Key", () => {
  it("replays a fund call instead of moving money twice", async () => {
    const app = createApp({ mode: "sandbox" });
    const { auth } = await organization(app, "Acme");
    const agentId = await agent(app, auth, "buyer");
    const call = (key: string, amountUsdc: string) =>
      app.request(`/v1/agents/${agentId}/fund`, {
        method: "POST",
        headers: { ...auth, "idempotency-key": key },
        body: JSON.stringify({ amountUsdc }),
      });

    const first = await call("fund-1", "5.00");
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const replay = await call("fund-1", "5.00");
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);

    const balance = await app.request(`/v1/agents/${agentId}/balance`, { headers: auth });
    expect(((await balance.json()) as { balanceUsdc: string }).balanceUsdc).toBe("5.000000");

    const conflict = await call("fund-1", "6.00");
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe("idempotency_conflict");

    const fresh = await call("fund-2", "5.00");
    expect(fresh.status).toBe(200);
    const after = await app.request(`/v1/agents/${agentId}/balance`, { headers: auth });
    expect(((await after.json()) as { balanceUsdc: string }).balanceUsdc).toBe("10.000000");
  });

  it("scopes keys to the organization and rejects malformed keys", async () => {
    const app = createApp({ mode: "sandbox" });
    const acme = await organization(app, "Acme");
    const other = await organization(app, "Other");
    const acmeAgent = await agent(app, acme.auth, "a");
    const otherAgent = await agent(app, other.auth, "b");
    const first = await app.request(`/v1/agents/${acmeAgent}/fund`, {
      method: "POST",
      headers: { ...acme.auth, "idempotency-key": "same" },
      body: JSON.stringify({ amountUsdc: "1.00" }),
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/v1/agents/${otherAgent}/fund`, {
      method: "POST",
      headers: { ...other.auth, "idempotency-key": "same" },
      body: JSON.stringify({ amountUsdc: "1.00" }),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBeNull();

    const bad = await app.request(`/v1/agents/${acmeAgent}/fund`, {
      method: "POST",
      headers: { ...acme.auth, "idempotency-key": "has space" },
      body: JSON.stringify({ amountUsdc: "1.00" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("public reads, waitlist, and key revocation", () => {
  it("serves listings and passports without a key", async () => {
    const app = createApp({ mode: "sandbox" });
    const { auth } = await organization(app, "Harbor");
    const sellerId = await agent(app, auth, "seller");
    const listed = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(sandboxReceiptListing()),
    });
    expect(listed.status).toBe(201);
    const listingId = ((await listed.json()) as { listing: { id: string } }).listing.id;

    expect((await app.request("/v1/registry/listings")).status).toBe(200);
    expect((await app.request(`/v1/registry/listings/${listingId}`)).status).toBe(200);
    expect((await app.request("/v1/registry/search?q=receipt")).status).toBe(200);
    const passport = await app.request(`/v1/agents/${sellerId}/passport`);
    expect(passport.status).toBe(200);
    // Writes and private reads still need a key.
    expect((await app.request(`/v1/agents/${sellerId}/balance`)).status).toBe(401);
    expect((await app.request("/v1/jobs")).status).toBe(401);
  });

  it("stores waitlist emails once and shows them to the operator", async () => {
    const app = createApp({ mode: "sandbox", adminToken: "operator-token-123" });
    const join = (email: string) =>
      app.request("/v1/waitlist", { method: "POST", headers: json, body: JSON.stringify({ email, source: "landing" }) });
    expect((await join("Ada@Example.com")).status).toBe(202);
    expect((await join("ada@example.com")).status).toBe(202);
    expect((await join("grace@example.com")).status).toBe(202);
    const invalid = await join("not-an-email");
    expect(invalid.status).toBe(400);

    const admin = { "x-roster-admin-token": "operator-token-123" };
    const list = await app.request("/v1/admin/waitlist", { headers: admin });
    const body = (await list.json()) as { total: number; entries: { email: string; source: string }[] };
    expect(body.total).toBe(2);
    expect(body.entries.map((entry) => entry.email).sort()).toEqual(["ada@example.com", "grace@example.com"]);
    expect(body.entries[0]?.source).toBe("landing");
    const overview = (await (await app.request("/v1/admin/overview", { headers: admin })).json()) as {
      waitlist: { total: number; last7d: number };
    };
    expect(overview.waitlist).toEqual({ total: 2, last7d: 2 });
  });

  it("limits waitlist sign-ups per address", async () => {
    const app = createApp({ mode: "sandbox", rateLimit: strict });
    const join = (email: string) =>
      app.request("/v1/waitlist", {
        method: "POST",
        headers: { ...json, "x-forwarded-for": "203.0.113.50" },
        body: JSON.stringify({ email }),
      });
    expect((await join("a@example.com")).status).toBe(202);
    expect((await join("b@example.com")).status).toBe(202);
    expect((await join("c@example.com")).status).toBe(429);
  });

  it("revokes the presented API key and keeps the others", async () => {
    const app = createApp({ mode: "sandbox" });
    const signup = await app.request("/v1/accounts", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery" }),
    });
    const first = ((await signup.json()) as { apiKey: string }).apiKey;
    const login = await app.request("/v1/accounts/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery" }),
    });
    const second = ((await login.json()) as { apiKey: string }).apiKey;

    const revoke = await app.request("/v1/account/api-key", {
      method: "DELETE",
      headers: { authorization: `Bearer ${second}` },
    });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ revoked: true });
    expect((await app.request("/v1/account", { headers: { authorization: `Bearer ${second}` } })).status).toBe(401);
    expect((await app.request("/v1/account", { headers: { authorization: `Bearer ${first}` } })).status).toBe(200);
  });
});

describe("passwords", () => {
  it("hashes with salted scrypt and verifies", async () => {
    const one = await hashPassword("correct horse battery");
    const two = await hashPassword("correct horse battery");
    expect(one).not.toBe(two);
    expect(one.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword(one, "correct horse battery")).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPassword(one, "wrong horse battery")).toEqual({ ok: false, needsRehash: false });
    expect(await verifyPassword("garbage", "x")).toEqual({ ok: false, needsRehash: false });
  });

  it("accepts a legacy SHA-256 row once and upgrades it to scrypt", async () => {
    const store = new MemoryStore();
    const service = new AgentFinanceService({ mode: "sandbox", store, wallets: new MockWalletProvider() });
    const app = createApp({ mode: "sandbox", service });
    const created = await service.createAccount({
      email: "legacy@example.com",
      password: "old-password-1",
      displayName: null,
    });
    const legacy = createHash("sha256").update("old-password-1", "utf8").digest("hex");
    store.passwordHashes.set(created.user.id, legacy);

    const login = (password: string) =>
      app.request("/v1/accounts/login", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ email: "legacy@example.com", password }),
      });
    expect((await login("wrong-password")).status).toBe(401);
    expect(store.passwordHashes.get(created.user.id)).toBe(legacy);
    expect((await login("old-password-1")).status).toBe(200);
    const upgraded = store.passwordHashes.get(created.user.id) ?? "";
    expect(upgraded.startsWith("scrypt$")).toBe(true);
    expect((await login("old-password-1")).status).toBe(200);
  });
});

describe("SLA sweeper", () => {
  it("refunds held jobs after the listing deadline without a buyer call", async () => {
    let current = Date.parse("2026-10-05T12:00:00.000Z");
    const now = () => new Date(current);
    const app = createApp({
      mode: "sandbox",
      now,
      service: new AgentFinanceService({ mode: "sandbox", wallets: new MockWalletProvider(), now }),
    });
    const buyer = await organization(app, "Northwind");
    const seller = await organization(app, "Harbor");
    const buyerId = await agent(app, buyer.auth, "buyer");
    const sellerId = await agent(app, seller.auth, "seller");
    const funded = await app.request(`/v1/agents/${buyerId}/fund`, {
      method: "POST",
      headers: buyer.auth,
      body: JSON.stringify({ amountUsdc: "1.00" }),
    });
    expect(funded.status).toBe(200);
    const listed = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: seller.auth,
      body: JSON.stringify(sandboxReceiptListing()),
    });
    const listingId = ((await listed.json()) as { listing: { id: string } }).listing.id;
    const bound = await app.request(`/v1/jobs/listings/${listingId}/seller`, {
      method: "PUT",
      headers: seller.auth,
      body: JSON.stringify({ sellerAgentId: sellerId }),
    });
    expect(bound.status).toBe(200);
    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: buyer.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: { type: "object", required: ["total"], properties: { total: { type: "string" } } },
        tags: ["receipt"],
      }),
    });
    expect(created.status).toBe(201);
    const jobId = ((await created.json()) as { job: { id: string } }).job.id;

    const logs: string[] = [];
    const sweeper = startExpirySweeper({ app, intervalMs: 0, log: (line) => logs.push(line) });
    expect(await sweeper.runOnce()).toBe(0);
    current += 10_000;
    expect(await sweeper.runOnce()).toBe(1);
    expect(logs.some((line) => line.includes("sla_sweep"))).toBe(true);
    const job = await app.request(`/v1/jobs/${jobId}`, { headers: buyer.auth });
    expect(((await job.json()) as { job: { status: string } }).job.status).toBe("timed_out");
  });
});

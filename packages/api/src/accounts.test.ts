import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

interface AccountBody {
  user: { id: string; email: string; displayName: string; organizationId: string };
  organization: { id: string; name: string; treasuryWalletId: string };
  apiKey: string;
  treasury: { wallet: { id: string; address: string }; balanceUsdc: string };
}

interface ErrorBody {
  error: { code: string; message: string };
}

const PASSWORD = "sandbox-passphrase-9";

async function signup(
  app: ReturnType<typeof createApp>,
  email: string,
  name?: string,
): Promise<{ body: AccountBody; auth: { authorization: string; "content-type": string } }> {
  const response = await app.request("/v1/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name === undefined ? { email, password: PASSWORD } : { email, password: PASSWORD, name }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as AccountBody;
  return {
    body,
    auth: { authorization: `Bearer ${body.apiKey}`, "content-type": "application/json" },
  };
}

describe("Roster accounts", () => {
  it("provisions a sandbox treasury with demo credits and hashes the password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-account-"));
    const dataFile = join(dir, "sandbox.json");
    const app = createApp({ mode: "sandbox", dataFile });
    const { body, auth } = await signup(app, "Ada@Example.com", "Ada");

    expect(body.user.email).toBe("ada@example.com");
    expect(body.user.displayName).toBe("Ada");
    expect(body.organization.name).toBe("Ada");
    expect(body.organization.id).toBe(body.user.organizationId);
    expect(body.apiKey.startsWith("sk_sandbox_")).toBe(true);
    expect(body.treasury.balanceUsdc).toBe("1000.000000");
    expect(body.treasury.wallet.address.length).toBeGreaterThan(0);
    expect(JSON.stringify(body).includes(PASSWORD)).toBe(false);

    const onDisk = readFileSync(dataFile, "utf8");
    expect(onDisk.includes(PASSWORD)).toBe(false);
    expect(onDisk.includes(body.apiKey)).toBe(false);
    // Salted scrypt, never the bare SHA-256 digest of the password.
    expect(onDisk.includes(createHash("sha256").update(PASSWORD, "utf8").digest("hex"))).toBe(false);
    expect(onDisk).toMatch(/"hash": "scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+"/);
    expect(onDisk.includes(createHash("sha256").update(body.apiKey, "utf8").digest("hex"))).toBe(true);

    const account = await app.request("/v1/account", { headers: auth });
    expect(account.status).toBe(200);
    const view = (await account.json()) as AccountBody;
    expect(view.user.email).toBe("ada@example.com");
    expect(view.treasury.balanceUsdc).toBe("1000.000000");
  });

  it("logs in with a new key scoped to the same wallet and rejects a bad password", async () => {
    const app = createApp({ mode: "sandbox" });
    const { body } = await signup(app, "ada@example.com", "Ada");

    const denied = await app.request("/v1/accounts/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: "wrong-password" }),
    });
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as ErrorBody).error.code).toBe("unauthorized");

    const unknown = await app.request("/v1/accounts/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "missing@example.com", password: PASSWORD }),
    });
    expect(unknown.status).toBe(401);

    const loggedIn = await app.request("/v1/accounts/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ADA@example.com", password: PASSWORD }),
    });
    expect(loggedIn.status).toBe(200);
    const session = (await loggedIn.json()) as AccountBody;
    expect(session.apiKey).not.toBe(body.apiKey);
    expect(session.user.id).toBe(body.user.id);
    expect(JSON.stringify(session).includes(PASSWORD)).toBe(false);

    const treasury = await app.request("/v1/treasury", {
      headers: { authorization: `Bearer ${session.apiKey}` },
    });
    expect(treasury.status).toBe(200);
    expect(((await treasury.json()) as { balanceUsdc: string }).balanceUsdc).toBe("1000.000000");

    const original = await app.request("/v1/treasury", {
      headers: { authorization: `Bearer ${body.apiKey}` },
    });
    expect(original.status).toBe(200);
  });

  it("does not let one account read or fund another account's agent", async () => {
    const app = createApp({ mode: "sandbox" });
    const ada = await signup(app, "ada@example.com", "Ada");
    const bob = await signup(app, "bob@example.com", "Bob");

    const created = await app.request("/v1/agents", {
      method: "POST",
      headers: bob.auth,
      body: JSON.stringify({ name: "bob-agent", dailySpendLimitUsdc: "10.00", vendorAllowlist: [] }),
    });
    expect(created.status).toBe(201);
    const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;

    const peek = await app.request(`/v1/agents/${agentId}/balance`, { headers: ada.auth });
    expect(peek.status).toBe(404);
    expect(((await peek.json()) as ErrorBody).error.code).toBe("not_found");

    const fund = await app.request(`/v1/agents/${agentId}/fund`, {
      method: "POST",
      headers: ada.auth,
      body: JSON.stringify({ amountUsdc: "1.00" }),
    });
    expect(fund.status).toBe(404);

    const own = await app.request(`/v1/agents/${agentId}/fund`, {
      method: "POST",
      headers: bob.auth,
      body: JSON.stringify({ amountUsdc: "1.00" }),
    });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { balanceUsdc: string }).balanceUsdc).toBe("1.000000");

    const adaTreasury = await app.request("/v1/treasury", { headers: ada.auth });
    expect(((await adaTreasury.json()) as { balanceUsdc: string }).balanceUsdc).toBe("1000.000000");
    const bobTreasury = await app.request("/v1/treasury", { headers: bob.auth });
    expect(((await bobTreasury.json()) as { balanceUsdc: string }).balanceUsdc).toBe("999.000000");

    const adaAccount = await app.request("/v1/account", { headers: ada.auth });
    expect(((await adaAccount.json()) as AccountBody).user.email).toBe("ada@example.com");
  });

  it("rejects a duplicate email and a short password", async () => {
    const app = createApp({ mode: "sandbox" });
    await signup(app, "ada@example.com");
    const duplicate = await app.request("/v1/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: PASSWORD }),
    });
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as ErrorBody).error.code).toBe("account_exists");

    const short = await app.request("/v1/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", password: "short" }),
    });
    expect(short.status).toBe(400);
  });

  it("reloads an account after restart and still reads a file written before accounts existed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-account-reload-"));
    const dataFile = join(dir, "sandbox.json");
    const first = createApp({ mode: "sandbox", dataFile });
    const { body } = await signup(first, "ada@example.com", "Ada");

    const second = createApp({ mode: "sandbox", dataFile });
    const loggedIn = await second.request("/v1/accounts/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: PASSWORD }),
    });
    expect(loggedIn.status).toBe(200);
    const session = (await loggedIn.json()) as AccountBody;
    expect(session.treasury.balanceUsdc).toBe("1000.000000");
    expect(session.user.organizationId).toBe(body.organization.id);

    const document = JSON.parse(readFileSync(dataFile, "utf8")) as Record<string, unknown>;
    delete document.users;
    delete document.passwordHashes;
    writeFileSync(dataFile, JSON.stringify(document));

    const legacy = createApp({ mode: "sandbox", dataFile });
    const treasury = await legacy.request("/v1/treasury", {
      headers: { authorization: `Bearer ${body.apiKey}` },
    });
    expect(treasury.status).toBe(200);
    expect(((await treasury.json()) as { balanceUsdc: string }).balanceUsdc).toBe("1000.000000");
    const orphan = await legacy.request("/v1/account", {
      headers: { authorization: `Bearer ${body.apiKey}` },
    });
    // Org key without a user row is treated as a claimable anonymous sandbox.
    expect(orphan.status).toBe(200);
    const view = (await orphan.json()) as { user: null; claimable: boolean; anonymous: boolean };
    expect(view.user).toBeNull();
    expect(view.claimable).toBe(true);
    expect(view.anonymous).toBe(true);
  });

  it("does not grant demo credits outside sandbox mode", async () => {
    const app = createApp({ mode: "testnet" });
    const response = await app.request("/v1/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: PASSWORD, name: "Ada" }),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as AccountBody).treasury.balanceUsdc).toBe("0.000000");
  });
});

describe("anonymous sandbox keys", () => {
  it("creates a claimable org, hashes the key, and supports claim + rotate + revoke", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-anon-"));
    const dataFile = join(dir, "sandbox.json");
    const app = createApp({ mode: "sandbox", dataFile });

    const created = await app.request("/v1/accounts/anonymous", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.40" },
      body: "{}",
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      apiKey: string;
      claimable: boolean;
      anonymous: boolean;
      organization: { id: string; name: string };
      treasury: { balanceUsdc: string };
    };
    expect(body.apiKey.startsWith("sk_sandbox_")).toBe(true);
    expect(body.claimable).toBe(true);
    expect(body.anonymous).toBe(true);
    expect(body.organization.name).toBe("Anonymous sandbox");
    expect(body.treasury.balanceUsdc).toBe("1000.000000");

    const onDisk = readFileSync(dataFile, "utf8");
    expect(onDisk.includes(body.apiKey)).toBe(false);
    expect(onDisk.includes(createHash("sha256").update(body.apiKey, "utf8").digest("hex"))).toBe(true);

    const auth = { authorization: `Bearer ${body.apiKey}`, "content-type": "application/json" };
    const account = await app.request("/v1/account", { headers: auth });
    expect(account.status).toBe(200);
    const view = (await account.json()) as { user: null; claimable: boolean; anonymous: boolean };
    expect(view.user).toBeNull();
    expect(view.claimable).toBe(true);
    expect(view.anonymous).toBe(true);

    const claim = await app.request("/v1/account/claim", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "anon@example.com", password: PASSWORD, name: "Anon" }),
    });
    expect(claim.status).toBe(201);
    const claimed = (await claim.json()) as AccountBody;
    expect(claimed.user.email).toBe("anon@example.com");
    expect(claimed.apiKey).not.toBe(body.apiKey);
    expect(claimed.organization.id).toBe(body.organization.id);

    const oldKey = await app.request("/v1/account", { headers: auth });
    expect(oldKey.status).toBe(200);

    const claimedAuth = { authorization: `Bearer ${claimed.apiKey}`, "content-type": "application/json" };
    const rotate = await app.request("/v1/account/api-key/rotate", { method: "POST", headers: claimedAuth });
    expect(rotate.status).toBe(200);
    const rotated = (await rotate.json()) as { apiKey: string };
    expect(rotated.apiKey.startsWith("sk_sandbox_")).toBe(true);
    expect(rotated.apiKey).not.toBe(claimed.apiKey);

    const dead = await app.request("/v1/account", { headers: claimedAuth });
    expect(dead.status).toBe(401);

    const rotatedAuth = { authorization: `Bearer ${rotated.apiKey}` };
    expect((await app.request("/v1/account", { headers: rotatedAuth })).status).toBe(200);

    const revoked = await app.request("/v1/account/api-key", { method: "DELETE", headers: rotatedAuth });
    expect(revoked.status).toBe(200);
    expect((await app.request("/v1/account", { headers: rotatedAuth })).status).toBe(401);
  });

  it("rate-limits anonymous creation per IP more tightly than email signup", async () => {
    const now = 2_000_000;
    const app = createApp({
      mode: "sandbox",
      rateLimit: {
        auth: { limit: 20, windowMs: 60_000 },
        anonymous: { limit: 2, windowMs: 60 * 60_000 },
        waitlist: { limit: 10, windowMs: 60_000 },
        authFailures: { limit: 30, windowMs: 10 * 60_000 },
        organization: { limit: 1200, windowMs: 60_000 },
        publicRead: { limit: 300, windowMs: 60_000 },
      },
      clock: () => now,
    });
    const headers = { "content-type": "application/json", "x-forwarded-for": "203.0.113.90" };
    expect((await app.request("/v1/accounts/anonymous", { method: "POST", headers, body: "{}" })).status).toBe(201);
    expect((await app.request("/v1/accounts/anonymous", { method: "POST", headers, body: "{}" })).status).toBe(201);
    const limited = await app.request("/v1/accounts/anonymous", { method: "POST", headers, body: "{}" });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as ErrorBody).error.code).toBe("rate_limited");

    const other = await app.request("/v1/accounts/anonymous", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.91" },
      body: "{}",
    });
    expect(other.status).toBe(201);
  });

  it("rejects claiming an already-claimed org and duplicate emails", async () => {
    const app = createApp({ mode: "sandbox" });
    const { body: first } = await signup(app, "taken@example.com", "Taken");
    const anon = await app.request("/v1/accounts/anonymous", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const anonBody = (await anon.json()) as { apiKey: string };
    const auth = { authorization: `Bearer ${anonBody.apiKey}`, "content-type": "application/json" };

    const dupEmail = await app.request("/v1/account/claim", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "taken@example.com", password: PASSWORD }),
    });
    expect(dupEmail.status).toBe(409);

    const ok = await app.request("/v1/account/claim", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "fresh@example.com", password: PASSWORD }),
    });
    expect(ok.status).toBe(201);

    const again = await app.request("/v1/account/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${((await ok.json()) as AccountBody).apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "other@example.com", password: PASSWORD }),
    });
    expect(again.status).toBe(409);
    expect(first.user.email).toBe("taken@example.com");
  });
});

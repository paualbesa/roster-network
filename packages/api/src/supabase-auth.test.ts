import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const AUTH_USER = "00000000-0000-4000-8000-0000000000aa";
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";

describe("Supabase Auth session", () => {
  it("says the API is not configured when Supabase env is absent", async () => {
    const app = createApp({ mode: "sandbox" });
    const response = await app.request("/v1/accounts/session", {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "supabase_unconfigured" } });
  });

  it("links a Supabase user, issues an API key, and accepts the access token", async () => {
    const app = createApp({
      mode: "sandbox",
      supabase: {
        verifyAccessToken: async (token) =>
          token === ACCESS_TOKEN ? { id: AUTH_USER, email: "ada@example.com", displayName: "Ada" } : null,
      },
    });
    const created = await app.request("/v1/accounts/session", {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { apiKey: string; user: { organizationId: string; email: string } };
    expect(body.apiKey.startsWith("sk_sandbox_")).toBe(true);
    expect(body.user.email).toBe("ada@example.com");

    const again = await app.request("/v1/accounts/session", {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const second = (await again.json()) as { user: { organizationId: string } };
    expect(second.user.organizationId).toBe(body.user.organizationId);

    const account = await app.request("/v1/account", {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(account.status).toBe(200);

    const withKey = await app.request("/v1/account", {
      headers: { authorization: `Bearer ${body.apiKey}` },
    });
    expect(withKey.status).toBe(200);
  });

  it("keeps a password account and links it by email", async () => {
    const app = createApp({
      mode: "sandbox",
      supabase: {
        verifyAccessToken: async () => ({ id: AUTH_USER, email: "ada@example.com", displayName: null }),
      },
    });
    const signup = await app.request("/v1/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: "sandbox-passphrase-9", name: "Ada" }),
    });
    const first = (await signup.json()) as { user: { organizationId: string } };
    const session = await app.request("/v1/accounts/session", {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const linked = (await session.json()) as { user: { organizationId: string } };
    expect(linked.user.organizationId).toBe(first.user.organizationId);
  });

  it("flushes after a write when a mirror is attached", async () => {
    let flushes = 0;
    const app = createApp({
      mode: "sandbox",
      supabase: {
        verifyAccessToken: async () => null,
        flush: async () => {
          flushes += 1;
        },
      },
    });
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    expect(created.status).toBe(201);
    expect(flushes).toBe(1);
  });
});

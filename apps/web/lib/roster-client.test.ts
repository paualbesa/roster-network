import { describe, expect, it, vi } from "vitest";
import { createRosterClient, formatPassport, readError, registrySearchPath } from "./roster-client";

describe("registry search path", () => {
  it("sends q, semantic=1, and withReputation=1 when those options are on", () => {
    expect(registrySearchPath({ q: "parse receipts", semantic: true, withReputation: true })).toBe(
      "/v1/registry/search?q=parse+receipts&semantic=1&withReputation=1",
    );
    expect(registrySearchPath({ q: "  ", semantic: false, withReputation: false })).toBe("/v1/registry/search");
  });

  it("formats a passport score and leaves an unranked hit blank", () => {
    expect(formatPassport(50)).toBe("50.0");
    expect(formatPassport(null)).toBe("—");
  });
});

describe("Roster client", () => {
  it("posts signup without a bearer token and keeps the api key", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ accept: "application/json", "content-type": "application/json" });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.body).toBe(JSON.stringify({ email: "ada@example.com", password: "sandbox-pass", name: "Ada" }));
      return jsonResponse({
        apiKey: "sk_sandbox_once",
        user: { id: "usr_1", email: "ada@example.com", organizationId: "org_1", displayName: "Ada" },
        treasury: { balanceUsdc: "1000.000000" },
      });
    });
    const client = createRosterClient({ baseUrl: "http://api.test", fetchImpl });
    const account = await client.signup({ email: " ada@example.com ", password: "sandbox-pass", name: " Ada " });
    expect(account.apiKey).toBe("sk_sandbox_once");
    expect(account.organizationId).toBe("org_1");
    expect(fetchImpl).toHaveBeenCalledWith("http://api.test/v1/accounts", expect.any(Object));
  });

  it("exchanges a Supabase access token without a sandbox API key", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
      expect(init?.body).toBeUndefined();
      return jsonResponse({
        apiKey: "sk_sandbox_once",
        user: { id: "usr_1", email: "ada@example.com", organizationId: "org_1", displayName: "Ada" },
        treasury: { balanceUsdc: "1000.000000" },
      });
    });
    const client = createRosterClient({ baseUrl: "http://api.test", fetchImpl });
    const account = await client.adoptSession("access-token");
    expect(account.apiKey).toBe("sk_sandbox_once");
    expect(fetchImpl).toHaveBeenCalledWith("http://api.test/v1/accounts/session", expect.any(Object));
  });

  it("sends the sandbox key and surfaces the API error message", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ error: { code: "insufficient_balance", message: "Agent balance is too low." } }, 409),
    );
    const client = createRosterClient({ baseUrl: "http://api.test", apiKey: "sk_sandbox_once", fetchImpl });
    await expect(client.treasury()).rejects.toMatchObject({
      name: "RosterApiError",
      status: 409,
      code: "insufficient_balance",
      message: "Agent balance is too low.",
    });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_sandbox_once");
  });

  it("reads a job receipt", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        job: {
          id: "job_1",
          status: "released",
          listingId: "cap_1",
          listingName: "Receipt parser",
          query: "parse receipts",
          amountUsdc: "1.000000",
          takeRateUsdc: "0.010000",
          sellerNetUsdc: "0.990000",
          buyerBalanceUsdc: "4.000000",
          sellerBalanceUsdc: "0.990000",
          escrowId: "esc_1",
          validationErrors: null,
          buyerAgentId: "agt_b",
          sellerAgentId: "agt_s",
        },
      }),
    );
    const client = createRosterClient({ baseUrl: "/roster-api", apiKey: "sk_sandbox_once", fetchImpl });
    const job = await client.job("job_1");
    expect(job.takeRateUsdc).toBe("0.010000");
    expect(job.sellerNetUsdc).toBe("0.990000");
    expect(job.status).toBe("released");
  });
});

describe("readError", () => {
  it("falls back when the body is not the API error shape", () => {
    expect(readError(null, 502)).toEqual({
      code: "request_failed",
      message: "Roster API returned 502.",
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

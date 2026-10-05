import { describe, expect, it } from "vitest";
import { Albesa, AlbesaError, Roster, RosterError } from "./index.js";

type Call = { url: string; init: RequestInit };

function scripted(responses: (Response | Error)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const balance = { agentId: "agt_1", walletId: "wal_1", address: "addr", balanceUsdc: "1.000000" };

describe("SDK transport", () => {
  it("exports Roster and RosterError as aliases", () => {
    expect(Roster).toBe(Albesa);
    expect(RosterError).toBe(AlbesaError);
  });

  it("retries a GET on 503 and returns the next success", async () => {
    const { fetch, calls } = scripted([jsonResponse(503, { error: { code: "unavailable", message: "x" } }), jsonResponse(200, balance)]);
    const client = new Roster({ apiKey: "sk_sandbox_test", fetch, retryBaseDelayMs: 1 });
    const result = await client.agents.balance("agt_1");
    expect(result.balanceUsdc).toBe("1.000000");
    expect(calls).toHaveLength(2);
  });

  it("sends one Idempotency-Key for every attempt of a fund call", async () => {
    const { fetch, calls } = scripted([
      jsonResponse(429, { error: { code: "rate_limited", message: "slow down" } }, { "retry-after": "0" }),
      new TypeError("socket hang up"),
      jsonResponse(200, { transaction: { id: "txn_1", amountUsdc: "1.000000" }, balanceUsdc: "1.000000" }),
    ]);
    const client = new Albesa({ apiKey: "sk_sandbox_test", fetch, retryBaseDelayMs: 1, maxRetries: 3 });
    await client.agents.fund("agt_1", "1.00");
    expect(calls).toHaveLength(3);
    const keys = calls.map((call) => (call.init.headers as Record<string, string>)["idempotency-key"]);
    expect(keys[0]).toMatch(/^sdk_/);
    expect(new Set(keys).size).toBe(1);
  });

  it("does not retry a write without an Idempotency-Key", async () => {
    const { fetch, calls } = scripted([jsonResponse(503, { error: { code: "unavailable", message: "down" } })]);
    const client = new Albesa({ apiKey: "sk_sandbox_test", fetch, retryBaseDelayMs: 1 });
    await expect(
      client.agents.create({ name: "a", dailySpendLimitUsdc: "1.00", vendorAllowlist: [] }),
    ).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(calls).toHaveLength(1);
  });

  it("surfaces the request id and Retry-After on errors", async () => {
    const { fetch } = scripted([
      jsonResponse(429, { error: { code: "rate_limited", message: "slow down" } }, { "x-request-id": "req_abc", "retry-after": "7" }),
    ]);
    const client = new Albesa({ apiKey: "sk_sandbox_test", fetch, maxRetries: 0 });
    const error = await client.agents.balance("agt_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AlbesaError);
    expect(error).toMatchObject({ status: 429, code: "rate_limited", requestId: "req_abc", retryAfterS: 7 });
  });

  it("times out a hung request", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const client = new Albesa({ apiKey: "sk_sandbox_test", fetch: hanging, timeoutMs: 20, maxRetries: 0 });
    await expect(client.agents.balance("agt_1")).rejects.toMatchObject({ status: 0, code: "timeout" });
  });
});

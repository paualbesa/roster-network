import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

interface OrgBody {
  apiKey: string;
}

interface ListingBody {
  listing: { id: string; name: string; pricing: { amountUsdc: string } };
}

interface SearchBody {
  hits: {
    listing: { id: string; name: string; agentId: string | null };
    score: number;
    relevance: number;
    reputationScore?: number;
  }[];
}

interface AgentBody {
  agent: { id: string };
}

interface ErrorBody {
  error: { code: string; message: string };
}

const invoice = {
  name: "Invoice extractor",
  description: "Extract structured fields from invoices and receipts.",
  inputSchema: { type: "object", properties: { documentUrl: { type: "string" } }, required: ["documentUrl"] },
  outputSchema: { type: "object", properties: { total: { type: "string" } } },
  pricing: { model: "per_call", amountUsdc: "0.02" },
  latency: { p95Ms: 400 },
  tags: ["invoice", "extract"],
};

async function organization(app: ReturnType<typeof createApp>, name: string) {
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(created.status).toBe(201);
  const org = (await created.json()) as OrgBody;
  return { authorization: `Bearer ${org.apiKey}`, "content-type": "application/json" };
}

describe("capability registry routes", () => {
  it("requires an organization API key, then registers and ranks listings", async () => {
    const app = createApp({ mode: "sandbox" });
    const anonymous = await app.request("/v1/registry/search");
    expect(anonymous.status).toBe(401);

    const auth = await organization(app, "Acme");
    const other = await organization(app, "Other");

    const cheap = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(invoice),
    });
    expect(cheap.status).toBe(201);
    const cheapId = ((await cheap.json()) as ListingBody).listing.id;

    const pricey = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: other,
      body: JSON.stringify({
        ...invoice,
        pricing: { model: "per_call", amountUsdc: "0.80" },
        latency: { p95Ms: 2500 },
      }),
    });
    expect(pricey.status).toBe(201);
    const priceyId = ((await pricey.json()) as ListingBody).listing.id;

    const weather = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        ...invoice,
        name: "Weather forecast",
        description: "Hourly weather for a city.",
        tags: ["weather"],
        pricing: { model: "per_call", amountUsdc: "0.01" },
        latency: { p95Ms: 90 },
      }),
    });
    expect(weather.status).toBe(201);

    const fetched = await app.request(`/v1/registry/listings/${cheapId}`, { headers: other });
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as ListingBody).listing.name).toBe("Invoice extractor");

    const search = await app.request("/v1/registry/search?q=parse%20receipts", { headers: auth });
    expect(search.status).toBe(200);
    const hits = ((await search.json()) as SearchBody).hits;
    expect(hits.map((hit) => hit.listing.id)).toEqual([cheapId, priceyId]);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
    expect(hits[0]?.relevance).toBe(hits[1]?.relevance);

    const blocked = await app.request(`/v1/registry/listings/${cheapId}`, {
      method: "PUT",
      headers: other,
      body: JSON.stringify({ name: "Stolen extractor" }),
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as ErrorBody).error.code).toBe("forbidden");

    const missing = await app.request("/v1/registry/listings/cap_missing", { headers: auth });
    expect(missing.status).toBe(404);
  });

  it("blends mocked passport scores and filters with minScore", async () => {
    const scores = new Map<string, number>();
    let lookups = 0;
    const app = createApp({
      mode: "sandbox",
      passportScores: (listing) => {
        lookups += 1;
        return scores.has(listing.id) ? (scores.get(listing.id) ?? null) : null;
      },
    });
    const auth = await organization(app, "Acme");
    const lowId = await publish(app, auth, invoice);
    const highId = await publish(app, auth, invoice);
    scores.set(lowId, 0);
    scores.set(highId, 96);

    const plain = await app.request("/v1/registry/search?q=parse%20receipts", { headers: auth });
    expect(plain.status).toBe(200);
    expect(lookups).toBe(0);
    const plainHits = ((await plain.json()) as SearchBody).hits;
    expect(plainHits.every((hit) => hit.reputationScore === undefined)).toBe(true);
    expect(plainHits[0]?.score).toBe(plainHits[1]?.score);

    const blended = await app.request("/v1/registry/search?q=parse%20receipts&withReputation=1", { headers: auth });
    expect(blended.status).toBe(200);
    expect(lookups).toBeGreaterThan(0);
    const blendedHits = ((await blended.json()) as SearchBody).hits;
    expect(blendedHits.map((hit) => hit.listing.id)).toEqual([highId, lowId]);
    expect(blendedHits.map((hit) => hit.reputationScore)).toEqual([96, 0]);
    expect(blendedHits[0]?.score).toBeGreaterThan(blendedHits[1]?.score ?? 0);

    const before = lookups;
    const again = await app.request("/v1/registry/search?q=parse%20receipts&withReputation=0", { headers: auth });
    expect(again.status).toBe(200);
    expect(lookups).toBe(before);

    const strict = await app.request("/v1/registry/search?q=parse%20receipts&minScore=90", { headers: auth });
    expect(((await strict.json()) as SearchBody).hits.map((hit) => hit.listing.id)).toEqual([highId]);

    const neutralId = await publish(app, auth, invoice);
    const floor = await app.request("/v1/registry/search?q=parse%20receipts&minScore=60", { headers: auth });
    const floorIds = ((await floor.json()) as SearchBody).hits.map((hit) => hit.listing.id);
    expect(floorIds).toEqual([highId]);
    expect(floorIds).not.toContain(neutralId);

    const open = await app.request("/v1/registry/search?q=parse%20receipts&minScore=50&withReputation=true", {
      headers: auth,
    });
    const openHits = ((await open.json()) as SearchBody).hits;
    expect(openHits.map((hit) => hit.listing.id)).toEqual([highId, neutralId]);
    expect(openHits.find((hit) => hit.listing.id === neutralId)?.reputationScore).toBe(50);

    const badFloor = await app.request("/v1/registry/search?minScore=101", { headers: auth });
    expect(badFloor.status).toBe(400);
    expect(((await badFloor.json()) as ErrorBody).error.code).toBe("invalid_request");
    const badFlag = await app.request("/v1/registry/search?withReputation=yes", { headers: auth });
    expect(badFlag.status).toBe(400);
  });

  it("reads sandbox passports for the seller and stays neutral without events", async () => {
    const app = createApp({ mode: "sandbox" });
    const auth = await organization(app, "Acme");
    const solo = await organization(app, "Solo");
    const reliable = await createAgent(app, auth, "reliable");
    const flaky = await createAgent(app, auth, "flaky");
    const empty = await createAgent(app, auth, "empty");
    const soloAgent = await createAgent(app, solo, "solo");

    expect(
      (
        await app.request(`/v1/agents/${reliable}/reputation/events`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ outcome: "success", latencyMs: 500, volumeUsdc: "100" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(`/v1/agents/${flaky}/reputation/events`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            outcome: "failure",
            latencyMs: 3000,
            volumeUsdc: "50",
            error: true,
            hallucination: true,
          }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(`/v1/agents/${soloAgent}/reputation/events`, {
          method: "POST",
          headers: solo,
          body: JSON.stringify({ outcome: "success", latencyMs: 500, volumeUsdc: "100" }),
        })
      ).status,
    ).toBe(201);

    const emptyPassport = await app.request(`/v1/agents/${empty}/passport`, { headers: auth });
    expect(((await emptyPassport.json()) as { passport: { score: string } }).passport.score).toBe("0.0000");

    const reliableId = await publish(app, auth, { ...invoice, agentId: reliable });
    const flakyId = await publish(app, auth, { ...invoice, agentId: flaky });
    const emptyId = await publish(app, auth, { ...invoice, agentId: empty });
    const unboundId = await publish(app, auth, invoice);
    const soloId = await publish(app, solo, invoice);

    const foreign = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ...invoice, agentId: soloAgent }),
    });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as ErrorBody).error.code).toBe("invalid_request");

    const plain = await app.request("/v1/registry/search?q=extract%20invoices", { headers: auth });
    const plainHits = ((await plain.json()) as SearchBody).hits;
    expect(plainHits.every((hit) => hit.reputationScore === undefined)).toBe(true);
    expect(plainHits.find((hit) => hit.listing.id === reliableId)?.score).toBe(
      plainHits.find((hit) => hit.listing.id === flakyId)?.score,
    );

    const blended = await app.request("/v1/registry/search?q=extract%20invoices&withReputation=1", { headers: auth });
    const blendedHits = ((await blended.json()) as SearchBody).hits;
    const scoreOf = (id: string) => blendedHits.find((hit) => hit.listing.id === id);
    expect(scoreOf(reliableId)?.reputationScore).toBe(84.75);
    expect(scoreOf(flakyId)?.reputationScore).toBe(0);
    expect(scoreOf(emptyId)?.reputationScore).toBe(50);
    expect(scoreOf(unboundId)?.reputationScore).toBe(50);
    expect(scoreOf(soloId)?.reputationScore).toBe(84.75);
    expect(scoreOf(reliableId)?.score ?? 0).toBeGreaterThan(scoreOf(emptyId)?.score ?? 1);
    expect(scoreOf(emptyId)?.score ?? 0).toBeGreaterThan(scoreOf(flakyId)?.score ?? 1);
    expect(scoreOf(reliableId)?.listing.agentId).toBe(reliable);
    expect(scoreOf(soloId)?.listing.agentId).toBeNull();

    const floor = await app.request("/v1/registry/search?q=extract%20invoices&minScore=80", { headers: auth });
    const floorIds = ((await floor.json()) as SearchBody).hits.map((hit) => hit.listing.id);
    expect(floorIds).toHaveLength(2);
    expect(floorIds).toEqual(expect.arrayContaining([reliableId, soloId]));
    expect(floorIds).not.toContain(emptyId);
    expect(floorIds).not.toContain(flakyId);
    expect(floorIds).not.toContain(unboundId);
  });
});

async function createAgent(app: ReturnType<typeof createApp>, headers: Record<string, string>, name: string) {
  const created = await app.request("/v1/agents", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name,
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: ["vendor_data"],
    }),
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as AgentBody).agent.id;
}

async function publish(app: ReturnType<typeof createApp>, headers: Record<string, string>, body: unknown) {
  const created = await app.request("/v1/registry/listings", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as ListingBody).listing.id;
}

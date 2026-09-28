import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

interface OrgBody {
  apiKey: string;
}

interface ListingBody {
  listing: { id: string; name: string; pricing: { amountUsdc: string } };
}

interface SearchBody {
  hits: { listing: { id: string; name: string }; score: number; relevance: number }[];
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
});

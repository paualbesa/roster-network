import type { Context, Env, Hono } from "hono";
import type { CapabilityRegistry } from "@albesa/registry";
import type { DataCatalog } from "./data/catalog.js";
import { LocalDataStore, type DataStore } from "./data/store.js";
import type { DemandLog } from "./demand.js";
import { DATA_ORG_NAME } from "./fleet.js";
import { buyListing, matchNeed, NEED_MATCH_THRESHOLD, NEED_WEAK_THRESHOLD, parseNeedBody, type NeedDeps } from "./need.js";
import { ServiceError } from "./service.js";

export const DATA_DOWNLOAD_TOKEN_RE = /^\/v1\/data\/download\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface DataRouteDeps extends NeedDeps {
  dataStore: DataStore | null;
  /** Organization for an optional Bearer key on public routes. Null when absent or unknown. */
  optionalOrg: (headers: Headers) => Promise<string | null>;
  /** Organization of an authenticated route (set by the auth middleware). */
  orgOf: (c: Context) => string;
}

async function readBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ServiceError(400, "invalid_request", "Expected a JSON body.");
  }
}

function listingForSlug(registry: CapabilityRegistry, slug: string) {
  return registry.list().find((listing) => listing.data?.slug === slug && (listing.kind ?? "service") !== "service") ?? null;
}

export function registerDataRoutes<E extends Env>(app: Hono<E>, deps: DataRouteDeps): void {
  app.get("/v1/data/products", (c) => {
    const products = (deps.data?.list() ?? []).map((product) => {
      const listing = listingForSlug(deps.registry, product.slug);
      return { ...product, listingId: listing?.id ?? null };
    });
    const summary = {
      products: products.length,
      fresh: products.filter((product) => product.status === "ok" || product.status === "live").length,
      // Derived lookups reuse their parent's rows; count them once.
      rows: products.reduce((sum, product) => sum + (product.derivedFrom ? 0 : product.rowCount), 0),
    };
    return c.json({ seller: DATA_ORG_NAME, summary, products });
  });

  app.get("/v1/data/products/:slug", (c) => {
    const product = deps.data?.info(c.req.param("slug"));
    if (!product) throw new ServiceError(404, "not_found", "Data product not found.");
    const listing = listingForSlug(deps.registry, product.slug);
    return c.json({ product: { ...product, listingId: listing?.id ?? null }, listing });
  });

  app.get("/v1/data/download/:token", (c) => {
    const store = deps.dataStore;
    if (!(store instanceof LocalDataStore)) throw new ServiceError(404, "not_found", "Download link not found.");
    const file = store.resolve(c.req.param("token"));
    if (!file) throw new ServiceError(404, "not_found", "Download link expired or invalid.");
    return new Response(Buffer.from(file.body), {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-disposition": `attachment; filename="${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "cache-control": "private, no-store",
      },
    });
  });

  app.post("/v1/need", async (c) => {
    const request = parseNeedBody(await readBody(c));
    const organizationId = await deps.optionalOrg(c.req.raw.headers);
    const { matches, best, bestRelevance } = await matchNeed(deps, request);
    const matched = matches.length > 0 && bestRelevance >= NEED_MATCH_THRESHOLD;
    let logged = false;
    if (!matched || bestRelevance < NEED_WEAK_THRESHOLD) {
      const entry = await deps.demand.record({
        need: request.need,
        bestScore: bestRelevance,
        bestListingName: best?.listing.name ?? null,
        budgetUsdc: request.budgetUsdc,
        kind: request.kinds.length > 0 ? request.kinds.join(",") : null,
        organizationId,
      });
      logged = entry !== null;
    }
    let bought: unknown = null;
    if (request.buy) {
      if (!organizationId) {
        throw new ServiceError(401, "unauthorized", "buy: true needs Authorization: Bearer <api key>.");
      }
      const top = matched ? matches[0] : undefined;
      if (!top) throw new ServiceError(404, "no_candidates", "Nothing on Roster matches this need yet. It was logged as demand.");
      bought = await buyListing(deps, organizationId, { listingId: top.listingId, input: request.input ?? top.inputExample, buyerAgentId: null });
    }
    return c.json({
      need: request.need,
      budgetUsdc: request.budgetUsdc,
      matched,
      matches,
      ...(matched ? {} : { unmet: { logged, message: "No good match yet. Roster logged this need so the team can build it." } }),
      ...(matched && logged ? { weak: true } : {}),
      ...(request.buy ? { bought } : {}),
    });
  });

  app.post("/v1/need/buy", async (c) => {
    const body = await readBody(c);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ServiceError(400, "invalid_request", "Send {\"listingId\": \"cap_…\", \"input\": {…}}.");
    }
    const record = body as Record<string, unknown>;
    if (typeof record.listingId !== "string" || !record.listingId.trim()) {
      throw new ServiceError(400, "invalid_request", "listingId is required.");
    }
    if (record.input !== undefined && (typeof record.input !== "object" || record.input === null || Array.isArray(record.input))) {
      throw new ServiceError(400, "invalid_request", "input must be an object.");
    }
    if (record.buyerAgentId !== undefined && typeof record.buyerAgentId !== "string") {
      throw new ServiceError(400, "invalid_request", "buyerAgentId must be a string.");
    }
    const result = await buyListing(deps, deps.orgOf(c), {
      listingId: record.listingId.trim(),
      input: (record.input as Record<string, unknown> | undefined) ?? null,
      buyerAgentId: typeof record.buyerAgentId === "string" ? record.buyerAgentId : null,
    });
    return c.json(result, 201);
  });
}

export function registerDataAdminRoutes<E extends Env>(app: Hono<E>, deps: { data: DataCatalog | null; demand: DemandLog }): void {
  app.get("/v1/admin/demand", async (c) => {
    const entries = await deps.demand.list(500);
    const totals = await deps.demand.total();
    return c.json({ totals, entries });
  });

  app.post("/v1/admin/demand/:id/dismiss", async (c) => {
    const removed = await deps.demand.dismiss(c.req.param("id"));
    if (!removed) throw new ServiceError(404, "not_found", "Unmet need not found.");
    return c.json({ dismissed: true });
  });

  app.get("/v1/admin/data", (c) => {
    const products = deps.data?.list() ?? [];
    return c.json({
      store: deps.data?.storeKind ?? null,
      products: products.map(({ sample: _sample, columns: _columns, sources, ...product }) => ({
        ...product,
        source: sources[0]?.name ?? null,
        license: sources[0]?.license ?? null,
      })),
    });
  });

  app.post("/v1/admin/data/:slug/refresh", async (c) => {
    const data = deps.data;
    if (!data?.spec(c.req.param("slug"))?.ingest) throw new ServiceError(404, "not_found", "No stored data product with that slug.");
    const meta = await data.refresh(c.req.param("slug"));
    const { sample: _sample, ...rest } = meta;
    return c.json({ meta: rest });
  });
}

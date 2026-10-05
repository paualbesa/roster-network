import {
  compareUsdc,
  formatUsdc,
  parseUsdc,
  quoteEscrowSettlement,
  SANDBOX_TREASURY_GRANT_USDC,
  SLA_TIMEOUT_REASON,
} from "@albesa/core";
import { projectPassport, type ReputationTotals } from "@albesa/reputation";
import { quoteRosterNetworkFee } from "@albesa/solana";
import { sandboxJobSchema, sandboxMarketplaceListings, sandboxReceiptListing } from "../jobs.js";
import type { SimWorld } from "./worlds.js";

const GRANT = parseUsdc(SANDBOX_TREASURY_GRANT_USDC);
const BUYER_PUBKEY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PROVIDER_PUBKEY = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const LOAD_BUYERS = 8;
const LOAD_PER_BUYER = 3;
const LOAD_AMOUNT = "0.25";

const totalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["total"],
  properties: { total: { type: "string", minLength: 1 } },
};

const rowsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: { rows: { type: "integer", minimum: 1 } },
};

const invoiceListing = {
  name: "Invoice extractor",
  description: "Extract structured fields from invoices and receipts.",
  inputSchema: { type: "object", properties: { documentUrl: { type: "string" } } },
  outputSchema: { type: "object", properties: { total: { type: "string" } } },
  pricing: { model: "per_call", amountUsdc: "0.02" },
  latency: { p95Ms: 400 },
  tags: ["invoice", "extract"],
};

const neighborListing = {
  ...invoiceListing,
  name: "Inventory notifier",
  description: "Notifies the team when inventory falls below a threshold.",
  tags: ["inventory", "notify"],
  pricing: { model: "per_call", amountUsdc: "0.001" },
  latency: { p95Ms: 40 },
};

export class SimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimError";
  }
}

export interface ScenarioResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

export interface ScenarioReport {
  world: string;
  results: ScenarioResult[];
}

interface OrgSession {
  id: string;
  name: string;
  auth: Record<string, string>;
}

interface JobView {
  id: string;
  status: string;
  organizationId: string;
  sellerOrganizationId: string;
  buyerAgentId: string;
  sellerAgentId: string;
  listingId: string;
  listingName: string;
  amountUsdc: string;
  takeRateUsdc: string;
  sellerNetUsdc: string;
  buyerBalanceUsdc: string;
  sellerBalanceUsdc: string;
  escrowId: string;
  validationErrors: string[] | null;
  passport: { agentId: string; scoreBefore: string; scoreAfter: string } | null;
}

interface PassportView {
  agentId: string;
  organizationId: string;
  score: string;
  updatedAt: string | null;
  metrics: {
    eventCount: number;
    successCount: number;
    failureCount: number;
    errorCount: number;
    hallucinationCount: number;
    latencyTotalMs: number;
    volumeSettledUsdc: string;
  };
}

interface RememberedAgent {
  auth: Record<string, string>;
  agentId: string;
  balanceUsdc: string | null;
  score: string;
  eventCount: number;
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

interface SearchHit {
  listing: { id: string; name: string; agentId: string | null };
}

class SimContext {
  readonly orgs: OrgSession[] = [];
  private grants = 0n;
  private readonly remembered: RememberedAgent[] = [];
  private readonly openingSum: Promise<string | null>;

  constructor(readonly world: SimWorld) {
    this.openingSum = world.walletSum();
  }

  noteGrant(micros: bigint = GRANT): void {
    this.grants += micros;
  }

  async organization(name: string): Promise<OrgSession> {
    const response = await this.request("/v1/organizations", {
      method: "POST",
      body: { name },
    });
    await expectStatus(response, 201, `create organization ${name}`);
    const body = (await response.json()) as { apiKey: string; organization: { id: string } };
    this.noteGrant();
    const org: OrgSession = {
      id: body.organization.id,
      name,
      auth: { authorization: `Bearer ${body.apiKey}`, "content-type": "application/json" },
    };
    this.orgs.push(org);
    return org;
  }

  async agent(org: OrgSession, name: string, dailySpendLimitUsdc = "1000.00"): Promise<string> {
    const response = await this.request("/v1/agents", {
      method: "POST",
      headers: org.auth,
      body: { name, dailySpendLimitUsdc, vendorAllowlist: [] },
    });
    await expectStatus(response, 201, `create agent ${name}`);
    return ((await response.json()) as { agent: { id: string } }).agent.id;
  }

  async fund(org: OrgSession, agentId: string, amountUsdc: string): Promise<void> {
    const response = await this.request(`/v1/agents/${agentId}/fund`, {
      method: "POST",
      headers: org.auth,
      body: { amountUsdc },
    });
    await expectStatus(response, 200, `fund ${agentId}`);
  }

  async balance(org: OrgSession, agentId: string): Promise<string> {
    const response = await this.request(`/v1/agents/${agentId}/balance`, { headers: org.auth });
    await expectStatus(response, 200, `balance ${agentId}`);
    return ((await response.json()) as { balanceUsdc: string }).balanceUsdc;
  }

  async passport(auth: Record<string, string>, agentId: string): Promise<PassportView> {
    const response = await this.request(`/v1/agents/${agentId}/passport`, { headers: auth });
    await expectStatus(response, 200, `passport ${agentId}`);
    return ((await response.json()) as { passport: PassportView }).passport;
  }

  async remember(auth: Record<string, string>, agentId: string, options?: { balance: boolean }): Promise<void> {
    const balanceUsdc = options?.balance === false ? null : await this.balanceOf(auth, agentId);
    const passport = await this.passport(auth, agentId);
    this.remembered.push({
      auth,
      agentId,
      balanceUsdc,
      score: passport.score,
      eventCount: passport.metrics.eventCount,
    });
  }

  async assertRemembered(): Promise<void> {
    for (const prior of this.remembered) {
      if (prior.balanceUsdc !== null) {
        const balanceUsdc = await this.balanceOf(prior.auth, prior.agentId);
        check(
          balanceUsdc === prior.balanceUsdc,
          `reload changed ${prior.agentId} balance from ${prior.balanceUsdc} to ${balanceUsdc}`,
        );
      }
      const passport = await this.passport(prior.auth, prior.agentId);
      check(passport.score === prior.score, `reload changed ${prior.agentId} score from ${prior.score} to ${passport.score}`);
      check(
        passport.metrics.eventCount === prior.eventCount,
        `reload changed ${prior.agentId} events from ${prior.eventCount.toString()} to ${passport.metrics.eventCount.toString()}`,
      );
    }
  }

  async assertConservation(): Promise<void> {
    const opening = await this.openingSum;
    if (opening !== null) {
      const actual = await this.world.walletSum();
      const expected = formatUsdc(parseUsdc(opening) + this.grants);
      check(
        actual !== null && compareUsdc(actual, expected) === 0,
        `sandbox balances ${actual ?? "missing"} != grants ${expected} (opening ${opening})`,
      );
    }
    await this.assertOwnedBooks();
  }

  request(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Response> {
    const headers = init.body === undefined ? init.headers : { "content-type": "application/json", ...init.headers };
    return this.world.request(path, {
      ...(init.method ? { method: init.method } : {}),
      ...(headers ? { headers } : {}),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }

  private async balanceOf(auth: Record<string, string>, agentId: string): Promise<string> {
    const response = await this.request(`/v1/agents/${agentId}/balance`, { headers: auth });
    await expectStatus(response, 200, `balance ${agentId}`);
    return ((await response.json()) as { balanceUsdc: string }).balanceUsdc;
  }

  private async assertOwnedBooks(): Promise<void> {
    const orgIds = new Set(this.orgs.map((org) => org.id));
    let owned = 0n;
    let fees = 0n;
    let holds = 0n;
    let external = 0n;
    for (const org of this.orgs) {
      const treasury = await this.request("/v1/treasury", { headers: org.auth });
      await expectStatus(treasury, 200, `treasury ${org.name}`);
      owned += parseUsdc(((await treasury.json()) as { balanceUsdc: string }).balanceUsdc);
      const agents = await this.request("/v1/agents", { headers: org.auth });
      await expectStatus(agents, 200, `agents ${org.name}`);
      for (const entry of ((await agents.json()) as { agents: { balanceUsdc: string }[] }).agents) {
        owned += parseUsdc(entry.balanceUsdc);
      }
      const listed = await this.request("/v1/jobs", { headers: org.auth });
      await expectStatus(listed, 200, `jobs ${org.name}`);
      for (const job of ((await listed.json()) as { jobs: JobView[] }).jobs) {
        if (job.organizationId !== org.id) continue;
        if (job.status === "released") {
          fees += parseUsdc(job.takeRateUsdc);
          if (!orgIds.has(job.sellerOrganizationId)) external += parseUsdc(job.sellerNetUsdc);
        } else if (job.status === "held") {
          holds += parseUsdc(job.amountUsdc);
        }
      }
    }
    const expected = GRANT * BigInt(this.orgs.length);
    const actual = owned + fees + holds + external;
    check(
      actual === expected,
      `owned books ${formatUsdc(actual)} != grants ${formatUsdc(expected)} (balances ${formatUsdc(owned)}, fees ${formatUsdc(fees)}, holds ${formatUsdc(holds)}, external ${formatUsdc(external)})`,
    );
  }
}

const SCENARIOS: { name: string; run: (ctx: SimContext) => Promise<void> }[] = [
  { name: "happy-path", run: happyPath },
  { name: "failed-delivery", run: failedDelivery },
  { name: "sla-timeout", run: slaTimeout },
  { name: "insufficient-balance", run: insufficientBalance },
  { name: "replay-settlement", run: replaySettlement },
  { name: "fleet-load", run: fleetLoad },
];

export async function runScenarios(world: SimWorld): Promise<ScenarioReport> {
  const ctx = new SimContext(world);
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) results.push(await runOne(scenario.name, () => scenario.run(ctx)));
  results.push(await runOne("conservation", () => ctx.assertConservation()));
  if (world.reload) {
    results.push(
      await runOne("reload", async () => {
        await world.reload?.();
        await ctx.assertConservation();
        await ctx.assertRemembered();
      }),
    );
  }
  return { world: world.name, results };
}

export function countReport(reports: readonly ScenarioReport[]): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const report of reports) {
    for (const result of report.results) {
      if (result.status === "pass") passed += 1;
      else if (result.status === "fail") failed += 1;
      else skipped += 1;
    }
  }
  return { passed, failed, skipped };
}

export function formatReport(report: ScenarioReport): string {
  const lines = [report.world];
  for (const result of report.results) {
    const detail = result.detail ? `  ${result.detail}` : "";
    lines.push(`  ${result.status.toUpperCase().padEnd(4, " ")}  ${result.name}${detail}`);
  }
  return lines.join("\n");
}

async function runOne(name: string, run: () => Promise<void>): Promise<ScenarioResult> {
  try {
    await run();
    return { name, status: "pass" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { name, status: "fail", detail };
  }
}

async function happyPath(ctx: SimContext): Promise<void> {
  const buyerOrg = await ctx.organization("Sim Buyer");
  const sellerOrg = await ctx.organization("Sim Seller");
  const buyerId = await ctx.agent(buyerOrg, "buyer");
  const sellerId = await ctx.agent(sellerOrg, "seller");
  await ctx.fund(buyerOrg, buyerId, "5.00");
  const listingId = await publish(ctx, sellerOrg, invoiceListing);
  const neighborId = await publish(ctx, sellerOrg, neighborListing);
  await bind(ctx, sellerOrg, listingId, sellerId);

  const query = encodeURIComponent("invioce extractr");
  const keyword = await ctx.request(`/v1/registry/search?q=${query}&semantic=0&limit=50`, { headers: buyerOrg.auth });
  await expectStatus(keyword, 200, "keyword search");
  const keywordIds = idsOf((await keyword.json()) as { hits: SearchHit[] });
  check(!keywordIds.includes(listingId), "typo query matched the invoice listing without semantic search");

  const semantic = await ctx.request(
    `/v1/registry/search?q=${query}&semantic=1&withReputation=1&limit=50`,
    { headers: buyerOrg.auth },
  );
  await expectStatus(semantic, 200, "semantic search");
  const hits = ((await semantic.json()) as { hits: SearchHit[] }).hits;
  check(hits.some((hit) => hit.listing.id === listingId), "semantic search did not discover the invoice extractor");
  check(!hits.some((hit) => hit.listing.id === neighborId), "semantic search ranked the inventory notifier as a match");
  const discovered = hits.find((hit) => hit.listing.id === listingId);
  check(discovered !== undefined, "discovered listing missing");

  const beforeSeller = await ctx.passport(buyerOrg.auth, sellerId);
  const beforeBuyer = await ctx.passport(sellerOrg.auth, buyerId);
  check(beforeSeller.metrics.eventCount === 0 && beforeBuyer.metrics.eventCount === 0, "passports were not empty before hire");

  const amount = "1.00";
  const quote = quoteEscrowSettlement(amount);
  const created = await ctx.request("/v1/jobs", {
    method: "POST",
    headers: buyerOrg.auth,
    body: {
      buyerAgentId: buyerId,
      query: "extract invoice total",
      amountUsdc: amount,
      schema: totalSchema,
      tags: ["invoice"],
      listingId: discovered.listing.id,
    },
  });
  await expectStatus(created, 201, "create job");
  const held = ((await created.json()) as { job: JobView }).job;
  check(held.status === "held", `job status ${held.status}`);
  check(held.listingId === listingId, "job did not hire the semantically discovered listing");
  check(held.sellerAgentId === sellerId, "job hired a different seller");
  check(held.takeRateUsdc === quote.takeRateUsdc, `take-rate ${held.takeRateUsdc} != ${quote.takeRateUsdc}`);
  check(held.sellerNetUsdc === quote.sellerNetUsdc, `seller net ${held.sellerNetUsdc} != ${quote.sellerNetUsdc}`);
  check(compareUsdc(held.buyerBalanceUsdc, "4.00") === 0, `buyer balance ${held.buyerBalanceUsdc} after lock`);
  check(compareUsdc(quote.takeRateUsdc, "0") > 0, "escrow take-rate was zero");

  const delivered = await deliver(ctx, sellerOrg.auth, held.id, { total: "12.50" });
  check(delivered.status === 200, `delivery status ${delivered.status.toString()}`);
  const released = delivered.job;
  check(released.status === "released", `delivery settled as ${released.status}`);
  check(compareUsdc(released.sellerBalanceUsdc, quote.sellerNetUsdc) === 0, `seller received ${released.sellerBalanceUsdc}`);
  check(compareUsdc(released.buyerBalanceUsdc, "4.00") === 0, `buyer balance moved to ${released.buyerBalanceUsdc}`);
  const jobPassport = released.passport;
  check(jobPassport?.agentId === sellerId, "job passport did not record the seller");
  check(jobPassport !== null, "job passport missing");
  check(jobPassport.scoreBefore === "0.0000", `seller score before ${jobPassport.scoreBefore}`);
  check(jobPassport.scoreAfter !== jobPassport.scoreBefore, "seller passport did not change");

  const network = await settleSolana(ctx, buyerOrg.auth, held, amount);
  check(network.quote.baseFeeUsdc === "0.003000", `Roster base fee ${network.quote.baseFeeUsdc}`);
  check(
    compareUsdc(network.quote.rosterFeeUsdc, held.takeRateUsdc) > 0,
    "Solana Roster fee did not include the 0.003 USDC base leg",
  );
  check(compareUsdc(await ctx.balance(sellerOrg, sellerId), quote.sellerNetUsdc) === 0, "solana settle moved mock USDC");

  const sellerPassport = await ctx.passport(buyerOrg.auth, sellerId);
  const buyerPassport = await ctx.passport(sellerOrg.auth, buyerId);
  check(sellerPassport.score === jobPassport.scoreAfter, "buyer could not read the updated seller passport");
  check(sellerPassport.metrics.successCount === 1, "seller success count");
  check(compareUsdc(sellerPassport.metrics.volumeSettledUsdc, amount) === 0, "seller volume is not the locked amount");
  check(buyerPassport.metrics.successCount === 1, "buyer passport did not record the hire");
  check(buyerPassport.metrics.failureCount === 0, "buyer passport recorded a failure");
  check(compareUsdc(buyerPassport.metrics.volumeSettledUsdc, "0") === 0, "buyer volume double-counted GMV");
  check(buyerPassport.score !== "0.0000", "buyer score stayed at zero");
  check(scoreMatches(sellerPassport), "seller score does not match roster.passport.v1");
  check(scoreMatches(buyerPassport), "buyer score does not match roster.passport.v1");
  await ctx.remember(sellerOrg.auth, sellerId);
  await ctx.remember(buyerOrg.auth, buyerId);
}

async function failedDelivery(ctx: SimContext): Promise<void> {
  const buyerOrg = await ctx.organization("Sim Refund Buyer");
  const sellerOrg = await ctx.organization("Sim Refund Seller");
  const buyerId = await ctx.agent(buyerOrg, "buyer");
  const sellerId = await ctx.agent(sellerOrg, "seller");
  await ctx.fund(buyerOrg, buyerId, "1.00");
  const listingId = await publish(ctx, sellerOrg, sandboxReceiptListing());
  await bind(ctx, sellerOrg, listingId, sellerId);
  const held = await lockJob(ctx, buyerOrg.auth, {
    buyerAgentId: buyerId,
    query: "parse receipts",
    amountUsdc: "1.00",
    schema: rowsSchema,
    tags: ["receipt"],
    listingId,
  });
  check(compareUsdc(held.buyerBalanceUsdc, "0") === 0, "lock did not escrow the buyer balance");
  const delivered = await deliver(ctx, sellerOrg.auth, held.id, { rows: 0 });
  check(delivered.status === 200, `failed delivery status ${delivered.status.toString()}`);
  check(delivered.job.status === "refunded", `status ${delivered.job.status}`);
  check((delivered.job.validationErrors ?? []).length > 0, "schema failure did not record validation errors");
  check(compareUsdc(delivered.job.buyerBalanceUsdc, "1.00") === 0, "buyer was not refunded in full");
  check(compareUsdc(delivered.job.sellerBalanceUsdc, "0") === 0, "seller was paid on a failed delivery");
  const sellerPassport = await ctx.passport(buyerOrg.auth, sellerId);
  const buyerPassport = await ctx.passport(sellerOrg.auth, buyerId);
  check(sellerPassport.metrics.failureCount === 1 && sellerPassport.metrics.successCount === 0, "seller failure was not recorded");
  check(compareUsdc(sellerPassport.metrics.volumeSettledUsdc, "0") === 0, "failed delivery increased settled volume");
  check(buyerPassport.metrics.eventCount === 0 && buyerPassport.score === "0.0000", "buyer passport changed on a failed delivery");
  check(scoreMatches(sellerPassport), "failure score does not match the formula");
  const replay = await deliver(ctx, sellerOrg.auth, held.id, { rows: 1 });
  check(replay.status === 409, `replay status ${replay.status.toString()}`);
  check(replay.errorCode === "invalid_state", `replay code ${replay.errorCode ?? "missing"}`);
  check(compareUsdc(await ctx.balance(buyerOrg, buyerId), "1.00") === 0, "replay moved the refunded balance");
  await ctx.remember(sellerOrg.auth, sellerId);
}

async function slaTimeout(ctx: SimContext): Promise<void> {
  const buyerOrg = await ctx.organization("Sim SLA Buyer");
  const sellerOrg = await ctx.organization("Sim SLA Seller");
  const buyerId = await ctx.agent(buyerOrg, "buyer");
  const sellerId = await ctx.agent(sellerOrg, "seller");
  await ctx.fund(buyerOrg, buyerId, "1.00");
  const listingId = await publish(ctx, sellerOrg, sandboxReceiptListing());
  await bind(ctx, sellerOrg, listingId, sellerId);
  const held = await lockJob(ctx, buyerOrg.auth, {
    buyerAgentId: buyerId,
    query: "parse receipts",
    amountUsdc: "1.00",
    schema: totalSchema,
    tags: ["receipt"],
    listingId,
  });
  check(held.slaMs === 400, `SLA window ${String(held.slaMs)}`);
  await ctx.world.advance(399);
  const early = await expire(ctx, buyerOrg.auth);
  check(early.length === 0, "job expired before the SLA deadline");
  await ctx.world.advance(1);
  const due = await expire(ctx, sellerOrg.auth);
  check(due.length === 1 && due[0]?.id === held.id, "SLA sweep did not refund the due job");
  const timedOut = due[0];
  check(timedOut?.status === "timed_out", `status ${timedOut?.status ?? "missing"}`);
  check(timedOut?.validationErrors?.[0] === SLA_TIMEOUT_REASON, "timeout reason missing");
  check(compareUsdc(timedOut?.buyerBalanceUsdc ?? "0", "1.00") === 0, "SLA refund was not the full principal");
  check(compareUsdc(timedOut?.sellerBalanceUsdc ?? "0", "0") === 0, "SLA timeout paid the seller");
  const sellerPassport = await ctx.passport(buyerOrg.auth, sellerId);
  const buyerPassport = await ctx.passport(sellerOrg.auth, buyerId);
  check(sellerPassport.metrics.failureCount === 1 && sellerPassport.metrics.successCount === 0, "timeout did not record a seller failure");
  check(compareUsdc(sellerPassport.metrics.volumeSettledUsdc, "0") === 0, "timeout collected reputation volume");
  check(buyerPassport.metrics.eventCount === 0, "buyer passport changed on timeout");
  const again = await expire(ctx, buyerOrg.auth);
  check(again.length === 0, "a second SLA sweep refunded the job again");
  const late = await deliver(ctx, sellerOrg.auth, held.id, { total: "12.50" });
  check(late.status === 409 && late.errorCode === "invalid_state", "late delivery was accepted after timeout");
  check(compareUsdc(await ctx.balance(buyerOrg, buyerId), "1.00") === 0, "late delivery moved the refund");
  await ctx.remember(buyerOrg.auth, buyerId);
}

async function insufficientBalance(ctx: SimContext): Promise<void> {
  const buyerOrg = await ctx.organization("Sim Poor Buyer");
  const sellerOrg = await ctx.organization("Sim Poor Seller");
  const buyerId = await ctx.agent(buyerOrg, "buyer");
  const sellerId = await ctx.agent(sellerOrg, "seller");
  await ctx.fund(buyerOrg, buyerId, "0.40");
  const listingId = await publish(ctx, sellerOrg, sandboxReceiptListing());
  await bind(ctx, sellerOrg, listingId, sellerId);
  const response = await ctx.request("/v1/jobs", {
    method: "POST",
    headers: buyerOrg.auth,
    body: {
      buyerAgentId: buyerId,
      query: "parse receipts",
      amountUsdc: "1.00",
      schema: totalSchema,
      tags: ["receipt"],
      listingId,
    },
  });
  const body = (await response.json()) as ErrorBody;
  check(response.status === 409, `insufficient lock status ${response.status.toString()}`);
  check(body.error?.code === "insufficient_balance", `code ${body.error?.code ?? "missing"}`);
  check(compareUsdc(await ctx.balance(buyerOrg, buyerId), "0.40") === 0, "rejected lock changed the buyer balance");
  const jobs = await ctx.request("/v1/jobs", { headers: buyerOrg.auth });
  await expectStatus(jobs, 200, "list jobs after rejected lock");
  check(((await jobs.json()) as { jobs: unknown[] }).jobs.length === 0, "rejected lock created a job");
  await ctx.remember(buyerOrg.auth, buyerId);
}

async function replaySettlement(ctx: SimContext): Promise<void> {
  const buyerOrg = await ctx.organization("Sim Replay Buyer");
  const sellerOrg = await ctx.organization("Sim Replay Seller");
  const buyerId = await ctx.agent(buyerOrg, "buyer");
  const sellerId = await ctx.agent(sellerOrg, "seller");
  await ctx.fund(buyerOrg, buyerId, "3.00");
  const listingId = await publish(ctx, sellerOrg, sandboxReceiptListing());
  await bind(ctx, sellerOrg, listingId, sellerId);
  const held = await lockJob(ctx, buyerOrg.auth, {
    buyerAgentId: buyerId,
    query: "parse receipts",
    amountUsdc: "1.00",
    schema: totalSchema,
    tags: ["receipt"],
    listingId,
  });
  const delivered = await deliver(ctx, sellerOrg.auth, held.id, { total: "12.50" });
  check(delivered.job.status === "released", "first delivery did not release");
  const first = await settleSolana(ctx, buyerOrg.auth, held, "1.00");
  const second = await settleSolana(ctx, buyerOrg.auth, held, "1.00");
  check(typeof first.signature === "string" && first.signature.length > 0, "settle signature missing");
  check(second.quote.rosterFeeUsdc === first.quote.rosterFeeUsdc, "replayed settle changed the Roster fee");
  check(second.signature === first.signature, "replayed settle produced a different sandbox signature");
  check(second.broadcast === false && first.broadcast === false, "sandbox settle broadcast a transaction");
  const sellerAfter = delivered.job.sellerBalanceUsdc;
  const buyerAfter = delivered.job.buyerBalanceUsdc;
  const events = (await ctx.passport(buyerOrg.auth, sellerId)).metrics.eventCount;
  const replay = await deliver(ctx, sellerOrg.auth, held.id, { total: "12.50" });
  check(replay.status === 409 && replay.errorCode === "invalid_state", "replayed delivery was accepted");
  check(compareUsdc(await ctx.balance(sellerOrg, sellerId), sellerAfter) === 0, "replayed delivery paid the seller again");
  check(compareUsdc(await ctx.balance(buyerOrg, buyerId), buyerAfter) === 0, "replayed delivery moved the buyer");
  check((await ctx.passport(buyerOrg.auth, sellerId)).metrics.eventCount === events, "replayed delivery wrote another passport event");

  const parallelHeld = await lockJob(ctx, buyerOrg.auth, {
    buyerAgentId: buyerId,
    query: "parse receipts",
    amountUsdc: "1.00",
    schema: totalSchema,
    tags: ["receipt"],
    listingId,
  });
  const buyerBeforeRace = await ctx.balance(buyerOrg, buyerId);
  const [left, right] = await Promise.all([
    deliver(ctx, sellerOrg.auth, parallelHeld.id, { total: "9.00" }),
    deliver(ctx, sellerOrg.auth, parallelHeld.id, { total: "9.00" }),
  ]);
  const statuses = [left.status, right.status].sort((a, b) => a - b);
  check(statuses[0] === 200 && statuses[1] === 409, `parallel delivery statuses ${statuses.join(",")}`);
  const released = left.status === 200 ? left.job : right.job;
  check(released.status === "released", "parallel delivery did not release once");
  check(
    compareUsdc(await ctx.balance(sellerOrg, sellerId), addUsdc(sellerAfter, released.sellerNetUsdc)) === 0,
    "parallel delivery double-paid the seller",
  );
  check(compareUsdc(await ctx.balance(buyerOrg, buyerId), buyerBeforeRace) === 0, "parallel delivery changed the buyer twice");
  await ctx.remember(sellerOrg.auth, sellerId);
  await ctx.remember(buyerOrg.auth, buyerId);
}

async function fleetLoad(ctx: SimContext): Promise<void> {
  const probe = await ctx.organization("Sim Fleet Probe");
  const fleet = await ctx.world.bootstrapFleet();
  if (fleet?.createdOrganization) ctx.noteGrant();
  const listings: FleetListing[] = fleet ? fleet.listings : await discoverFleet(ctx, probe.auth);
  check(listings.length >= 6, `first-party fleet published ${listings.length.toString()} listings`);
  const sellerAgentId = fleet?.sellerAgentId ?? listings.find((listing) => listing.agentId)?.agentId ?? null;
  check(sellerAgentId !== null, "fleet seller agent is not bound");
  const receipt = listings.find((listing) => listing.name === "Receipt parser");
  check(receipt !== undefined, "fleet is missing Receipt parser");
  const semantic = await ctx.request(
    `/v1/registry/search?q=${encodeURIComponent("reciept pars")}&semantic=1&limit=50`,
    { headers: probe.auth },
  );
  await expectStatus(semantic, 200, "fleet semantic search");
  check(
    idsOf((await semantic.json()) as { hits: SearchHit[] }).includes(receipt.id),
    "semantic search did not discover the fleet receipt parser",
  );

  const before = await ctx.passport(probe.auth, sellerAgentId);
  const buyers: { org: OrgSession; agentId: string }[] = [];
  for (let index = 0; index < LOAD_BUYERS; index += 1) {
    const org = await ctx.organization(`Sim Load ${index.toString()}`);
    const agentId = await ctx.agent(org, "buyer");
    await ctx.fund(org, agentId, "1.00");
    buyers.push({ org, agentId });
  }
  const quote = quoteEscrowSettlement(LOAD_AMOUNT);
  const tasks: Promise<JobView>[] = [];
  for (const buyer of buyers) {
    for (let index = 0; index < LOAD_PER_BUYER; index += 1) {
      const listing = listings[(buyers.indexOf(buyer) * LOAD_PER_BUYER + index) % listings.length];
      check(listing !== undefined, "fleet rotation missed a listing");
      tasks.push(
        lockJob(ctx, buyer.org.auth, {
          buyerAgentId: buyer.agentId,
          query: listing.name,
          amountUsdc: LOAD_AMOUNT,
          schema: sandboxJobSchema(listing.name),
          tags: [],
          listingId: listing.id,
        }).then(async (job) => {
          if (job.status === "held") return waitUntilSettled(ctx, buyer.org.auth, job.id);
          return job;
        }),
      );
    }
  }
  const jobs = await Promise.all(tasks);
  check(jobs.length === LOAD_BUYERS * LOAD_PER_BUYER, `load settled ${jobs.length.toString()} jobs`);
  const balances = jobs.map((job) => job.sellerBalanceUsdc).sort((left, right) => compareUsdc(left, right));
  for (const job of jobs) {
    check(job.status === "released", `${job.listingName} settled as ${job.status}`);
    check(job.sellerAgentId === sellerAgentId, "load job hired outside the fleet");
    check(job.takeRateUsdc === quote.takeRateUsdc, `${job.listingName} take-rate ${job.takeRateUsdc}`);
    check(job.sellerNetUsdc === quote.sellerNetUsdc, `${job.listingName} net ${job.sellerNetUsdc}`);
  }
  for (let index = 1; index < balances.length; index += 1) {
    const previous = balances[index - 1];
    const current = balances[index];
    check(previous !== undefined && current !== undefined, "missing fleet balance");
    check(
      compareUsdc(formatUsdc(parseUsdc(current) - parseUsdc(previous)), quote.sellerNetUsdc) === 0,
      `fleet seller balances did not step by ${quote.sellerNetUsdc}`,
    );
  }
  const after = await ctx.passport(probe.auth, sellerAgentId);
  const released = jobs.length;
  check(after.metrics.successCount === before.metrics.successCount + released, "fleet success count drifted");
  check(after.metrics.failureCount === before.metrics.failureCount, "fleet failure count drifted");
  check(
    compareUsdc(
      after.metrics.volumeSettledUsdc,
      formatUsdc(parseUsdc(before.metrics.volumeSettledUsdc) + parseUsdc(LOAD_AMOUNT) * BigInt(released)),
    ) === 0,
    "fleet settled volume drifted",
  );
  check(scoreMatches(after), "fleet passport score does not match its metrics");
  for (const buyer of buyers) {
    const passport = await ctx.passport(buyer.org.auth, buyer.agentId);
    check(passport.metrics.successCount === LOAD_PER_BUYER, "buyer success count did not match hired jobs");
    check(passport.metrics.failureCount === 0, "load buyer recorded a failure");
    check(compareUsdc(passport.metrics.volumeSettledUsdc, "0") === 0, "load buyer volume double-counted GMV");
    check(compareUsdc(await ctx.balance(buyer.org, buyer.agentId), "0.25") === 0, "buyer balance did not conserve the unspent fund");
    check(scoreMatches(passport), "buyer load score does not match its metrics");
  }
  await ctx.remember(probe.auth, sellerAgentId, { balance: false });
  const firstBuyer = buyers[0];
  if (firstBuyer) await ctx.remember(firstBuyer.org.auth, firstBuyer.agentId);
}

interface FleetListing {
  id: string;
  name: string;
  agentId?: string | null;
}

async function discoverFleet(ctx: SimContext, auth: Record<string, string>): Promise<FleetListing[]> {
  const response = await ctx.request("/v1/registry/listings", { headers: auth });
  await expectStatus(response, 200, "list fleet listings");
  const names = new Set(sandboxMarketplaceListings().map((listing) => listing.name));
  const listings = ((await response.json()) as { listings: { id: string; name: string; organizationId: string; agentId: string | null }[] }).listings.filter(
    (listing) => names.has(listing.name) && listing.agentId,
  );
  const counts = new Map<string, number>();
  for (const listing of listings) counts.set(listing.organizationId, (counts.get(listing.organizationId) ?? 0) + 1);
  let organizationId = "";
  let best = 0;
  for (const [id, count] of counts) {
    if (count > best) {
      organizationId = id;
      best = count;
    }
  }
  return listings.filter((listing) => listing.organizationId === organizationId);
}

async function publish(ctx: SimContext, org: OrgSession, body: unknown): Promise<string> {
  const response = await ctx.request("/v1/registry/listings", { method: "POST", headers: org.auth, body });
  await expectStatus(response, 201, "publish listing");
  return ((await response.json()) as { listing: { id: string } }).listing.id;
}

async function bind(ctx: SimContext, org: OrgSession, listingId: string, sellerAgentId: string): Promise<void> {
  const response = await ctx.request(`/v1/jobs/listings/${listingId}/seller`, {
    method: "PUT",
    headers: org.auth,
    body: { sellerAgentId },
  });
  await expectStatus(response, 200, "bind seller");
}

async function lockJob(
  ctx: SimContext,
  auth: Record<string, string>,
  body: Record<string, unknown>,
): Promise<JobView & { slaMs?: number | null }> {
  const response = await ctx.request("/v1/jobs", { method: "POST", headers: auth, body });
  await expectStatus(response, 201, "lock job");
  return ((await response.json()) as { job: JobView & { slaMs?: number | null } }).job;
}

async function deliver(
  ctx: SimContext,
  auth: Record<string, string>,
  jobId: string,
  result: unknown,
): Promise<{ status: number; job: JobView; errorCode?: string }> {
  const response = await ctx.request(`/v1/jobs/${jobId}/result`, {
    method: "POST",
    headers: auth,
    body: { result },
  });
  const payload = (await response.json()) as { job?: JobView } & ErrorBody;
  return {
    status: response.status,
    job: payload.job ?? emptyJob(),
    ...(payload.error?.code ? { errorCode: payload.error.code } : {}),
  };
}

async function expire(ctx: SimContext, auth: Record<string, string>): Promise<JobView[]> {
  const response = await ctx.request("/v1/jobs/expire", { method: "POST", headers: auth });
  await expectStatus(response, 200, "expire jobs");
  return ((await response.json()) as { jobs: JobView[] }).jobs;
}

async function waitUntilSettled(ctx: SimContext, auth: Record<string, string>, jobId: string): Promise<JobView> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await ctx.request(`/v1/jobs/${jobId}`, { headers: auth });
    await expectStatus(response, 200, `read job ${jobId}`);
    const job = ((await response.json()) as { job: JobView }).job;
    if (job.status !== "held") return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new SimError(`Job ${jobId} stayed held.`);
}

interface SolanaSettleView {
  broadcast: boolean;
  signature: string | null;
  cluster: string;
  quote: { rosterFeeUsdc: string; baseFeeUsdc: string; providerPayoutUsdc: string };
}

async function settleSolana(
  ctx: SimContext,
  auth: Record<string, string>,
  job: JobView,
  amountUsdc: string,
): Promise<SolanaSettleView> {
  const prepared = await ctx.request("/v1/escrow/prepare-lock", {
    method: "POST",
    headers: auth,
    body: {
      buyerPubkey: BUYER_PUBKEY,
      amountUsdc,
      escrowId: job.escrowId,
      jobId: job.id,
    },
  });
  await expectStatus(prepared, 201, "prepare lock");
  const lock = (await prepared.json()) as SolanaSettleView;
  check(lock.broadcast === false, "prepare-lock broadcast a transaction");
  check(lock.cluster === "mock", `refusing to settle on cluster ${lock.cluster}`);
  check(
    lock.quote.rosterFeeUsdc === quoteRosterNetworkFee(amountUsdc).rosterFeeUsdc,
    "prepare-lock fee did not match the Roster schedule",
  );
  const settled = await ctx.request("/v1/escrow/settle", {
    method: "POST",
    headers: auth,
    body: {
      escrowId: job.escrowId,
      buyerPubkey: BUYER_PUBKEY,
      providerPubkey: PROVIDER_PUBKEY,
      amountUsdc,
      jobId: job.id,
      verified: true,
    },
  });
  await expectStatus(settled, 200, "settle");
  const body = (await settled.json()) as SolanaSettleView;
  check(body.broadcast === false && body.cluster === "mock", "settle left the sandbox mock cluster");
  check(body.quote.rosterFeeUsdc === lock.quote.rosterFeeUsdc, "settle fee diverged from prepare-lock");
  return body;
}

function scoreMatches(passport: PassportView): boolean {
  const totals: ReputationTotals = {
    agentId: passport.agentId,
    organizationId: passport.organizationId,
    eventCount: passport.metrics.eventCount,
    successCount: passport.metrics.successCount,
    failureCount: passport.metrics.failureCount,
    errorCount: passport.metrics.errorCount,
    hallucinationCount: passport.metrics.hallucinationCount,
    latencyTotalMs: passport.metrics.latencyTotalMs,
    volumeSettledUsdc: passport.metrics.volumeSettledUsdc,
    updatedAt: passport.updatedAt,
  };
  if (totals.successCount + totals.failureCount !== totals.eventCount) return false;
  return projectPassport(totals).score === passport.score;
}

function idsOf(body: { hits: SearchHit[] }): string[] {
  return body.hits.map((hit) => hit.listing.id);
}

function addUsdc(left: string, right: string): string {
  return formatUsdc(parseUsdc(left) + parseUsdc(right));
}

function emptyJob(): JobView {
  return {
    id: "",
    status: "",
    organizationId: "",
    sellerOrganizationId: "",
    buyerAgentId: "",
    sellerAgentId: "",
    listingId: "",
    listingName: "",
    amountUsdc: "0",
    takeRateUsdc: "0",
    sellerNetUsdc: "0",
    buyerBalanceUsdc: "0",
    sellerBalanceUsdc: "0",
    escrowId: "",
    validationErrors: null,
    passport: null,
  };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SimError(message);
}

async function expectStatus(response: Response, status: number, label: string): Promise<void> {
  if (response.status === status) return;
  const detail = await response.text();
  throw new SimError(`${label} returned ${response.status.toString()}: ${detail.slice(0, 300)}`);
}

import { looksLikeSolanaSignature, solanaExplorerTxUrl } from "@albesa/solana";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createId, EscrowSchemaError, parseResultSchema, parseUsdc } from "@albesa/core";
import { CapabilityRegistry, type CapabilityListing } from "@albesa/registry";
import {
  isRosterFleetName,
  rosterFleetListings,
  sandboxComputeArbListing,
  sandboxDocQaListing,
  sandboxDocSummarizerListing,
  sandboxExecute,
  sandboxJobSchema,
  sandboxMarketplaceListings,
  sandboxReceiptListing,
  sandboxSellerBindRequests,
  sandboxStructuredExtractListing,
  sandboxUnitConverterListing,
} from "./catalog.js";
import {
  AgentFinanceService,
  ServiceError,
  type EscrowNotification,
} from "./service.js";

const FILE_VERSION = 1;
const MAX_QUERY = 500;
/** Same ceiling as the reputation ledger. Checked before escrow settles. */
const MAX_LATENCY_MS = 86_400_000;

/**
 * Sandbox mapping from a capability listing to the agent that receives escrow.
 * Listings belong to an organization and do not carry a wallet. The listing
 * owner binds one active agent in that same organization. A buyer in another
 * organization can still lock a job against that binding.
 */
export interface ListingSellerBinding {
  listingId: string;
  organizationId: string;
  sellerAgentId: string;
  createdAt: string;
  /**
   * Roster delivers for the seller: fleet fixture, data catalog, or seller proxy.
   * Set only by first-party bootstraps and by publishing an imported listing.
   */
  autofill: boolean;
}

export interface JobPassportChange {
  agentId: string;
  scoreBefore: string;
  scoreAfter: string;
}

/** `timed_out` is a refund: the listing SLA elapsed before a valid delivery. */
export type JobStatus = "held" | "released" | "refunded" | "timed_out";

export interface StoredJob {
  id: string;
  /** Buyer organization. This organization opened the job and funded escrow. */
  organizationId: string;
  /** Organization that published the listing and owns the seller agent. */
  sellerOrganizationId: string;
  buyerAgentId: string;
  sellerAgentId: string;
  listingId: string;
  listingName: string;
  query: string;
  tags: string[];
  maxP95Ms: number | null;
  amountUsdc: string;
  escrowId: string;
  rankScore: number;
  status: JobStatus;
  /** Listing p95 captured at lock. Null on jobs written before SLA deadlines existed. */
  slaMs: number | null;
  /** `createdAt + slaMs`. Null when the job has no SLA and cannot time out. */
  deadlineAt: string | null;
  result: unknown;
  validationErrors: string[] | null;
  latencyMs: number | null;
  passport: JobPassportChange | null;
  /** Buyer payload passed to `sandboxExecute`. Null when the lock omitted `input`. */
  input: unknown;
  createdAt: string;
  settledAt: string | null;
  /** Settlement rail chain id (optional on older job files). */
  chain?: string;
  lockProviderRef?: string;
  settlementProviderRef?: string | null;
}

export interface JobView {
  id: string;
  status: JobStatus;
  organizationId: string;
  sellerOrganizationId: string;
  buyerAgentId: string;
  sellerAgentId: string;
  listingId: string;
  listingName: string;
  query: string;
  tags: string[];
  maxP95Ms: number | null;
  amountUsdc: string;
  escrowId: string;
  rankScore: number;
  slaMs: number | null;
  deadlineAt: string | null;
  takeRateUsdc: string;
  sellerNetUsdc: string;
  holdAddress: string;
  chain: string;
  lockProviderRef: string;
  settlementProviderRef: string | null;
  /** Solana Explorer URL when settlement ref is a real Devnet signature. */
  settlementExplorerUrl: string | null;
  result: unknown;
  validationErrors: string[] | null;
  latencyMs: number | null;
  buyerBalanceUsdc: string;
  sellerBalanceUsdc: string;
  passport: JobPassportChange | null;
  createdAt: string;
  settledAt: string | null;
}

export interface CreateJobInput {
  buyerAgentId: string;
  query: string;
  amountUsdc: string;
  schema: unknown;
  tags: string[];
  maxP95Ms: number | null;
  memo: string | null;
  input: unknown;
  /** When set, lock this listing instead of the top search hit. */
  listingId: string | null;
}

export interface SubmitJobInput {
  result: unknown;
  latencyMs: number | null;
}

export interface CreateJobResult {
  job: JobView;
  notification: EscrowNotification;
}

export interface JobResult {
  job: JobView;
}

export interface JobStore {
  readJob(id: string): StoredJob | null;
  listJobs(organizationId: string): StoredJob[];
  /** Every job, buyer or seller. Copies, not live records. */
  listAllJobs(): StoredJob[];
  saveJob(job: StoredJob): void;
  readSeller(listingId: string): ListingSellerBinding | null;
  listSellerBindings(): ListingSellerBinding[];
  saveSeller(binding: ListingSellerBinding): void;
  removeSeller(listingId: string): void;
}

export class JobStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobStoreError";
  }
}

export type { SandboxCapabilityDraft, SandboxSellerBindRequest } from "./catalog.js";
export {
  isRosterFleetName,
  rosterFleetListings,
  sandboxComputeArbListing,
  sandboxDocQaListing,
  sandboxDocSummarizerListing,
  sandboxExecute,
  sandboxJobSchema,
  sandboxMarketplaceListings,
  sandboxReceiptListing,
  sandboxSellerBindRequests,
  sandboxStructuredExtractListing,
  sandboxUnitConverterListing,
};

export class MemoryJobStore implements JobStore {
  protected readonly jobs = new Map<string, StoredJob>();
  protected readonly sellers = new Map<string, ListingSellerBinding>();
  /** Set by the Supabase mirror. JSON writes do not use it. */
  onChange: (() => void) | null = null;

  readJob(id: string): StoredJob | null {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : null;
  }

  listJobs(organizationId: string): StoredJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.organizationId === organizationId || job.sellerOrganizationId === organizationId)
      .map((job) => cloneJob(job));
  }

  listAllJobs(): StoredJob[] {
    return [...this.jobs.values()].map((job) => cloneJob(job));
  }

  saveJob(job: StoredJob): void {
    this.jobs.set(job.id, cloneJob(job));
    this.onChange?.();
  }

  readSeller(listingId: string): ListingSellerBinding | null {
    const binding = this.sellers.get(listingId);
    return binding ? { ...binding } : null;
  }

  listSellerBindings(): ListingSellerBinding[] {
    return [...this.sellers.values()].map((binding) => ({ ...binding }));
  }

  saveSeller(binding: ListingSellerBinding): void {
    this.sellers.set(binding.listingId, { ...binding });
    this.onChange?.();
  }

  removeSeller(listingId: string): void {
    if (!this.sellers.delete(listingId)) return;
    this.onChange?.();
  }

  /** Hydrate from Postgres without marking the store dirty. */
  replaceAll(jobs: readonly StoredJob[], sellers: readonly ListingSellerBinding[]): void {
    this.jobs.clear();
    this.sellers.clear();
    for (const job of jobs) this.jobs.set(job.id, cloneJob(job));
    for (const seller of sellers) this.sellers.set(seller.listingId, { ...seller });
  }
}

interface JobFile {
  version: typeof FILE_VERSION;
  jobs: StoredJob[];
  sellers: ListingSellerBinding[];
}

/**
 * Sibling of the sandbox wallet file. Jobs and listing→seller bindings survive
 * a process restart. Writes are atomic (temp file, then rename).
 */
export class JsonJobStore extends MemoryJobStore {
  private constructor(private readonly filePath: string) {
    super();
  }

  static open(filePath: string): JsonJobStore {
    const trimmed = filePath.trim();
    if (!trimmed) throw new JobStoreError("Jobs data file path is required.");
    const store = new JsonJobStore(trimmed);
    store.load();
    return store;
  }

  override saveJob(job: StoredJob): void {
    super.saveJob(job);
    this.write();
  }

  override saveSeller(binding: ListingSellerBinding): void {
    super.saveSeller(binding);
    this.write();
  }

  override removeSeller(listingId: string): void {
    super.removeSeller(listingId);
    this.write();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unreadable";
      throw new JobStoreError(`Could not read jobs data file: ${message}`);
    }
    const document = parseDocument(parsed);
    for (const job of document.jobs) {
      if (this.jobs.has(job.id)) throw new JobStoreError(`Duplicate job id ${job.id}.`);
      this.jobs.set(job.id, job);
    }
    for (const binding of document.sellers) {
      if (this.sellers.has(binding.listingId)) {
        throw new JobStoreError(`Duplicate seller binding for ${binding.listingId}.`);
      }
      this.sellers.set(binding.listingId, binding);
    }
  }

  private write(): void {
    const document: JobFile = {
      version: FILE_VERSION,
      jobs: [...this.jobs.values()].map((job) => cloneJob(job)),
      sellers: [...this.sellers.values()].map((binding) => ({ ...binding })),
    };
    const json = `${JSON.stringify(document, null, 2)}\n`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid.toString()}.tmp`;
    writeFileSync(temporary, json, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

export interface AutofillConfig {
  /** `sync` settles inside the lock. `async` waits `delayMs` and still honors the SLA. */
  mode: "sync" | "async";
  delayMs: number;
}

/** Default wait before an async fleet delivery. Stays under the shortest catalog SLA (Compute arb, 60ms). */
export const DEFAULT_AUTOFILL_DELAY_MS = 50;

export function resolveAutofillConfig(
  override: { mode?: "sync" | "async"; delayMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): AutofillConfig {
  const mode = override.mode ?? (env.ROSTER_AUTOFULFILL?.trim().toLowerCase() === "sync" ? "sync" : "async");
  const delayMs = override.delayMs ?? readAutofillDelay(env.ROSTER_AUTOFULFILL_DELAY_MS);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_LATENCY_MS) {
    throw new Error(`autofillDelayMs must be an integer from 0 to ${MAX_LATENCY_MS.toString()}.`);
  }
  return { mode, delayMs };
}

function readAutofillDelay(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_AUTOFILL_DELAY_MS;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_LATENCY_MS) {
    throw new Error(
      `ROSTER_AUTOFULFILL_DELAY_MS must be an integer from 0 to ${MAX_LATENCY_MS.toString()}.`,
    );
  }
  return parsed;
}

export interface ExternalListingRef {
  id: string;
  name: string;
  organizationId: string;
}

/** Async delivery (Roster Data, seller proxy). A throw refunds the buyer through escrow. */
export interface ExternalFulfiller {
  handles(listing: ExternalListingRef): boolean;
  /** Resolve the result. A throw submits `{ error }`, which fails the schema and refunds the buyer. */
  fulfill(listing: ExternalListingRef, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface JobOrchestratorOptions {
  service: AgentFinanceService;
  registry: CapabilityRegistry;
  jobs: JobStore;
  now?: () => Date;
  autofill?: AutofillConfig;
  /** Used by bindings made with `autofill: true` that are not fleet fixtures. */
  externalFulfiller?: ExternalFulfiller;
}

/**
 * Discover → rank (reputation blend) → lock escrow → deliver → schema check →
 * release or refund → passport.
 * The listing p95 is the job SLA. When that deadline passes with no valid
 * delivery, the buyer is refunded in full, the job is `timed_out`, and the
 * seller passport records a failure. The take-rate is not collected.
 * The buyer may belong to a different organization than the seller. Escrow owns
 * validation and the 1% take-rate. Reputation is recorded on the seller agent.
 */
export class JobOrchestrator {
  private readonly service: AgentFinanceService;
  private readonly registry: CapabilityRegistry;
  private readonly jobs: JobStore;
  private readonly now: () => Date;
  private readonly autofill: AutofillConfig;
  private externalFulfiller: ExternalFulfiller | null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: JobOrchestratorOptions) {
    this.service = options.service;
    this.registry = options.registry;
    this.jobs = options.jobs;
    this.now = options.now ?? (() => new Date());
    this.autofill = options.autofill ?? resolveAutofillConfig();
    this.externalFulfiller = options.externalFulfiller ?? null;
  }

  /** Attach the async first-party fulfiller after construction (the data catalog boots later). */
  setExternalFulfiller(fulfiller: ExternalFulfiller | null): void {
    this.externalFulfiller = fulfiller;
  }

  private isExternal(listing: ExternalListingRef): boolean {
    return this.externalFulfiller?.handles(listing) === true;
  }

  bindSeller(
    organizationId: string,
    listingId: string,
    sellerAgentId: string,
    options?: { autofill?: boolean },
  ): Promise<ListingSellerBinding> {
    return this.enqueue(() => this.bindSellerUnlocked(organizationId, listingId, sellerAgentId, options));
  }

  createJob(organizationId: string, input: CreateJobInput): Promise<CreateJobResult> {
    return this.enqueue(() => this.createJobUnlocked(organizationId, input));
  }

  getJob(organizationId: string, jobId: string): Promise<JobResult> {
    return this.enqueue(async () => ({ job: await this.toView(this.requireJob(organizationId, jobId)) }));
  }

  listJobs(organizationId: string): Promise<{ jobs: JobView[] }> {
    return this.enqueue(async () => {
      const jobs = this.jobs
        .listJobs(organizationId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const views: JobView[] = [];
      for (const job of jobs) views.push(await this.toView(job));
      return { jobs: views };
    });
  }

  listAllJobs(): Promise<{ jobs: JobView[] }> {
    return this.enqueue(async () => {
      const jobs = this.jobs
        .listAllJobs()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
      const views: JobView[] = [];
      for (const job of jobs) views.push(await this.toView(job));
      return { jobs: views };
    });
  }

  /** Read one job without an organization membership check. */
  getAnyJob(jobId: string): Promise<JobResult> {
    return this.enqueue(async () => {
      const job = this.jobs.readJob(jobId);
      if (!job) throw new ServiceError(404, "not_found", "Job not found.");
      return { job: await this.toView(job) };
    });
  }

  listSellerBindings(): Promise<ListingSellerBinding[]> {
    return this.enqueue(async () => this.jobs.listSellerBindings());
  }

  /**
   * Refund every held job whose SLA deadline has passed, across organizations.
   * Jobs still inside the window stay locked. Already settled jobs are skipped.
   */
  expireAllDue(): Promise<{ jobs: JobView[] }> {
    return this.enqueue(async () => {
      const due = this.jobs
        .listAllJobs()
        .filter((job) => job.status === "held" && this.isPastDeadline(job))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      const views: JobView[] = [];
      for (const job of due) views.push(await this.settleTimeout(job));
      return { jobs: views };
    });
  }

  submitResult(organizationId: string, jobId: string, input: SubmitJobInput): Promise<JobResult> {
    return this.enqueue(() => this.submitResultUnlocked(organizationId, jobId, input));
  }

  /**
   * Refund every held job visible to this organization whose SLA deadline has passed.
   * Jobs that are still inside the window stay locked. Already settled jobs are skipped.
   */
  expireDue(organizationId: string): Promise<{ jobs: JobView[] }> {
    return this.enqueue(() => this.expireDueUnlocked(organizationId));
  }

  private async bindSellerUnlocked(
    organizationId: string,
    listingId: string,
    sellerAgentId: string,
    options?: { autofill?: boolean },
  ): Promise<ListingSellerBinding> {
    const listing = this.requireOwnedListing(organizationId, listingId);
    await this.service.getAgentBalance(organizationId, sellerAgentId);
    this.registry.update(organizationId, listing.id, { agentId: sellerAgentId });
    const binding: ListingSellerBinding = {
      listingId: listing.id,
      organizationId,
      sellerAgentId,
      createdAt: this.now().toISOString(),
      autofill: options?.autofill === true && (isSandboxFleetName(listing.name) || this.isExternal(listing)),
    };
    this.jobs.saveSeller(binding);
    return { ...binding };
  }

  private async createJobUnlocked(organizationId: string, input: CreateJobInput): Promise<CreateJobResult> {
    this.assertLockInput(input);
    const top = input.listingId ? this.pinnedListing(input.listingId) : await this.rankTop(input);
    if (!top) {
      throw new ServiceError(
        404,
        input.listingId ? "not_found" : "no_candidates",
        input.listingId ? "Capability listing not found." : "No capability listing matched the query.",
      );
    }
    const binding = this.jobs.readSeller(top.listing.id);
    if (!binding || binding.organizationId !== top.listing.organizationId) {
      throw new ServiceError(
        409,
        "seller_unbound",
        "The top candidate has no sandbox seller agent. The listing owner binds one with PUT /v1/jobs/listings/:id/seller before a buyer can open a job.",
      );
    }
    if (binding.sellerAgentId === input.buyerAgentId) {
      throw new ServiceError(400, "invalid_request", "Buyer and seller must be different agents.");
    }

    const locked = await this.service.createMarketplaceEscrow(organizationId, {
      buyerAgentId: input.buyerAgentId,
      sellerAgentId: binding.sellerAgentId,
      amountUsdc: input.amountUsdc,
      schema: input.schema,
      memo: input.memo ?? `Roster job ${top.listing.name}`,
    });
    const createdAt = this.now().toISOString();
    const slaMs = top.listing.latency.p95Ms;
    const job: StoredJob = {
      id: createId("job"),
      organizationId,
      sellerOrganizationId: binding.organizationId,
      buyerAgentId: locked.escrow.buyerAgentId,
      sellerAgentId: locked.escrow.sellerAgentId,
      listingId: top.listing.id,
      listingName: top.listing.name,
      query: input.query,
      tags: input.tags,
      maxP95Ms: input.maxP95Ms,
      amountUsdc: locked.escrow.amountUsdc,
      escrowId: locked.escrow.id,
      rankScore: top.score,
      status: "held",
      slaMs,
      deadlineAt: new Date(Date.parse(createdAt) + slaMs).toISOString(),
      result: null,
      validationErrors: null,
      latencyMs: null,
      passport: null,
      input: input.input,
      createdAt,
      settledAt: null,
      chain: locked.escrow.chain,
      lockProviderRef: locked.escrow.lockProviderRef,
      settlementProviderRef: null,
    };
    this.jobs.saveJob(job);
    await this.scheduleAutofill(job, binding);
    const current = this.jobs.readJob(job.id) ?? job;
    return { job: await this.toView(current), notification: locked.notification };
  }

  /**
   * Fleet listings deliver through `sandboxExecute`. Other bindings stay held
   * until the seller calls `POST /v1/jobs/:id/result`. A timer that fires after
   * `deadlineAt` uses the same SLA refund as `POST /v1/jobs/expire`.
   */
  private async scheduleAutofill(job: StoredJob, binding: ListingSellerBinding): Promise<void> {
    if (!binding.autofill) return;
    if (this.isExternal(externalRef(job))) {
      await this.scheduleExternal(job);
      return;
    }
    if (!isSandboxFleetName(job.listingName)) return;
    if (this.autofill.mode === "sync") {
      await this.deliverAutofill(job.id);
      return;
    }
    const jobId = job.id;
    const timer = setTimeout(() => {
      void this.enqueue(() => this.deliverAutofill(jobId)).catch((error: unknown) => {
        console.error(error);
      });
    }, this.autofill.delayMs);
    timer.unref();
  }

  /**
   * Sync mode resolves inside the lock (tests). Async mode resolves outside the
   * queue so a slow upstream never blocks other jobs, then enqueues the submit.
   */
  private async scheduleExternal(job: StoredJob): Promise<void> {
    const fulfiller = this.externalFulfiller;
    if (!fulfiller) return;
    const started = Date.now();
    const resolveResult = async (): Promise<unknown> => {
      try {
        const payload = typeof job.input === "object" && job.input !== null && !Array.isArray(job.input) ? (job.input as Record<string, unknown>) : {};
        return await fulfiller.fulfill(externalRef(job), payload);
      } catch (error) {
        return { error: error instanceof Error ? error.message.slice(0, 300) : "delivery failed" };
      }
    };
    if (this.autofill.mode === "sync") {
      const result = await resolveResult();
      await this.deliverExternal(job.id, result, Date.now() - started);
      return;
    }
    const jobId = job.id;
    void resolveResult().then((result) =>
      this.enqueue(() => this.deliverExternal(jobId, result, Date.now() - started)).catch((error: unknown) => {
        console.error(error);
      }),
    );
  }

  private async deliverExternal(jobId: string, result: unknown, elapsedMs: number): Promise<void> {
    const job = this.jobs.readJob(jobId);
    if (!job || job.status !== "held") return;
    const binding = this.jobs.readSeller(job.listingId);
    if (!binding?.autofill || binding.organizationId !== job.sellerOrganizationId) return;
    if (this.isPastDeadline(job)) {
      await this.settleTimeout(job);
      return;
    }
    const latencyMs = Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(elapsedMs)));
    await this.submitResultUnlocked(job.sellerOrganizationId, job.id, { result, latencyMs });
  }

  private async deliverAutofill(jobId: string): Promise<void> {
    const job = this.jobs.readJob(jobId);
    if (!job || job.status !== "held") return;
    const binding = this.jobs.readSeller(job.listingId);
    if (!binding?.autofill || binding.organizationId !== job.sellerOrganizationId) return;
    if (!isSandboxFleetName(job.listingName)) return;
    if (this.isPastDeadline(job)) {
      await this.settleTimeout(job);
      return;
    }
    const result = sandboxExecute(job.listingName, job.input ?? {});
    const latencyMs = this.autofill.mode === "sync" ? 0 : this.autofill.delayMs;
    await this.submitResultUnlocked(job.sellerOrganizationId, job.id, { result, latencyMs });
  }

  private async submitResultUnlocked(
    organizationId: string,
    jobId: string,
    input: SubmitJobInput,
  ): Promise<JobResult> {
    const job = this.requireJob(organizationId, jobId);
    if (organizationId !== job.sellerOrganizationId) {
      throw new ServiceError(403, "forbidden", "Only the seller organization can deliver a job result.");
    }
    if (job.status !== "held") {
      throw new ServiceError(409, "invalid_state", `Job is already ${job.status}.`);
    }
    if (this.isPastDeadline(job)) {
      return { job: await this.settleTimeout(job) };
    }
    const latencyMs = this.resolveLatency(job.listingId, input.latencyMs);
    const settled = await this.service.submitEscrowResult(job.organizationId, job.escrowId, input.result);
    const before = await this.service.getPassport(job.sellerAgentId);
    const released = settled.escrow.status === "released";
    const after = await this.service.recordEscrowCompletion({
      organizationId: job.sellerOrganizationId,
      agentId: job.sellerAgentId,
      outcome: released ? "success" : "failure",
      latencyMs,
      volumeUsdc: settled.escrow.amountUsdc,
      error: !released,
      escrowId: settled.escrow.id,
    });
    if (released) {
      // Buyer passport records the hire. Volume stays on the seller so GMV is not counted twice.
      await this.service.recordEscrowCompletion({
        organizationId: job.organizationId,
        agentId: job.buyerAgentId,
        outcome: "success",
        latencyMs,
        volumeUsdc: "0.000000",
        escrowId: settled.escrow.id,
      });
    }
    const next: StoredJob = {
      ...job,
      status: settled.escrow.status,
      result: settled.escrow.result,
      validationErrors: settled.escrow.validationErrors,
      latencyMs,
      passport: {
        agentId: job.sellerAgentId,
        scoreBefore: before.score,
        scoreAfter: after.score,
      },
      settledAt: settled.escrow.settledAt,
      chain: settled.escrow.chain,
      lockProviderRef: settled.escrow.lockProviderRef,
      settlementProviderRef: settled.escrow.settlementProviderRef,
    };
    this.jobs.saveJob(next);
    return { job: await this.toView(next) };
  }

  private async expireDueUnlocked(organizationId: string): Promise<{ jobs: JobView[] }> {
    const due = this.jobs
      .listJobs(organizationId)
      .filter((job) => job.status === "held" && this.isPastDeadline(job))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const views: JobView[] = [];
    for (const job of due) views.push(await this.settleTimeout(job));
    return { jobs: views };
  }

  private async settleTimeout(job: StoredJob): Promise<JobView> {
    const settled = await this.service.timeoutEscrow(job.organizationId, job.escrowId);
    const before = await this.service.getPassport(job.sellerAgentId);
    const latencyMs = job.slaMs ?? 0;
    const after = await this.service.recordEscrowCompletion({
      organizationId: job.sellerOrganizationId,
      agentId: job.sellerAgentId,
      outcome: "failure",
      latencyMs,
      volumeUsdc: settled.escrow.amountUsdc,
      error: true,
      escrowId: settled.escrow.id,
    });
    const next: StoredJob = {
      ...job,
      status: "timed_out",
      result: null,
      validationErrors: settled.escrow.validationErrors,
      latencyMs,
      passport: {
        agentId: job.sellerAgentId,
        scoreBefore: before.score,
        scoreAfter: after.score,
      },
      settledAt: settled.escrow.settledAt,
      chain: settled.escrow.chain,
      lockProviderRef: settled.escrow.lockProviderRef,
      settlementProviderRef: settled.escrow.settlementProviderRef,
    };
    this.jobs.saveJob(next);
    return this.toView(next);
  }

  private isPastDeadline(job: StoredJob): boolean {
    if (job.deadlineAt === null) return false;
    const deadline = Date.parse(job.deadlineAt);
    if (Number.isNaN(deadline)) return false;
    return this.now().getTime() >= deadline;
  }

  private resolveLatency(listingId: string, requested: number | null): number {
    const listing = this.registry.get(listingId);
    const latencyMs = requested ?? listing?.latency.p95Ms ?? 0;
    if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > MAX_LATENCY_MS) {
      throw new ServiceError(
        400,
        "invalid_request",
        `latencyMs must be an integer from 0 to ${MAX_LATENCY_MS.toString()}.`,
      );
    }
    return latencyMs;
  }

  private assertLockInput(input: CreateJobInput): void {
    try {
      const micros = parseUsdc(input.amountUsdc);
      if (micros <= 0n) throw new Error("non-positive");
    } catch {
      throw new ServiceError(400, "invalid_request", "amountUsdc must be greater than zero.");
    }
    try {
      parseResultSchema(input.schema);
    } catch (error) {
      if (error instanceof EscrowSchemaError) {
        throw new ServiceError(400, "invalid_schema", error.message);
      }
      throw error;
    }
  }

  private requireOwnedListing(organizationId: string, listingId: string): CapabilityListing {
    const listing = this.registry.get(listingId);
    if (!listing) throw new ServiceError(404, "not_found", "Capability listing not found.");
    if (listing.organizationId !== organizationId) {
      throw new ServiceError(403, "forbidden", "Listing belongs to another organization.");
    }
    return listing;
  }

  private pinnedListing(listingId: string): { listing: CapabilityListing; score: number } | null {
    const listing = this.registry.get(listingId);
    if (!listing || listing.status !== "active") return null;
    return { listing, score: 1 };
  }

  private async rankTop(input: CreateJobInput) {
    const scores = await this.service.observedPassportScores(this.registry.list());
    const hits = this.registry.search(
      {
        q: input.query,
        tags: input.tags,
        maxPriceUsdc: null,
        maxP95Ms: input.maxP95Ms,
        limit: 1,
        withReputation: true,
      },
      { scoresByListingId: scores },
    );
    return hits[0] ?? null;
  }

  private requireJob(organizationId: string, jobId: string): StoredJob {
    const job = this.jobs.readJob(jobId);
    if (!job || (job.organizationId !== organizationId && job.sellerOrganizationId !== organizationId)) {
      throw new ServiceError(404, "not_found", "Job not found.");
    }
    return job;
  }

  private async toView(job: StoredJob): Promise<JobView> {
    const live = await this.service.getEscrow(job.organizationId, job.escrowId);
    return {
      id: job.id,
      status: job.status,
      organizationId: job.organizationId,
      sellerOrganizationId: job.sellerOrganizationId,
      buyerAgentId: job.buyerAgentId,
      sellerAgentId: job.sellerAgentId,
      listingId: job.listingId,
      listingName: job.listingName,
      query: job.query,
      tags: job.tags.slice(),
      maxP95Ms: job.maxP95Ms,
      amountUsdc: job.amountUsdc,
      escrowId: job.escrowId,
      rankScore: job.rankScore,
      slaMs: job.slaMs,
      deadlineAt: job.deadlineAt,
      takeRateUsdc: live.escrow.takeRateUsdc,
      sellerNetUsdc: live.escrow.sellerNetUsdc,
      holdAddress: live.escrow.holdAddress,
      chain: live.escrow.chain,
      lockProviderRef: live.escrow.lockProviderRef,
      settlementProviderRef: live.escrow.settlementProviderRef,
      settlementExplorerUrl:
        looksLikeSolanaSignature(live.escrow.settlementProviderRef)
          ? solanaExplorerTxUrl(live.escrow.settlementProviderRef!, live.escrow.chain === "solana-devnet" ? "devnet" : "mock")
          : null,
      result: job.result,
      validationErrors: job.validationErrors ? job.validationErrors.slice() : null,
      latencyMs: job.latencyMs,
      buyerBalanceUsdc: live.buyerBalanceUsdc,
      sellerBalanceUsdc: live.sellerBalanceUsdc,
      passport: job.passport ? { ...job.passport } : null,
      createdAt: job.createdAt,
      settledAt: job.settledAt,
    };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function parseCreateJobBody(body: unknown): CreateJobInput {
  if (!isRecord(body)) throw new ServiceError(400, "invalid_request", "Expected a JSON object.");
  const buyerAgentId = body.buyerAgentId;
  const query = body.query;
  const amountUsdc = body.amountUsdc;
  if (
    typeof buyerAgentId !== "string" ||
    typeof query !== "string" ||
    typeof amountUsdc !== "string" ||
    !("schema" in body)
  ) {
    throw new ServiceError(
      400,
      "invalid_request",
      "buyerAgentId, query, amountUsdc, and schema are required.",
    );
  }
  const trimmedQuery = query.trim();
  if (!trimmedQuery) throw new ServiceError(400, "invalid_request", "query is required.");
  if (trimmedQuery.length > MAX_QUERY) {
    throw new ServiceError(400, "invalid_request", `query must be at most ${MAX_QUERY.toString()} characters.`);
  }
  const tags = readTags(body.tags);
  const maxP95Ms = readMaxP95(body.maxP95Ms);
  if (body.memo !== undefined && body.memo !== null && typeof body.memo !== "string") {
    throw new ServiceError(400, "invalid_request", "memo must be a string.");
  }
  let listingId: string | null = null;
  if (body.listingId !== undefined && body.listingId !== null) {
    if (typeof body.listingId !== "string" || body.listingId.trim() === "") {
      throw new ServiceError(400, "invalid_request", "listingId must be a non-empty string.");
    }
    listingId = body.listingId.trim();
  }
  return {
    buyerAgentId,
    query: trimmedQuery,
    amountUsdc,
    schema: body.schema,
    tags,
    maxP95Ms,
    memo: typeof body.memo === "string" ? body.memo : null,
    input: "input" in body ? body.input : null,
    listingId,
  };
}

export function parseJobResultBody(body: unknown): SubmitJobInput {
  if (!isRecord(body) || !("result" in body)) {
    throw new ServiceError(400, "invalid_request", "result is required.");
  }
  if (body.latencyMs !== undefined && body.latencyMs !== null) {
    if (typeof body.latencyMs !== "number" || !Number.isInteger(body.latencyMs)) {
      throw new ServiceError(400, "invalid_request", "latencyMs must be an integer number of milliseconds.");
    }
  }
  return {
    result: body.result,
    latencyMs: typeof body.latencyMs === "number" ? body.latencyMs : null,
  };
}

export function parseSellerBindingBody(body: unknown): string {
  if (!isRecord(body) || typeof body.sellerAgentId !== "string" || body.sellerAgentId.trim() === "") {
    throw new ServiceError(400, "invalid_request", "sellerAgentId is required.");
  }
  return body.sellerAgentId;
}

function readTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ServiceError(400, "invalid_request", "tags must be an array of strings.");
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string") throw new ServiceError(400, "invalid_request", "tags must be an array of strings.");
    tags.push(tag);
  }
  return tags;
}

function readMaxP95(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") {
    throw new ServiceError(400, "invalid_request", "maxP95Ms must be an integer number of milliseconds.");
  }
  return value;
}

function parseDocument(value: unknown): JobFile {
  if (!isRecord(value) || value.version !== FILE_VERSION) {
    throw new JobStoreError("Jobs data file must be version 1.");
  }
  if (!Array.isArray(value.jobs)) throw new JobStoreError("jobs must be an array.");
  if (!Array.isArray(value.sellers)) throw new JobStoreError("sellers must be an array.");
  return {
    version: FILE_VERSION,
    jobs: value.jobs.map((job, index) => parseStoredJob(job, index)),
    sellers: value.sellers.map((binding, index) => parseBinding(binding, index)),
  };
}

function parseStoredJob(value: unknown, index: number): StoredJob {
  if (!isRecord(value)) throw new JobStoreError(`jobs[${index.toString()}] must be an object.`);
  const status = value.status;
  if (status !== "held" && status !== "released" && status !== "refunded" && status !== "timed_out") {
    throw new JobStoreError(`jobs[${index.toString()}].status is invalid.`);
  }
  const rankScore = value.rankScore;
  if (typeof rankScore !== "number" || !Number.isFinite(rankScore)) {
    throw new JobStoreError(`jobs[${index.toString()}].rankScore must be a finite number.`);
  }
  return {
    id: readText(value.id, `jobs[${index.toString()}].id`),
    organizationId: readText(value.organizationId, `jobs[${index.toString()}].organizationId`),
    sellerOrganizationId: readSellerOrganizationId(value, index),
    buyerAgentId: readText(value.buyerAgentId, `jobs[${index.toString()}].buyerAgentId`),
    sellerAgentId: readText(value.sellerAgentId, `jobs[${index.toString()}].sellerAgentId`),
    listingId: readText(value.listingId, `jobs[${index.toString()}].listingId`),
    listingName: readText(value.listingName, `jobs[${index.toString()}].listingName`),
    query: readText(value.query, `jobs[${index.toString()}].query`),
    tags: readStringList(value.tags, `jobs[${index.toString()}].tags`),
    maxP95Ms: readNullableInt(value.maxP95Ms, `jobs[${index.toString()}].maxP95Ms`),
    amountUsdc: readText(value.amountUsdc, `jobs[${index.toString()}].amountUsdc`),
    escrowId: readText(value.escrowId, `jobs[${index.toString()}].escrowId`),
    rankScore,
    status,
    slaMs: readOptionalSla(value.slaMs, index),
    deadlineAt: readOptionalDeadline(value.deadlineAt, index),
    result: value.result === undefined ? null : value.result,
    validationErrors: readNullableStringList(value.validationErrors, `jobs[${index.toString()}].validationErrors`),
    latencyMs: readNullableInt(value.latencyMs, `jobs[${index.toString()}].latencyMs`),
    passport: parsePassport(value.passport, index),
    input: "input" in value ? value.input : null,
    createdAt: readText(value.createdAt, `jobs[${index.toString()}].createdAt`),
    settledAt: readNullableText(value.settledAt, `jobs[${index.toString()}].settledAt`),
  };
}

function readSellerOrganizationId(value: Record<string, unknown>, index: number): string {
  if (value.sellerOrganizationId === undefined) {
    return readText(value.organizationId, `jobs[${index.toString()}].organizationId`);
  }
  return readText(value.sellerOrganizationId, `jobs[${index.toString()}].sellerOrganizationId`);
}

function parseBinding(value: unknown, index: number): ListingSellerBinding {
  if (!isRecord(value)) throw new JobStoreError(`sellers[${index.toString()}] must be an object.`);
  return {
    listingId: readText(value.listingId, `sellers[${index.toString()}].listingId`),
    organizationId: readText(value.organizationId, `sellers[${index.toString()}].organizationId`),
    sellerAgentId: readText(value.sellerAgentId, `sellers[${index.toString()}].sellerAgentId`),
    createdAt: readText(value.createdAt, `sellers[${index.toString()}].createdAt`),
    autofill: value.autofill === true,
  };
}

function externalRef(job: StoredJob): ExternalListingRef {
  return { id: job.listingId, name: job.listingName, organizationId: job.sellerOrganizationId };
}

function isSandboxFleetName(name: string): boolean {
  return isRosterFleetName(name);
}

function parsePassport(value: unknown, index: number): JobPassportChange | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new JobStoreError(`jobs[${index.toString()}].passport must be an object.`);
  return {
    agentId: readText(value.agentId, `jobs[${index.toString()}].passport.agentId`),
    scoreBefore: readText(value.scoreBefore, `jobs[${index.toString()}].passport.scoreBefore`),
    scoreAfter: readText(value.scoreAfter, `jobs[${index.toString()}].passport.scoreAfter`),
  };
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new JobStoreError(`${label} must be a string.`);
  return value;
}

function readNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return readText(value, label);
}

function readOptionalSla(value: unknown, index: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new JobStoreError(`jobs[${index.toString()}].slaMs must be a positive integer or null.`);
  }
  return value;
}

function readOptionalDeadline(value: unknown, index: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new JobStoreError(`jobs[${index.toString()}].deadlineAt must be an ISO timestamp or null.`);
  }
  return value;
}

function readNullableInt(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new JobStoreError(`${label} must be an integer or null.`);
  }
  return value;
}

function readStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new JobStoreError(`${label} must be an array.`);
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new JobStoreError(`${label} must contain strings.`);
    items.push(entry);
  }
  return items;
}

function readNullableStringList(value: unknown, label: string): string[] | null {
  if (value === null) return null;
  return readStringList(value, label);
}

function cloneJob(job: StoredJob): StoredJob {
  return JSON.parse(JSON.stringify(job)) as StoredJob;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

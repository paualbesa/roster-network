import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createId, EscrowSchemaError, parseResultSchema, parseUsdc } from "@albesa/core";
import { CapabilityRegistry, type CapabilityListing } from "@albesa/registry";
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
}

export interface JobPassportChange {
  agentId: string;
  scoreBefore: string;
  scoreAfter: string;
}

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
  status: "held" | "released" | "refunded";
  result: unknown;
  validationErrors: string[] | null;
  latencyMs: number | null;
  passport: JobPassportChange | null;
  createdAt: string;
  settledAt: string | null;
}

export interface JobView {
  id: string;
  status: "held" | "released" | "refunded";
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
  takeRateUsdc: string;
  sellerNetUsdc: string;
  holdAddress: string;
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
  saveJob(job: StoredJob): void;
  readSeller(listingId: string): ListingSellerBinding | null;
  saveSeller(binding: ListingSellerBinding): void;
}

export class JobStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobStoreError";
  }
}

export type { SandboxCapabilityDraft, SandboxSellerBindRequest } from "./catalog.js";
export {
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

export class MemoryJobStore implements JobStore {
  protected readonly jobs = new Map<string, StoredJob>();
  protected readonly sellers = new Map<string, ListingSellerBinding>();

  readJob(id: string): StoredJob | null {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : null;
  }

  listJobs(organizationId: string): StoredJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.organizationId === organizationId || job.sellerOrganizationId === organizationId)
      .map((job) => cloneJob(job));
  }

  saveJob(job: StoredJob): void {
    this.jobs.set(job.id, cloneJob(job));
  }

  readSeller(listingId: string): ListingSellerBinding | null {
    const binding = this.sellers.get(listingId);
    return binding ? { ...binding } : null;
  }

  saveSeller(binding: ListingSellerBinding): void {
    this.sellers.set(binding.listingId, { ...binding });
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

export interface JobOrchestratorOptions {
  service: AgentFinanceService;
  registry: CapabilityRegistry;
  jobs: JobStore;
  now?: () => Date;
}

/**
 * Discover → rank (reputation blend) → lock escrow → deliver → schema check →
 * release or refund → passport.
 * The buyer may belong to a different organization than the seller. Escrow owns
 * validation and the 1% take-rate. Reputation is recorded on the seller agent.
 */
export class JobOrchestrator {
  private readonly service: AgentFinanceService;
  private readonly registry: CapabilityRegistry;
  private readonly jobs: JobStore;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: JobOrchestratorOptions) {
    this.service = options.service;
    this.registry = options.registry;
    this.jobs = options.jobs;
    this.now = options.now ?? (() => new Date());
  }

  bindSeller(organizationId: string, listingId: string, sellerAgentId: string): Promise<ListingSellerBinding> {
    return this.enqueue(() => this.bindSellerUnlocked(organizationId, listingId, sellerAgentId));
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

  submitResult(organizationId: string, jobId: string, input: SubmitJobInput): Promise<JobResult> {
    return this.enqueue(() => this.submitResultUnlocked(organizationId, jobId, input));
  }

  private async bindSellerUnlocked(
    organizationId: string,
    listingId: string,
    sellerAgentId: string,
  ): Promise<ListingSellerBinding> {
    const listing = this.requireOwnedListing(organizationId, listingId);
    await this.service.getAgentBalance(organizationId, sellerAgentId);
    this.registry.update(organizationId, listing.id, { agentId: sellerAgentId });
    const binding: ListingSellerBinding = {
      listingId: listing.id,
      organizationId,
      sellerAgentId,
      createdAt: this.now().toISOString(),
    };
    this.jobs.saveSeller(binding);
    return { ...binding };
  }

  private async createJobUnlocked(organizationId: string, input: CreateJobInput): Promise<CreateJobResult> {
    this.assertLockInput(input);
    const top = await this.rankTop(input);
    if (!top) {
      throw new ServiceError(404, "no_candidates", "No capability listing matched the query.");
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
      result: null,
      validationErrors: null,
      latencyMs: null,
      passport: null,
      createdAt,
      settledAt: null,
    };
    this.jobs.saveJob(job);
    return { job: await this.toView(job), notification: locked.notification };
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
    };
    this.jobs.saveJob(next);
    return { job: await this.toView(next) };
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
      takeRateUsdc: live.escrow.takeRateUsdc,
      sellerNetUsdc: live.escrow.sellerNetUsdc,
      holdAddress: live.escrow.holdAddress,
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
  return {
    buyerAgentId,
    query: trimmedQuery,
    amountUsdc,
    schema: body.schema,
    tags,
    maxP95Ms,
    memo: typeof body.memo === "string" ? body.memo : null,
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
  if (status !== "held" && status !== "released" && status !== "refunded") {
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
    result: value.result === undefined ? null : value.result,
    validationErrors: readNullableStringList(value.validationErrors, `jobs[${index.toString()}].validationErrors`),
    latencyMs: readNullableInt(value.latencyMs, `jobs[${index.toString()}].latencyMs`),
    passport: parsePassport(value.passport, index),
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
  };
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

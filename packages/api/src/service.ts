import {
  addUsdc,
  compareUsdc,
  createId,
  createSandboxApiKey,
  decideSettlement,
  decideSlaTimeout,
  EscrowSchemaError,
  EscrowTransitionError,
  evaluateSpend,
  formatUsdc,
  hashSandboxApiKey,
  isPersistentSandboxWallet,
  MockWalletProvider,
  parseResultSchema,
  parseUsdc,
  quoteEscrowSettlement,
  quoteSandboxFee,
  resolveEscrowMode,
  SANDBOX_MAX_ACTIVE_AGENTS,
  SANDBOX_TREASURY_GRANT_USDC,
  sumSpentTodayUsdc,
  WalletProviderError,
  type Agent,
  type Escrow,
  type EscrowMode,
  type LedgerDirection,
  type LedgerEntry,
  type Organization,
  type Policy,
  type RuntimeMode,
  type SchemaValidationHook,
  type Transaction,
  type UserAccount,
  type Wallet,
  type WalletProvider,
} from "@albesa/core";
import {
  applyReputationEvent,
  emptyReputationTotals,
  MemoryReputationLedger,
  normalizeReputationEvent,
  projectPassport,
  reputationEventFromEscrow,
  ReputationInputError,
  type EscrowCompletionSignal,
  type ReputationEventInput,
  type ReputationEventRecord,
  type ReputationHook,
  type ReputationLedger,
  type ReputationPassport,
} from "@albesa/reputation";
import { burnPasswordCheck, hashPassword, verifyPassword } from "./password.js";
import { buildEscrowCustody } from "./escrow-mode.js";
import {
  emptyKycProfile,
  KYC_UPGRADE_HINT,
  KYC_WINDOW_DAYS,
  limitForTier,
  resolveKycLimits,
  type KycAuditEntry,
  type KycDocumentRecord,
  type KycLimits,
  type KycProfile,
  type KycSubmission,
  type KycUsage,
} from "./kyc.js";
import { MemoryStore, type WaitlistEntry } from "./store.js";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502;

export class ServiceError extends Error {
  readonly status: ErrorStatus;
  readonly code: string;
  readonly transaction: Transaction | null;
  /** Extra machine-readable fields merged into the `error` object. */
  readonly details: Record<string, unknown> | null;

  constructor(
    status: ErrorStatus,
    code: string,
    message: string,
    transaction: Transaction | null = null,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
    this.transaction = transaction;
    this.details = details;
  }
}

export interface CreateOrganizationResult {
  organization: Organization;
  apiKey: string;
  treasury: {
    wallet: Wallet;
    balanceUsdc: string;
  };
}

export interface CreateAccountInput {
  email: string;
  password: string;
  /** Used as the organization name. Omit to derive it from the email. */
  displayName: string | null;
}

export interface CreateAccountResult {
  user: UserAccount;
  organization: Organization;
  apiKey: string;
  treasury: TreasuryResult;
}

export interface LoginAccountResult {
  user: UserAccount;
  apiKey: string;
  treasury: TreasuryResult;
}

export interface AccountView {
  user: UserAccount;
  treasury: TreasuryResult;
}

export interface CreateAgentInput {
  name: string;
  dailySpendLimitUsdc: string;
  vendorAllowlist: string[];
}

export interface CreateAgentResult {
  agent: Agent;
  wallet: Wallet;
  policy: Policy;
  balanceUsdc: string;
}

export interface FundResult {
  transaction: Transaction;
  balanceUsdc: string;
}

export interface PaymentInput {
  vendorId: string;
  amountUsdc: string;
  memo: string | null;
}

export interface PaymentResult {
  transaction: Transaction;
  balanceUsdc: string;
}

export interface BalanceResult {
  agentId: string;
  walletId: string;
  address: string;
  asset: "USDC";
  chain: Wallet["chain"];
  balanceUsdc: string;
}

export interface TreasuryResult {
  wallet: Wallet;
  balanceUsdc: string;
}

export interface CreateEscrowInput {
  buyerAgentId: string;
  sellerAgentId: string;
  amountUsdc: string;
  schema: unknown;
  memo: string | null;
}

export interface EscrowNotification {
  type: "escrow.held";
  escrowId: string;
  sellerAgentId: string;
  buyerAgentId: string;
  amountUsdc: string;
  notifiedAt: string;
}

export interface EscrowResult {
  escrow: Escrow;
  buyerBalanceUsdc: string;
  sellerBalanceUsdc: string;
}

export interface CreateEscrowResult extends EscrowResult {
  notification: EscrowNotification;
}

const NAME_MAX = 80;
const PASSWORD_MIN = 8;
const WAITLIST_MAX = 50_000;
const AUTH_USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSWORD_MAX = 128;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const VENDOR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface RecordReputationResult {
  event: ReputationEventRecord;
  passport: ReputationPassport;
}

/** One organization as the operator panel may show it. No password hash and no API key. */
export interface OperatorAccount {
  email: string | null;
  displayName: string | null;
  userId: string | null;
  userCreatedAt: string | null;
  organizationId: string;
  organizationName: string;
  organizationCreatedAt: string;
  treasuryBalanceUsdc: string;
  agentCount: number;
}

/** Agent name index for listings and reputation. No wallet secrets. */
export interface OperatorAgentRef {
  id: string;
  name: string;
  organizationId: string;
  status: Agent["status"];
  createdAt: string;
}

export interface OperatorDirectory {
  accounts: OperatorAccount[];
  agents: OperatorAgentRef[];
}

export interface OperatorReputationAgent {
  agentId: string;
  agentName: string;
  organizationId: string;
  organizationName: string;
  score: string;
  eventCount: number;
  successCount: number;
  failureCount: number;
  updatedAt: string | null;
}

export interface OperatorReputationFailure {
  id: string;
  agentId: string;
  agentName: string;
  organizationId: string;
  createdAt: string;
  latencyMs: number;
  error: boolean;
  hallucination: boolean;
  sourceRef: string | null;
}

export interface OperatorReputation {
  agents: OperatorReputationAgent[];
  recentFailures: OperatorReputationFailure[];
}

/** Listing fields the registry ranker needs in order to resolve a seller passport. */
export interface ListingReputationRef {
  id: string;
  organizationId: string;
  agentId: string | null;
}

export interface ServiceOptions {
  mode?: RuntimeMode;
  now?: () => Date;
  wallets?: WalletProvider;
  store?: MemoryStore;
  reputation?: ReputationLedger;
  schemaHook?: SchemaValidationHook;
  /** Escrow custody model. Omit it to read `ROSTER_ESCROW_MODE` (default `custodial-mock`). */
  escrowMode?: EscrowMode;
  /** KYC escrow-volume caps. Omit them to read `ROSTER_KYC_T0_LIMIT_USDC` / `ROSTER_KYC_T1_LIMIT_USDC`. */
  kycLimits?: KycLimits;
}

export interface KycView extends KycUsage {
  organizationId: string;
  submission: KycSubmission | null;
  document: { mimeType: string; sizeBytes: number; uploadedAt: string; deleted: boolean } | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  upgrade: string | null;
}

export interface KycQueueEntry extends KycView {
  organizationName: string;
  reviewedBy: string | null;
  updatedAt: string;
  documentPath: string | null;
}

export class AgentFinanceService implements ReputationHook {
  private readonly store: MemoryStore;
  private readonly wallets: WalletProvider;
  private readonly reputation: ReputationLedger;
  private readonly mode: RuntimeMode;
  private readonly now: () => Date;
  private readonly schemaHook: SchemaValidationHook | null;
  private readonly escrowModeValue: EscrowMode;
  private readonly kycLimitsValue: KycLimits;
  private queue: Promise<unknown> = Promise.resolve();
  /** Per-seller take-rate override in bps (founding sellers pay 0). Null keeps the default. */
  private takeRatePolicy: ((sellerOrganizationId: string) => number | null) | null = null;

  constructor(options: ServiceOptions = {}) {
    this.store = options.store ?? new MemoryStore();
    this.wallets = options.wallets ?? new MockWalletProvider();
    this.reputation = options.reputation ?? new MemoryReputationLedger();
    this.mode = options.mode ?? "sandbox";
    this.now = options.now ?? (() => new Date());
    this.schemaHook = options.schemaHook ?? null;
    this.escrowModeValue = options.escrowMode ?? resolveEscrowMode();
    this.kycLimitsValue = options.kycLimits ?? resolveKycLimits();
  }

  /** Escrow custody model reported by /health. */
  get escrowMode(): EscrowMode {
    return this.escrowModeValue;
  }

  get kycLimits(): KycLimits {
    return { ...this.kycLimitsValue };
  }

  getKyc(organizationId: string): Promise<KycView> {
    return this.enqueue(async () => {
      this.requireOrganization(organizationId);
      return this.kycView(organizationId);
    });
  }

  /** Throws when the organization cannot submit right now (already pending or approved). */
  assertKycSubmittable(organizationId: string): Promise<void> {
    return this.enqueue(async () => {
      this.requireOrganization(organizationId);
      this.assertKycOpen(organizationId);
    });
  }

  /**
   * Record a Tier 1 submission. The document is already in private storage.
   * Returns the previous document path (a rejected resubmission) so the caller can delete it.
   */
  submitKyc(
    organizationId: string,
    submission: Omit<KycSubmission, "submittedAt">,
    document: KycDocumentRecord,
  ): Promise<{ kyc: KycView; replacedDocumentPath: string | null }> {
    return this.enqueue(async () => {
      this.requireOrganization(organizationId);
      this.assertKycOpen(organizationId);
      const now = this.now().toISOString();
      const previous = this.store.kycProfiles.get(organizationId);
      const replaced = previous?.document && !previous.document.deletedAt ? previous.document.path : null;
      const profile: KycProfile = {
        organizationId,
        status: "pending",
        submission: { ...submission, submittedAt: now },
        document,
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
        tier: previous?.tier ?? 0,
        updatedAt: now,
      };
      this.store.kycProfiles.set(organizationId, profile);
      this.appendKycAudit(organizationId, "submitted", `org:${organizationId}`, null, now);
      this.commit();
      return { kyc: this.kycView(organizationId), replacedDocumentPath: replaced };
    });
  }

  listKycQueue(status: KycProfile["status"] | null): Promise<{ entries: KycQueueEntry[]; audit: KycAuditEntry[] }> {
    return this.enqueue(async () => {
      const entries = [...this.store.kycProfiles.values()]
        .filter((profile) => profile.status !== "none" && (status === null || profile.status === status))
        .sort((left, right) => {
          const rank = (value: KycProfile) => (value.status === "pending" ? 0 : 1);
          return rank(left) - rank(right) || right.updatedAt.localeCompare(left.updatedAt);
        })
        .map((profile) => ({
          ...this.kycView(profile.organizationId),
          organizationName: this.store.organizations.get(profile.organizationId)?.name ?? profile.organizationId,
          reviewedBy: profile.reviewedBy,
          updatedAt: profile.updatedAt,
          documentPath: profile.document && !profile.document.deletedAt ? profile.document.path : null,
        }));
      const audit = this.store.kycAudit.slice(-500).reverse().map((entry) => ({ ...entry }));
      return { entries, audit };
    });
  }

  /** Path of the live document for an operator preview. Logs the view in the audit trail. */
  openKycDocument(organizationId: string, reviewer: string): Promise<{ path: string; mimeType: string }> {
    return this.enqueue(async () => {
      const profile = this.store.kycProfiles.get(organizationId);
      if (!profile?.document || profile.document.deletedAt) {
        throw new ServiceError(404, "not_found", "No KYC document on file for this organization.");
      }
      this.appendKycAudit(organizationId, "document_viewed", `admin:${reviewer}`, null, this.now().toISOString());
      this.commit();
      return { path: profile.document.path, mimeType: profile.document.mimeType };
    });
  }

  reviewKyc(
    organizationId: string,
    decision: "approved" | "rejected",
    reviewer: string,
    reason: string | null,
  ): Promise<KycView> {
    return this.enqueue(async () => {
      const profile = this.store.kycProfiles.get(organizationId);
      if (!profile || profile.status !== "pending") {
        throw new ServiceError(409, "kyc_not_pending", "Only a pending KYC submission can be reviewed.");
      }
      if (decision === "rejected" && !reason) {
        throw new ServiceError(400, "invalid_request", "A rejection needs a reason the applicant can act on.");
      }
      const now = this.now().toISOString();
      profile.status = decision;
      profile.tier = decision === "approved" ? 1 : profile.tier;
      profile.reviewedAt = now;
      profile.reviewedBy = reviewer;
      profile.rejectionReason = decision === "rejected" ? reason : null;
      profile.updatedAt = now;
      this.appendKycAudit(organizationId, decision, `admin:${reviewer}`, reason, now);
      this.commit();
      return this.kycView(organizationId);
    });
  }

  /** Validate that the document may be deleted (review finished) and return its path. */
  kycDocumentForDeletion(organizationId: string): Promise<string> {
    return this.enqueue(async () => {
      const profile = this.store.kycProfiles.get(organizationId);
      if (!profile?.document || profile.document.deletedAt) {
        throw new ServiceError(404, "not_found", "No KYC document on file for this organization.");
      }
      if (profile.status === "pending") {
        throw new ServiceError(409, "kyc_review_pending", "Approve or reject the submission before deleting its document.");
      }
      return profile.document.path;
    });
  }

  markKycDocumentDeleted(organizationId: string, reviewer: string): Promise<KycView> {
    return this.enqueue(async () => {
      const profile = this.store.kycProfiles.get(organizationId);
      if (!profile?.document || profile.document.deletedAt) {
        throw new ServiceError(404, "not_found", "No KYC document on file for this organization.");
      }
      const now = this.now().toISOString();
      profile.document = { ...profile.document, deletedAt: now };
      profile.updatedAt = now;
      this.appendKycAudit(organizationId, "document_deleted", `admin:${reviewer}`, null, now);
      this.commit();
      return this.kycView(organizationId);
    });
  }

  authenticate(apiKey: string): string | null {
    return this.store.apiKeys.get(hashSandboxApiKey(apiKey)) ?? null;
  }

  /** Revoke one API key (logout). Other keys for the organization keep working. */
  revokeApiKey(apiKey: string): Promise<{ revoked: boolean }> {
    return this.enqueue(async () => {
      const revoked = this.store.apiKeys.delete(hashSandboxApiKey(apiKey));
      if (revoked) this.commit();
      return { revoked };
    });
  }

  /**
   * Developer waitlist. Re-submitting an email keeps the first entry and
   * returns `created: false`, so the landing form never leaks who signed up.
   */
  joinWaitlist(input: { email: string; source: string | null }): Promise<{ created: boolean }> {
    return this.enqueue(async () => {
      const email = canonicalEmail(input.email);
      if (!email) throw new ServiceError(400, "invalid_request", "email must be an address like ada@example.com.");
      const source = input.source?.trim().slice(0, 64) || null;
      if (this.store.waitlist.has(email)) return { created: false };
      if (this.store.waitlist.size >= WAITLIST_MAX) {
        throw new ServiceError(409, "waitlist_full", "The sandbox waitlist is full. Try again later.");
      }
      this.store.waitlist.set(email, { email, source, createdAt: this.now().toISOString() });
      this.commit();
      return { created: true };
    });
  }

  /** Operator view of the waitlist, newest first. */
  listWaitlist(): Promise<WaitlistEntry[]> {
    return this.enqueue(async () =>
      [...this.store.waitlist.values()]
        .map((entry) => ({ ...entry }))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.email.localeCompare(right.email)),
    );
  }

  createOrganization(name: string): Promise<CreateOrganizationResult> {
    return this.enqueue(() => this.createOrganizationUnlocked(name));
  }

  setTakeRatePolicy(policy: ((sellerOrganizationId: string) => number | null) | null): void {
    this.takeRatePolicy = policy;
  }

  listOrganizations(): Promise<Organization[]> {
    return this.enqueue(async () =>
      [...this.store.organizations.values()].map((organization) => ({ ...organization })),
    );
  }

  /**
   * Accounts, organizations, and agent names for the operator panel.
   * Password hashes and API keys stay in the store.
   */
  listOperatorDirectory(): Promise<OperatorDirectory> {
    return this.enqueue(async () => {
      const organizations = [...this.store.organizations.values()].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
      const accounts: OperatorAccount[] = [];
      for (const organization of organizations) {
        const user = this.userForOrganization(organization.id);
        const treasury = await this.readTreasury(organization.id);
        const agents = [...this.store.agents.values()].filter((agent) => agent.organizationId === organization.id);
        accounts.push({
          email: user?.email ?? null,
          displayName: user?.displayName ?? null,
          userId: user?.id ?? null,
          userCreatedAt: user?.createdAt ?? null,
          organizationId: organization.id,
          organizationName: organization.name,
          organizationCreatedAt: organization.createdAt,
          treasuryBalanceUsdc: treasury.balanceUsdc,
          agentCount: agents.length,
        });
      }
      const agents: OperatorAgentRef[] = [...this.store.agents.values()]
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          organizationId: agent.organizationId,
          status: agent.status,
          createdAt: agent.createdAt,
        }))
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      return { accounts, agents };
    });
  }

  /** Passport scores for agents that have events, plus the newest failures. */
  listOperatorReputation(): Promise<OperatorReputation> {
    return this.enqueue(async () => {
      const ranked: OperatorReputationAgent[] = [];
      for (const agent of this.store.agents.values()) {
        const totals = this.reputation.readTotals(agent.id);
        if (!totals || totals.eventCount === 0) continue;
        const passport = projectPassport(totals);
        const organization = this.store.organizations.get(agent.organizationId);
        ranked.push({
          agentId: agent.id,
          agentName: agent.name,
          organizationId: agent.organizationId,
          organizationName: organization?.name ?? agent.organizationId,
          score: passport.score,
          eventCount: passport.metrics.eventCount,
          successCount: passport.metrics.successCount,
          failureCount: passport.metrics.failureCount,
          updatedAt: passport.updatedAt,
        });
      }
      ranked.sort(
        (left, right) =>
          Number(right.score) - Number(left.score) ||
          right.failureCount - left.failureCount ||
          left.agentName.localeCompare(right.agentName),
      );
      const names = new Map([...this.store.agents.values()].map((agent) => [agent.id, agent.name]));
      const recentFailures: OperatorReputationFailure[] = this.reputation
        .listEvents()
        .filter((event) => event.outcome === "failure")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
        .slice(0, 25)
        .map((event) => ({
          id: event.id,
          agentId: event.agentId,
          agentName: names.get(event.agentId) ?? event.agentId,
          organizationId: event.organizationId,
          createdAt: event.createdAt,
          latencyMs: event.latencyMs,
          error: event.error,
          hallucination: event.hallucination,
          sourceRef: event.sourceRef,
        }));
      return { agents: ranked, recentFailures };
    });
  }

  listAgents(organizationId: string): Promise<Agent[]> {
    return this.enqueue(async () =>
      [...this.store.agents.values()]
        .filter((agent) => agent.organizationId === organizationId)
        .map((agent) => ({ ...agent })),
    );
  }

  async createAccount(input: CreateAccountInput): Promise<CreateAccountResult> {
    // Hash outside the queue so scrypt does not hold up other writers.
    const passwordHash =
      input.password.length >= PASSWORD_MIN && input.password.length <= PASSWORD_MAX
        ? await hashPassword(input.password)
        : "";
    return this.enqueue(() => this.createAccountUnlocked(input, passwordHash));
  }

  loginAccount(email: string, password: string): Promise<LoginAccountResult> {
    return this.enqueue(() => this.loginAccountUnlocked(email, password));
  }

  /**
   * Link a Supabase Auth user to a Roster organization and issue a sandbox API key.
   * Agents do not call this. Email/password accounts stay on `loginAccount`.
   */
  acceptAuthUser(input: {
    authUserId: string;
    email: string;
    displayName: string | null;
  }): Promise<LoginAccountResult> {
    return this.enqueue(() => this.acceptAuthUserUnlocked(input));
  }

  /** Organization for a Supabase user that already called `acceptAuthUser`. */
  authenticateAuthUser(authUserId: string): string | null {
    const userId = this.store.authUsersById.get(authUserId);
    if (!userId) return null;
    return this.store.users.get(userId)?.organizationId ?? null;
  }

  getAccount(organizationId: string): Promise<AccountView> {
    return this.enqueue(async () => {
      const user = this.userForOrganization(organizationId);
      if (!user) {
        throw new ServiceError(404, "not_found", "No Roster account is linked to this API key.");
      }
      return { user, treasury: await this.readTreasury(organizationId) };
    });
  }

  createAgent(organizationId: string, input: CreateAgentInput): Promise<CreateAgentResult> {
    return this.enqueue(() => this.createAgentUnlocked(organizationId, input));
  }

  listAgentDetails(organizationId: string): Promise<CreateAgentResult[]> {
    return this.enqueue(() => this.listAgentDetailsUnlocked(organizationId));
  }

  fundAgent(organizationId: string, agentId: string, amountUsdc: string): Promise<FundResult> {
    return this.enqueue(() => this.fundAgentUnlocked(organizationId, agentId, amountUsdc));
  }

  payAgent(organizationId: string, agentId: string, input: PaymentInput): Promise<PaymentResult> {
    return this.enqueue(() => this.payAgentUnlocked(organizationId, agentId, input));
  }

  getAgentBalance(organizationId: string, agentId: string): Promise<BalanceResult> {
    return this.enqueue(async () => {
      const agent = this.requireAgent(organizationId, agentId);
      const wallet = this.requireWallet(agent.walletId);
      return {
        agentId: agent.id,
        walletId: wallet.id,
        address: wallet.address,
        asset: "USDC",
        chain: wallet.chain,
        balanceUsdc: await this.wallets.getBalance(wallet.address),
      };
    });
  }

  getTreasury(organizationId: string): Promise<TreasuryResult> {
    return this.enqueue(() => this.readTreasury(organizationId));
  }

  listAgentTransactions(organizationId: string, agentId: string): Promise<Transaction[]> {
    return this.enqueue(async () => {
      this.requireAgent(organizationId, agentId);
      return this.store.transactions
        .filter((tx) => tx.organizationId === organizationId && tx.agentId === agentId)
        .slice()
        .reverse();
    });
  }

  recordReputationEvent(
    organizationId: string,
    agentId: string,
    input: ReputationEventInput,
  ): Promise<RecordReputationResult> {
    return this.enqueue(async () => this.recordReputationEventUnlocked(organizationId, agentId, input));
  }

  getPassport(agentId: string): Promise<ReputationPassport> {
    return this.enqueue(async () => {
      const totals = this.reputation.readTotals(agentId);
      if (totals) return projectPassport(totals);
      const agent = this.store.agents.get(agentId);
      if (!agent) throw this.notFound("Agent not found.");
      return emptyPassport(agent.id, agent.organizationId);
    });
  }

  assertOwnedAgent(organizationId: string, agentId: string): Promise<void> {
    return this.enqueue(async () => {
      const agent = this.store.agents.get(agentId);
      if (!agent || agent.organizationId !== organizationId) {
        throw new ServiceError(400, "invalid_request", "agentId must be an agent in this organization.");
      }
    });
  }

  /**
   * Observed passport scores for registry ranking, keyed by listing id.
   * A listing is omitted (neutral, not zero) when it has no resolvable seller,
   * the seller belongs to another organization, or that passport has no events.
   *
   * Seller resolution: `listing.agentId`, otherwise the organization's only agent.
   */
  observedPassportScores(listings: readonly ListingReputationRef[]): Promise<Map<string, number>> {
    return this.enqueue(async () => {
      const scores = new Map<string, number>();
      const soleAgentByOrg = new Map<string, string | null>();
      for (const listing of listings) {
        const agentId = listing.agentId ?? soleAgentId(this.store, listing.organizationId, soleAgentByOrg);
        if (!agentId) continue;
        const agent = this.store.agents.get(agentId);
        if (!agent || agent.organizationId !== listing.organizationId) continue;
        const totals = this.reputation.readTotals(agentId);
        if (!totals || totals.eventCount === 0 || totals.organizationId !== listing.organizationId) continue;
        const score = Number(projectPassport(totals).score);
        if (!Number.isFinite(score)) continue;
        scores.set(listing.id, clampPassportScore(score));
      }
      return scores;
    });
  }

  recordEscrowCompletion(signal: EscrowCompletionSignal): Promise<ReputationPassport> {
    return this.recordReputationEvent(
      signal.organizationId,
      signal.agentId,
      reputationEventFromEscrow(signal),
    ).then((result) => result.passport);
  }

  createEscrow(organizationId: string, input: CreateEscrowInput): Promise<CreateEscrowResult> {
    return this.enqueue(() => this.createEscrowUnlocked(organizationId, input, "organization"));
  }

  /**
   * Lock escrow from a buyer in this organization to a seller in any organization.
   * `POST /v1/escrows` stays inside one organization. Marketplace jobs use this
   * path so a buyer can pay a listed seller.
   */
  createMarketplaceEscrow(buyerOrganizationId: string, input: CreateEscrowInput): Promise<CreateEscrowResult> {
    return this.enqueue(() => this.createEscrowUnlocked(buyerOrganizationId, input, "marketplace"));
  }

  submitEscrowResult(organizationId: string, escrowId: string, result: unknown): Promise<EscrowResult> {
    return this.enqueue(() => this.submitEscrowResultUnlocked(organizationId, escrowId, result));
  }

  /**
   * Refund a held marketplace escrow because the listing SLA elapsed.
   * Uses the same full-principal refund as a schema failure and does not collect the take-rate.
   */
  timeoutEscrow(organizationId: string, escrowId: string): Promise<EscrowResult> {
    return this.enqueue(() => this.timeoutEscrowUnlocked(organizationId, escrowId));
  }

  getEscrow(organizationId: string, escrowId: string): Promise<EscrowResult> {
    return this.enqueue(() => this.escrowView(this.requireEscrow(organizationId, escrowId)));
  }

  listEscrows(organizationId: string): Promise<Escrow[]> {
    return this.enqueue(async () => {
      this.requireOrganization(organizationId);
      return [...this.store.escrows.values()]
        .filter((escrow) => escrow.organizationId === organizationId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    });
  }

  listLedger(organizationId: string, walletId: string): Promise<LedgerEntry[]> {
    return this.enqueue(async () => {
      const wallet = this.requireWallet(walletId);
      if (wallet.organizationId !== organizationId) throw this.notFound("Wallet not found.");
      return this.store.ledger.filter((entry) => entry.walletId === walletId).slice();
    });
  }

  private async createAccountUnlocked(input: CreateAccountInput, passwordHash: string): Promise<CreateAccountResult> {
    const email = canonicalEmail(input.email);
    if (!email) {
      throw new ServiceError(400, "invalid_request", "email must be an address like ada@example.com.");
    }
    if (input.password.length < PASSWORD_MIN || input.password.length > PASSWORD_MAX) {
      throw new ServiceError(
        400,
        "invalid_request",
        `password must be ${PASSWORD_MIN.toString()}-${PASSWORD_MAX.toString()} characters.`,
      );
    }
    if (this.store.usersByEmail.has(email)) {
      throw new ServiceError(409, "account_exists", "An account with this email already exists.");
    }
    const displayName = accountDisplayName(email, input.displayName);
    const created = await this.createOrganizationUnlocked(displayName);
    const user: UserAccount = {
      id: createId("usr"),
      email,
      displayName,
      organizationId: created.organization.id,
      createdAt: created.organization.createdAt,
    };
    this.store.users.set(user.id, user);
    this.store.usersByEmail.set(email, user.id);
    this.store.passwordHashes.set(user.id, passwordHash);
    this.commit();
    return {
      user,
      organization: created.organization,
      apiKey: created.apiKey,
      treasury: created.treasury,
    };
  }

  private async acceptAuthUserUnlocked(input: {
    authUserId: string;
    email: string;
    displayName: string | null;
  }): Promise<LoginAccountResult> {
    if (!AUTH_USER_ID_RE.test(input.authUserId)) {
      throw new ServiceError(400, "invalid_request", "Supabase user id must be a UUID.");
    }
    const email = canonicalEmail(input.email);
    if (!email) {
      throw new ServiceError(400, "invalid_request", "Supabase account has no usable email.");
    }
    const linkedUserId = this.store.authUsersById.get(input.authUserId);
    let user = linkedUserId ? this.store.users.get(linkedUserId) : undefined;
    if (!user) {
      const existingId = this.store.usersByEmail.get(email);
      const existing = existingId ? this.store.users.get(existingId) : undefined;
      if (existing) {
        const linkedAuth = authUserIdFor(this.store, existing.id);
        if (linkedAuth && linkedAuth !== input.authUserId) {
          throw new ServiceError(409, "account_exists", "This email is already linked to another sign-in.");
        }
        this.store.authUsersById.set(input.authUserId, existing.id);
        user = existing;
        this.commit();
      }
    }
    if (!user) {
      const provided = input.displayName?.trim() ?? "";
      const displayName = provided.length > NAME_MAX ? provided.slice(0, NAME_MAX) : provided;
      const created = await this.createOrganizationUnlocked(
        accountDisplayName(email, displayName.length > 0 ? displayName : null),
      );
      user = {
        id: createId("usr"),
        email,
        displayName: accountDisplayName(email, displayName.length > 0 ? displayName : null),
        organizationId: created.organization.id,
        createdAt: created.organization.createdAt,
      };
      this.store.users.set(user.id, user);
      this.store.usersByEmail.set(email, user.id);
      this.store.authUsersById.set(input.authUserId, user.id);
      this.commit();
      return { user, apiKey: created.apiKey, treasury: created.treasury };
    }
    const apiKey = createSandboxApiKey();
    this.store.apiKeys.set(hashSandboxApiKey(apiKey), user.organizationId);
    this.store.authUsersById.set(input.authUserId, user.id);
    this.commit();
    return { user, apiKey, treasury: await this.readTreasury(user.organizationId) };
  }

  private async loginAccountUnlocked(emailRaw: string, password: string): Promise<LoginAccountResult> {
    const email = canonicalEmail(emailRaw);
    const userId = email ? this.store.usersByEmail.get(email) : undefined;
    const user = userId ? this.store.users.get(userId) : undefined;
    const stored = user ? this.store.passwordHashes.get(user.id) : undefined;
    if (!user || !stored) {
      await burnPasswordCheck(password);
      throw new ServiceError(401, "unauthorized", "Email or password is incorrect.");
    }
    const check = await verifyPassword(stored, password);
    if (!check.ok) {
      throw new ServiceError(401, "unauthorized", "Email or password is incorrect.");
    }
    if (check.needsRehash) {
      // Upgrade legacy SHA-256 rows to scrypt on the first good login.
      this.store.passwordHashes.set(user.id, await hashPassword(password));
    }
    const apiKey = createSandboxApiKey();
    this.store.apiKeys.set(hashSandboxApiKey(apiKey), user.organizationId);
    this.commit();
    return {
      user,
      apiKey,
      treasury: await this.readTreasury(user.organizationId),
    };
  }

  private async createOrganizationUnlocked(name: string): Promise<CreateOrganizationResult> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > NAME_MAX) {
      throw new ServiceError(400, "invalid_request", `Organization name must be 1-${NAME_MAX.toString()} characters.`);
    }
    const createdAt = this.now().toISOString();
    const organizationId = createId("org");
    const minted = await this.wallets.createAddress(`treasury:${organizationId}`);
    const wallet: Wallet = {
      id: createId("wal"),
      organizationId,
      ownerType: "organization",
      ownerId: organizationId,
      address: minted.address,
      chain: this.wallets.chain,
      asset: "USDC",
      createdAt,
    };
    const organization: Organization = {
      id: organizationId,
      name: trimmed,
      treasuryWalletId: wallet.id,
      mode: this.mode,
      createdAt,
    };
    this.store.wallets.set(wallet.id, wallet);
    this.store.organizations.set(organization.id, organization);
    const apiKey = createSandboxApiKey();
    this.store.apiKeys.set(hashSandboxApiKey(apiKey), organization.id);

    if (this.mode === "sandbox") {
      await this.mintSandboxGrant(organization, wallet, createdAt);
    }
    this.commit();

    return {
      organization,
      apiKey,
      treasury: {
        wallet,
        balanceUsdc: await this.wallets.getBalance(wallet.address),
      },
    };
  }

  private async createAgentUnlocked(organizationId: string, input: CreateAgentInput): Promise<CreateAgentResult> {
    const organization = this.requireOrganization(organizationId);
    const name = input.name.trim();
    if (!name || name.length > NAME_MAX) {
      throw new ServiceError(400, "invalid_request", `Agent name must be 1-${NAME_MAX.toString()} characters.`);
    }
    let limitMicros: bigint;
    try {
      limitMicros = parseUsdc(input.dailySpendLimitUsdc);
    } catch {
      throw new ServiceError(400, "invalid_request", "dailySpendLimitUsdc must be a positive USDC amount.");
    }
    if (limitMicros <= 0n) {
      throw new ServiceError(400, "invalid_request", "dailySpendLimitUsdc must be greater than zero.");
    }
    if (!Array.isArray(input.vendorAllowlist) || input.vendorAllowlist.length > 50) {
      throw new ServiceError(400, "invalid_request", "vendorAllowlist must be an array of at most 50 vendor ids.");
    }
    const vendorAllowlist: string[] = [];
    for (const vendorId of input.vendorAllowlist) {
      if (typeof vendorId !== "string" || !VENDOR_RE.test(vendorId)) {
        throw new ServiceError(400, "invalid_request", `Invalid vendor id "${String(vendorId)}".`);
      }
      if (!vendorAllowlist.includes(vendorId)) vendorAllowlist.push(vendorId);
    }

    const activeAgents = [...this.store.agents.values()].filter(
      (agent) => agent.organizationId === organization.id && agent.status === "active",
    );
    if (this.mode === "sandbox" && activeAgents.length >= SANDBOX_MAX_ACTIVE_AGENTS) {
      throw new ServiceError(
        403,
        "agent_limit",
        `Sandbox plans can have up to ${SANDBOX_MAX_ACTIVE_AGENTS.toString()} active agents.`,
      );
    }

    const createdAt = this.now().toISOString();
    const agentId = createId("agt");
    const minted = await this.wallets.createAddress(`agent:${agentId}`);
    const wallet: Wallet = {
      id: createId("wal"),
      organizationId: organization.id,
      ownerType: "agent",
      ownerId: agentId,
      address: minted.address,
      chain: this.wallets.chain,
      asset: "USDC",
      createdAt,
    };
    const policy: Policy = {
      id: createId("pol"),
      organizationId: organization.id,
      agentId,
      dailySpendLimitUsdc: formatUsdc(parseUsdc(input.dailySpendLimitUsdc)),
      vendorAllowlist,
      createdAt,
    };
    const agent: Agent = {
      id: agentId,
      organizationId: organization.id,
      name,
      walletId: wallet.id,
      policyId: policy.id,
      status: "active",
      createdAt,
    };
    this.store.wallets.set(wallet.id, wallet);
    this.store.policies.set(policy.id, policy);
    this.store.agents.set(agent.id, agent);
    this.commit();
    return {
      agent,
      wallet,
      policy,
      balanceUsdc: await this.wallets.getBalance(wallet.address),
    };
  }

  private async listAgentDetailsUnlocked(organizationId: string): Promise<CreateAgentResult[]> {
    this.requireOrganization(organizationId);
    const agents = [...this.store.agents.values()]
      .filter((agent) => agent.organizationId === organizationId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const listed: CreateAgentResult[] = [];
    for (const agent of agents) {
      const wallet = this.requireWallet(agent.walletId);
      const policy = this.store.policies.get(agent.policyId);
      if (!policy || policy.agentId !== agent.id) throw this.notFound("Agent policy not found.");
      listed.push({
        agent,
        wallet,
        policy,
        balanceUsdc: await this.wallets.getBalance(wallet.address),
      });
    }
    return listed;
  }

  private async fundAgentUnlocked(organizationId: string, agentId: string, amountUsdc: string): Promise<FundResult> {
    const organization = this.requireOrganization(organizationId);
    const agent = this.requireAgent(organization.id, agentId);
    const canonical = this.parsePositiveAmount(amountUsdc);
    const treasury = this.requireWallet(organization.treasuryWalletId);
    const wallet = this.requireWallet(agent.walletId);
    const treasuryBalance = await this.wallets.getBalance(treasury.address);
    if (compareUsdc(treasuryBalance, canonical) < 0) {
      throw new ServiceError(409, "insufficient_balance", "Organization treasury does not have enough USDC.");
    }
    const createdAt = this.now().toISOString();
    const transactionId = createId("txn");
    const transfer = await this.wallets.transfer({
      fromAddress: treasury.address,
      toAddress: wallet.address,
      amountUsdc: canonical,
      idempotencyKey: transactionId,
    });
    const transaction: Transaction = {
      id: transactionId,
      organizationId: organization.id,
      agentId: agent.id,
      type: "fund",
      status: "settled",
      fromWalletId: treasury.id,
      toAddress: wallet.address,
      vendorId: null,
      amountUsdc: canonical,
      feeUsdc: "0.000000",
      rejectionReason: null,
      providerRef: transfer.providerRef,
      chain: transfer.chain,
      memo: "Treasury funding",
      createdAt,
    };
    await this.appendLedger({
      organizationId: organization.id,
      wallet: treasury,
      transactionId,
      direction: "debit",
      amountUsdc: canonical,
      memo: `Fund agent ${agent.id}`,
      createdAt,
    });
    await this.appendLedger({
      organizationId: organization.id,
      wallet,
      transactionId,
      direction: "credit",
      amountUsdc: canonical,
      memo: "Received from treasury",
      createdAt,
    });
    this.store.transactions.push(transaction);
    this.commit();
    return { transaction, balanceUsdc: await this.wallets.getBalance(wallet.address) };
  }

  private async payAgentUnlocked(
    organizationId: string,
    agentId: string,
    input: PaymentInput,
  ): Promise<PaymentResult> {
    const organization = this.requireOrganization(organizationId);
    const agent = this.requireAgent(organization.id, agentId);
    const policy = this.store.policies.get(agent.policyId);
    if (!policy) throw new ServiceError(404, "not_found", "Policy not found.");
    if (!VENDOR_RE.test(input.vendorId)) {
      throw new ServiceError(400, "invalid_request", "vendorId must be 1-64 letters, numbers, underscores, or hyphens.");
    }
    const memo = normalizeMemo(input.memo);
    const spentTodayUsdc = sumSpentTodayUsdc(this.store.transactions, agent.id, this.now());
    const decision = evaluateSpend({
      policy,
      amountUsdc: input.amountUsdc,
      vendorId: input.vendorId,
      spentTodayUsdc,
    });
    const wallet = this.requireWallet(agent.walletId);
    if (!decision.allowed) {
      const transaction = this.rejectPayment({
        organization,
        agent,
        wallet,
        vendorId: input.vendorId,
        amountUsdc: canonicalOrRaw(input.amountUsdc),
        reason: decision.reason ?? "invalid_amount",
        memo,
      });
      throw new ServiceError(403, transaction.rejectionReason ?? "invalid_amount", decision.message ?? "Payment blocked.", transaction);
    }

    const canonical = formatUsdc(parseUsdc(input.amountUsdc));
    const feeUsdc = quoteSandboxFee(canonical);
    const balanceUsdc = await this.wallets.getBalance(wallet.address);
    if (compareUsdc(balanceUsdc, addUsdc(canonical, feeUsdc)) < 0) {
      const transaction = this.rejectPayment({
        organization,
        agent,
        wallet,
        vendorId: input.vendorId,
        amountUsdc: canonical,
        reason: "insufficient_balance",
        memo,
        feeUsdc,
      });
      throw new ServiceError(409, "insufficient_balance", "Agent balance cannot cover the payment plus the sandbox fee.", transaction);
    }

    const createdAt = this.now().toISOString();
    const transactionId = createId("txn");
    const vendorAddress = `mock:vendor:${input.vendorId}`;
    const principal = await this.wallets.transfer({
      fromAddress: wallet.address,
      toAddress: vendorAddress,
      amountUsdc: canonical,
      idempotencyKey: `${transactionId}:principal`,
    });
    await this.appendLedger({
      organizationId: organization.id,
      wallet,
      transactionId,
      direction: "debit",
      amountUsdc: canonical,
      memo: `Payment to ${input.vendorId}`,
      createdAt,
    });
    await this.wallets.transfer({
      fromAddress: wallet.address,
      toAddress: `mock:fees:${organization.id}`,
      amountUsdc: feeUsdc,
      idempotencyKey: `${transactionId}:fee`,
    });
    await this.appendLedger({
      organizationId: organization.id,
      wallet,
      transactionId,
      direction: "debit",
      amountUsdc: feeUsdc,
      memo: "Sandbox fee (1% + 0.01 USDC)",
      createdAt,
    });
    const transaction: Transaction = {
      id: transactionId,
      organizationId: organization.id,
      agentId: agent.id,
      type: "payment",
      status: "settled",
      fromWalletId: wallet.id,
      toAddress: vendorAddress,
      vendorId: input.vendorId,
      amountUsdc: canonical,
      feeUsdc,
      rejectionReason: null,
      providerRef: principal.providerRef,
      chain: principal.chain,
      memo,
      createdAt,
    };
    this.store.transactions.push(transaction);
    this.commit();
    return { transaction, balanceUsdc: await this.wallets.getBalance(wallet.address) };
  }

  private async mintSandboxGrant(organization: Organization, wallet: Wallet, createdAt: string): Promise<void> {
    if (!isPersistentSandboxWallet(this.wallets)) {
      throw new ServiceError(
        403,
        "invalid_request",
        "Sandbox grants are only available on in-process sandbox wallet adapters.",
      );
    }
    await this.wallets.credit(wallet.address, SANDBOX_TREASURY_GRANT_USDC);
    const transaction: Transaction = {
      id: createId("txn"),
      organizationId: organization.id,
      agentId: null,
      type: "sandbox_grant",
      status: "settled",
      fromWalletId: null,
      toAddress: wallet.address,
      vendorId: null,
      amountUsdc: SANDBOX_TREASURY_GRANT_USDC,
      feeUsdc: "0.000000",
      rejectionReason: null,
      providerRef: null,
      chain: wallet.chain,
      memo: "Sandbox treasury grant (test funds)",
      createdAt,
    };
    await this.appendLedger({
      organizationId: organization.id,
      wallet,
      transactionId: transaction.id,
      direction: "credit",
      amountUsdc: SANDBOX_TREASURY_GRANT_USDC,
      memo: "Sandbox treasury grant",
      createdAt,
    });
    this.store.transactions.push(transaction);
  }

  private rejectPayment(input: {
    organization: Organization;
    agent: Agent;
    wallet: Wallet;
    vendorId: string;
    amountUsdc: string;
    reason: NonNullable<Transaction["rejectionReason"]>;
    memo: string | null;
    feeUsdc?: string;
  }): Transaction {
    const transaction: Transaction = {
      id: createId("txn"),
      organizationId: input.organization.id,
      agentId: input.agent.id,
      type: "payment",
      status: "rejected",
      fromWalletId: input.wallet.id,
      toAddress: `mock:vendor:${input.vendorId}`,
      vendorId: input.vendorId,
      amountUsdc: input.amountUsdc,
      feeUsdc: input.feeUsdc ?? "0.000000",
      rejectionReason: input.reason,
      providerRef: null,
      chain: input.wallet.chain,
      memo: input.memo,
      createdAt: this.now().toISOString(),
    };
    this.store.transactions.push(transaction);
    this.commit();
    return transaction;
  }

  private async appendLedger(input: {
    organizationId: string;
    wallet: Wallet;
    transactionId: string;
    direction: LedgerDirection;
    amountUsdc: string;
    memo: string;
    createdAt: string;
  }): Promise<void> {
    const entry: LedgerEntry = {
      id: createId("led"),
      organizationId: input.organizationId,
      walletId: input.wallet.id,
      transactionId: input.transactionId,
      direction: input.direction,
      amountUsdc: input.amountUsdc,
      balanceAfterUsdc: await this.wallets.getBalance(input.wallet.address),
      memo: input.memo,
      createdAt: input.createdAt,
    };
    this.store.ledger.push(entry);
  }

  private recordReputationEventUnlocked(
    organizationId: string,
    agentId: string,
    input: ReputationEventInput,
  ): RecordReputationResult {
    const agent = this.requireAgent(organizationId, agentId);
    let normalized;
    try {
      normalized = normalizeReputationEvent(input);
    } catch (error) {
      if (error instanceof ReputationInputError) {
        throw new ServiceError(400, "invalid_request", error.message);
      }
      throw error;
    }
    const createdAt = this.now().toISOString();
    const current = this.reputation.readTotals(agent.id) ?? emptyReputationTotals(agent.id, agent.organizationId);
    const next = applyReputationEvent(current, normalized, createdAt);
    const event: ReputationEventRecord = {
      id: createId("rev"),
      agentId: agent.id,
      organizationId: agent.organizationId,
      createdAt,
      ...normalized,
    };
    this.reputation.append(next, event);
    return { event, passport: projectPassport(next) };
  }

  private async createEscrowUnlocked(
    organizationId: string,
    input: CreateEscrowInput,
    counterparty: "organization" | "marketplace",
  ): Promise<CreateEscrowResult> {
    const organization = this.requireOrganization(organizationId);
    const canonical = this.parsePositiveAmount(input.amountUsdc);
    const schema = this.parseEscrowSchema(input.schema);
    const memo = normalizeMemo(input.memo);
    if (input.buyerAgentId === input.sellerAgentId) {
      throw new ServiceError(400, "invalid_request", "Buyer and seller must be different agents.");
    }
    const buyer = this.requireActiveAgent(organization.id, input.buyerAgentId);
    const seller =
      counterparty === "marketplace"
        ? this.requireActiveAgentAnywhere(input.sellerAgentId)
        : this.requireActiveAgent(organization.id, input.sellerAgentId);
    const overrideBps = this.takeRatePolicy?.(seller.organizationId) ?? null;
    const quote = overrideBps === null ? quoteEscrowSettlement(canonical) : quoteEscrowSettlement(canonical, overrideBps);
    const buyerWallet = this.requireWallet(buyer.walletId);
    const sellerWallet = this.requireWallet(seller.walletId);
    const buyerBalance = await this.wallets.getBalance(buyerWallet.address);
    if (compareUsdc(buyerBalance, canonical) < 0) {
      throw new ServiceError(409, "insufficient_balance", "Buyer balance cannot cover the escrow lock.");
    }
    this.assertKycAllows(organization.id, canonical);

    const createdAt = this.now().toISOString();
    const escrowId = createId("esc");
    const transactionId = createId("txn");
    const minted = await this.wallets.createAddress(`escrow:${escrowId}`);
    const transfer = await this.transferOrInsufficient({
      fromAddress: buyerWallet.address,
      toAddress: minted.address,
      amountUsdc: canonical,
      idempotencyKey: `${escrowId}:lock`,
    });
    const escrow: Escrow = {
      id: escrowId,
      organizationId: organization.id,
      buyerAgentId: buyer.id,
      sellerAgentId: seller.id,
      buyerWalletId: buyerWallet.id,
      sellerWalletId: sellerWallet.id,
      amountUsdc: canonical,
      takeRateBps: quote.takeRateBps,
      takeRateUsdc: quote.takeRateUsdc,
      sellerNetUsdc: quote.sellerNetUsdc,
      status: "held",
      schema,
      result: null,
      validationErrors: null,
      holdAddress: minted.address,
      chain: transfer.chain,
      asset: "USDC",
      lockProviderRef: transfer.providerRef,
      settlementProviderRef: null,
      feeProviderRef: null,
      memo,
      createdAt,
      notifiedAt: createdAt,
      settledAt: null,
      custody: buildEscrowCustody(this.escrowModeValue, {
        escrowId,
        buyerAddress: buyerWallet.address,
        sellerAddress: sellerWallet.address,
        amountUsdc: canonical,
        schema,
        signedAt: createdAt,
      }),
    };
    await this.appendLedger({
      organizationId: organization.id,
      wallet: buyerWallet,
      transactionId,
      direction: "debit",
      amountUsdc: canonical,
      memo: `Escrow hold ${escrowId}`,
      createdAt,
    });
    this.store.transactions.push({
      id: transactionId,
      organizationId: organization.id,
      agentId: buyer.id,
      type: "escrow_lock",
      status: "settled",
      fromWalletId: buyerWallet.id,
      toAddress: minted.address,
      vendorId: null,
      amountUsdc: canonical,
      feeUsdc: "0.000000",
      rejectionReason: null,
      providerRef: transfer.providerRef,
      chain: transfer.chain,
      memo: memo ?? `Lock escrow ${escrowId}`,
      escrowId,
      createdAt,
    });
    this.store.escrows.set(escrow.id, escrow);
    this.commit();
    const balances = await this.escrowBalances(escrow);
    return {
      escrow,
      notification: {
        type: "escrow.held",
        escrowId: escrow.id,
        sellerAgentId: seller.id,
        buyerAgentId: buyer.id,
        amountUsdc: canonical,
        notifiedAt: createdAt,
      },
      ...balances,
    };
  }

  private async submitEscrowResultUnlocked(
    organizationId: string,
    escrowId: string,
    result: unknown,
  ): Promise<EscrowResult> {
    const escrow = this.requireEscrow(organizationId, escrowId);
    let decision: ReturnType<typeof decideSettlement>;
    try {
      decision = this.schemaHook
        ? decideSettlement(escrow.status, escrow.schema, result, this.schemaHook)
        : decideSettlement(escrow.status, escrow.schema, result);
    } catch (error) {
      if (error instanceof EscrowTransitionError) {
        throw new ServiceError(409, "invalid_state", error.message);
      }
      throw error;
    }

    const settledAt = this.now().toISOString();
    const moved =
      decision.status === "released"
        ? await this.releaseEscrow(escrow, settledAt)
        : await this.refundEscrow(escrow, settledAt);
    const settled: Escrow = {
      ...escrow,
      status: decision.status,
      result,
      validationErrors: decision.validationErrors,
      settlementProviderRef: moved.settlementProviderRef,
      feeProviderRef: moved.feeProviderRef,
      settledAt,
    };
    this.store.escrows.set(escrow.id, settled);
    this.commit();
    return this.escrowView(settled);
  }

  private async timeoutEscrowUnlocked(organizationId: string, escrowId: string): Promise<EscrowResult> {
    const escrow = this.requireEscrow(organizationId, escrowId);
    let decision: ReturnType<typeof decideSlaTimeout>;
    try {
      decision = decideSlaTimeout(escrow.status);
    } catch (error) {
      if (error instanceof EscrowTransitionError) {
        throw new ServiceError(409, "invalid_state", error.message);
      }
      throw error;
    }
    const settledAt = this.now().toISOString();
    const moved = await this.refundEscrow(escrow, settledAt);
    const settled: Escrow = {
      ...escrow,
      status: decision.status,
      result: null,
      validationErrors: decision.validationErrors,
      settlementProviderRef: moved.settlementProviderRef,
      feeProviderRef: moved.feeProviderRef,
      settledAt,
    };
    this.store.escrows.set(escrow.id, settled);
    this.commit();
    return this.escrowView(settled);
  }

  private async releaseEscrow(
    escrow: Escrow,
    createdAt: string,
  ): Promise<{ settlementProviderRef: string; feeProviderRef: string | null }> {
    const gross = parseUsdc(escrow.amountUsdc);
    const take = parseUsdc(escrow.takeRateUsdc);
    const net = parseUsdc(escrow.sellerNetUsdc);
    if (take + net !== gross || take < 0n || net < 0n) {
      throw new Error("Escrow settlement amounts do not balance.");
    }
    const sellerWallet = this.requireWallet(escrow.sellerWalletId);
    const transactionId = createId("txn");
    let settlementProviderRef: string | null = null;
    let feeProviderRef: string | null = null;
    if (net > 0n) {
      const payout = await this.wallets.transfer({
        fromAddress: escrow.holdAddress,
        toAddress: sellerWallet.address,
        amountUsdc: escrow.sellerNetUsdc,
        idempotencyKey: `${escrow.id}:release`,
      });
      settlementProviderRef = payout.providerRef;
      await this.appendLedger({
        organizationId: sellerWallet.organizationId,
        wallet: sellerWallet,
        transactionId,
        direction: "credit",
        amountUsdc: escrow.sellerNetUsdc,
        memo: `Escrow release ${escrow.id}`,
        createdAt,
      });
    }
    if (take > 0n) {
      const fee = await this.wallets.transfer({
        fromAddress: escrow.holdAddress,
        toAddress: `mock:fees:${escrow.organizationId}`,
        amountUsdc: escrow.takeRateUsdc,
        idempotencyKey: `${escrow.id}:fee`,
      });
      feeProviderRef = fee.providerRef;
    }
    const providerRef = settlementProviderRef ?? feeProviderRef;
    if (!providerRef) {
      throw new Error("Escrow release did not move funds.");
    }
    this.store.transactions.push({
      id: transactionId,
      organizationId: sellerWallet.organizationId,
      agentId: escrow.sellerAgentId,
      type: "escrow_release",
      status: "settled",
      fromWalletId: null,
      toAddress: sellerWallet.address,
      vendorId: null,
      amountUsdc: escrow.sellerNetUsdc,
      feeUsdc: escrow.takeRateUsdc,
      rejectionReason: null,
      providerRef,
      chain: escrow.chain,
      memo: `Escrow ${escrow.id} released to seller`,
      escrowId: escrow.id,
      createdAt,
    });
    return { settlementProviderRef: providerRef, feeProviderRef };
  }

  private async refundEscrow(
    escrow: Escrow,
    createdAt: string,
  ): Promise<{ settlementProviderRef: string; feeProviderRef: null }> {
    const buyerWallet = this.requireWallet(escrow.buyerWalletId);
    const transactionId = createId("txn");
    const transfer = await this.wallets.transfer({
      fromAddress: escrow.holdAddress,
      toAddress: buyerWallet.address,
      amountUsdc: escrow.amountUsdc,
      idempotencyKey: `${escrow.id}:refund`,
    });
    await this.appendLedger({
      organizationId: escrow.organizationId,
      wallet: buyerWallet,
      transactionId,
      direction: "credit",
      amountUsdc: escrow.amountUsdc,
      memo: `Escrow refund ${escrow.id}`,
      createdAt,
    });
    this.store.transactions.push({
      id: transactionId,
      organizationId: escrow.organizationId,
      agentId: escrow.buyerAgentId,
      type: "escrow_refund",
      status: "settled",
      fromWalletId: null,
      toAddress: buyerWallet.address,
      vendorId: null,
      amountUsdc: escrow.amountUsdc,
      feeUsdc: "0.000000",
      rejectionReason: null,
      providerRef: transfer.providerRef,
      chain: transfer.chain,
      memo: `Escrow ${escrow.id} refunded to buyer`,
      escrowId: escrow.id,
      createdAt,
    });
    return { settlementProviderRef: transfer.providerRef, feeProviderRef: null };
  }

  private async escrowView(escrow: Escrow): Promise<EscrowResult> {
    const balances = await this.escrowBalances(escrow);
    return { escrow, ...balances };
  }

  private async escrowBalances(escrow: Escrow): Promise<{ buyerBalanceUsdc: string; sellerBalanceUsdc: string }> {
    const buyer = this.requireWallet(escrow.buyerWalletId);
    const seller = this.requireWallet(escrow.sellerWalletId);
    return {
      buyerBalanceUsdc: await this.wallets.getBalance(buyer.address),
      sellerBalanceUsdc: await this.wallets.getBalance(seller.address),
    };
  }

  private parseEscrowSchema(schema: unknown): Escrow["schema"] {
    try {
      return parseResultSchema(schema);
    } catch (error) {
      if (error instanceof EscrowSchemaError) {
        throw new ServiceError(400, "invalid_schema", error.message);
      }
      throw error;
    }
  }

  private async transferOrInsufficient(request: {
    fromAddress: string;
    toAddress: string;
    amountUsdc: string;
    idempotencyKey: string;
  }): Promise<{ providerRef: string; chain: Wallet["chain"] }> {
    try {
      return await this.wallets.transfer(request);
    } catch (error) {
      if (error instanceof WalletProviderError && error.message.includes("Insufficient balance")) {
        throw new ServiceError(409, "insufficient_balance", "Buyer balance cannot cover the escrow lock.");
      }
      throw error;
    }
  }

  private requireActiveAgent(organizationId: string, agentId: string): Agent {
    const agent = this.requireAgent(organizationId, agentId);
    return this.requireActive(agent);
  }

  private requireActiveAgentAnywhere(agentId: string): Agent {
    const agent = this.store.agents.get(agentId);
    if (!agent) throw this.notFound("Seller agent not found.");
    return this.requireActive(agent);
  }

  private requireActive(agent: Agent): Agent {
    if (agent.status !== "active") {
      throw new ServiceError(403, "agent_suspended", "Escrow requires an active agent.");
    }
    return agent;
  }

  private requireEscrow(organizationId: string, escrowId: string): Escrow {
    const escrow = this.store.escrows.get(escrowId);
    if (!escrow || escrow.organizationId !== organizationId) throw this.notFound("Escrow not found.");
    return escrow;
  }

  private async readTreasury(organizationId: string): Promise<TreasuryResult> {
    const organization = this.requireOrganization(organizationId);
    const wallet = this.requireWallet(organization.treasuryWalletId);
    return { wallet, balanceUsdc: await this.wallets.getBalance(wallet.address) };
  }

  private userForOrganization(organizationId: string): UserAccount | undefined {
    for (const user of this.store.users.values()) {
      if (user.organizationId === organizationId) return user;
    }
    return undefined;
  }

  private requireOrganization(organizationId: string): Organization {
    const organization = this.store.organizations.get(organizationId);
    if (!organization) throw this.notFound("Organization not found.");
    return organization;
  }

  private requireAgent(organizationId: string, agentId: string): Agent {
    const agent = this.store.agents.get(agentId);
    if (!agent || agent.organizationId !== organizationId) throw this.notFound("Agent not found.");
    return agent;
  }

  private requireWallet(walletId: string): Wallet {
    const wallet = this.store.wallets.get(walletId);
    if (!wallet) throw this.notFound("Wallet not found.");
    return wallet;
  }

  private parsePositiveAmount(amountUsdc: string): string {
    try {
      const micros = parseUsdc(amountUsdc);
      if (micros <= 0n) throw new Error("non-positive");
      return formatUsdc(parseUsdc(amountUsdc));
    } catch {
      throw new ServiceError(400, "invalid_request", "amountUsdc must be greater than zero.");
    }
  }

  private notFound(message: string): ServiceError {
    return new ServiceError(404, "not_found", message);
  }

  private assertKycOpen(organizationId: string): void {
    const profile = this.store.kycProfiles.get(organizationId);
    if (profile?.status === "pending") {
      throw new ServiceError(409, "kyc_pending", "A KYC submission is already waiting for review.");
    }
    if (profile?.status === "approved") {
      throw new ServiceError(409, "kyc_already_approved", "This organization is already verified at Tier 1.");
    }
  }

  private appendKycAudit(
    organizationId: string,
    action: KycAuditEntry["action"],
    actor: string,
    reason: string | null,
    at: string,
  ): void {
    this.store.kycAudit.push({ id: createId("kya"), organizationId, action, actor, reason, at });
  }

  private kycUsage(organizationId: string): KycUsage {
    const profile = this.store.kycProfiles.get(organizationId) ?? emptyKycProfile(organizationId, this.now().toISOString());
    const since = this.now().getTime() - KYC_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    let used = 0n;
    for (const escrow of this.store.escrows.values()) {
      if (escrow.organizationId !== organizationId || escrow.status === "refunded") continue;
      if (Date.parse(escrow.createdAt) < since) continue;
      used += parseUsdc(escrow.amountUsdc);
    }
    const limit = limitForTier(profile.tier, this.kycLimitsValue);
    const remaining = parseUsdc(limit) - used;
    return {
      tier: profile.tier,
      status: profile.status,
      windowDays: KYC_WINDOW_DAYS,
      usedUsdc: formatUsdc(used),
      limitUsdc: limit,
      remainingUsdc: formatUsdc(remaining > 0n ? remaining : 0n),
      limits: { ...this.kycLimitsValue },
    };
  }

  private kycView(organizationId: string): KycView {
    const profile = this.store.kycProfiles.get(organizationId) ?? emptyKycProfile(organizationId, this.now().toISOString());
    const usage = this.kycUsage(organizationId);
    return {
      organizationId,
      ...usage,
      submission: profile.submission ? { ...profile.submission } : null,
      document: profile.document
        ? {
            mimeType: profile.document.mimeType,
            sizeBytes: profile.document.sizeBytes,
            uploadedAt: profile.document.uploadedAt,
            deleted: profile.document.deletedAt !== null,
          }
        : null,
      reviewedAt: profile.reviewedAt,
      rejectionReason: profile.rejectionReason,
      upgrade: profile.tier === 0 && profile.status !== "pending" ? KYC_UPGRADE_HINT : null,
    };
  }

  private assertKycAllows(organizationId: string, amountUsdc: string): void {
    const usage = this.kycUsage(organizationId);
    const after = parseUsdc(usage.usedUsdc) + parseUsdc(amountUsdc);
    if (after <= parseUsdc(usage.limitUsdc)) return;
    const upgrade =
      usage.tier === 0
        ? {
            tier: 1,
            limitUsdc: usage.limits.tier1Usdc,
            status: usage.status,
            how:
              usage.status === "pending"
                ? "Your Tier 1 submission is pending manual review. The higher cap applies once an operator approves it."
                : KYC_UPGRADE_HINT,
            endpoint: "POST /v1/kyc/submission",
            console: "/console/kyc",
          }
        : null;
    throw new ServiceError(
      403,
      "kyc_limit_exceeded",
      `This lock would take escrow volume to ${formatUsdc(after)} USDC over the rolling ${KYC_WINDOW_DAYS.toString()} days; the Tier ${usage.tier.toString()} limit is ${usage.limitUsdc} USDC.`,
      null,
      {
        tier: usage.tier,
        kycStatus: usage.status,
        windowDays: usage.windowDays,
        usedUsdc: usage.usedUsdc,
        requestedUsdc: formatUsdc(parseUsdc(amountUsdc)),
        limitUsdc: usage.limitUsdc,
        remainingUsdc: usage.remainingUsdc,
        upgrade,
      },
    );
  }

  private commit(): void {
    this.store.commit(isPersistentSandboxWallet(this.wallets) ? this.wallets.exportState() : null);
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

function soleAgentId(
  store: MemoryStore,
  organizationId: string,
  cache: Map<string, string | null>,
): string | null {
  const cached = cache.get(organizationId);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  for (const agent of store.agents.values()) {
    if (agent.organizationId !== organizationId) continue;
    if (found !== null) {
      cache.set(organizationId, null);
      return null;
    }
    found = agent.id;
  }
  cache.set(organizationId, found);
  return found;
}

function clampPassportScore(score: number): number {
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

function emptyPassport(agentId: string, organizationId: string): ReputationPassport {
  return projectPassport(emptyReputationTotals(agentId, organizationId));
}

function canonicalOrRaw(amountUsdc: string): string {
  try {
    return formatUsdc(parseUsdc(amountUsdc));
  } catch {
    return amountUsdc;
  }
}

function authUserIdFor(store: MemoryStore, userId: string): string | null {
  for (const [authUserId, linkedUserId] of store.authUsersById) {
    if (linkedUserId === userId) return authUserId;
  }
  return null;
}

function canonicalEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

function accountDisplayName(email: string, displayName: string | null): string {
  const provided = displayName?.trim() ?? "";
  if (displayName !== null && provided.length === 0) {
    throw new ServiceError(400, "invalid_request", `name must be 1-${NAME_MAX.toString()} characters.`);
  }
  const name = provided.length > 0 ? provided : (email.split("@")[0] ?? "account");
  if (name.length === 0 || name.length > NAME_MAX) {
    throw new ServiceError(400, "invalid_request", `name must be 1-${NAME_MAX.toString()} characters.`);
  }
  return name;
}

function normalizeMemo(memo: string | null): string | null {
  if (memo === null) return null;
  const trimmed = memo.trim();
  if (!trimmed) return null;
  if (trimmed.length > 140) {
    throw new ServiceError(400, "invalid_request", "memo must be at most 140 characters.");
  }
  return trimmed;
}

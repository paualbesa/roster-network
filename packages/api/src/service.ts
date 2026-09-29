import {
  addUsdc,
  compareUsdc,
  createId,
  createSandboxApiKey,
  decideSettlement,
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
  SANDBOX_MAX_ACTIVE_AGENTS,
  SANDBOX_TREASURY_GRANT_USDC,
  sumSpentTodayUsdc,
  WalletProviderError,
  type Agent,
  type Escrow,
  type LedgerDirection,
  type LedgerEntry,
  type Organization,
  type Policy,
  type RuntimeMode,
  type SchemaValidationHook,
  type Transaction,
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
import { MemoryStore } from "./store.js";

export type ErrorStatus = 400 | 403 | 404 | 409;

export class ServiceError extends Error {
  readonly status: ErrorStatus;
  readonly code: string;
  readonly transaction: Transaction | null;

  constructor(status: ErrorStatus, code: string, message: string, transaction: Transaction | null = null) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
    this.transaction = transaction;
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
const VENDOR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface RecordReputationResult {
  event: ReputationEventRecord;
  passport: ReputationPassport;
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
}

export class AgentFinanceService implements ReputationHook {
  private readonly store: MemoryStore;
  private readonly wallets: WalletProvider;
  private readonly reputation: ReputationLedger;
  private readonly mode: RuntimeMode;
  private readonly now: () => Date;
  private readonly schemaHook: SchemaValidationHook | null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ServiceOptions = {}) {
    this.store = options.store ?? new MemoryStore();
    this.wallets = options.wallets ?? new MockWalletProvider();
    this.reputation = options.reputation ?? new MemoryReputationLedger();
    this.mode = options.mode ?? "sandbox";
    this.now = options.now ?? (() => new Date());
    this.schemaHook = options.schemaHook ?? null;
  }

  authenticate(apiKey: string): string | null {
    return this.store.apiKeys.get(hashSandboxApiKey(apiKey)) ?? null;
  }

  createOrganization(name: string): Promise<CreateOrganizationResult> {
    return this.enqueue(() => this.createOrganizationUnlocked(name));
  }

  createAgent(organizationId: string, input: CreateAgentInput): Promise<CreateAgentResult> {
    return this.enqueue(() => this.createAgentUnlocked(organizationId, input));
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
    return this.enqueue(async () => {
      const organization = this.requireOrganization(organizationId);
      const wallet = this.requireWallet(organization.treasuryWalletId);
      return { wallet, balanceUsdc: await this.wallets.getBalance(wallet.address) };
    });
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
    return this.enqueue(() => this.createEscrowUnlocked(organizationId, input));
  }

  submitEscrowResult(organizationId: string, escrowId: string, result: unknown): Promise<EscrowResult> {
    return this.enqueue(() => this.submitEscrowResultUnlocked(organizationId, escrowId, result));
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

  private async createEscrowUnlocked(organizationId: string, input: CreateEscrowInput): Promise<CreateEscrowResult> {
    const organization = this.requireOrganization(organizationId);
    const canonical = this.parsePositiveAmount(input.amountUsdc);
    const schema = this.parseEscrowSchema(input.schema);
    const memo = normalizeMemo(input.memo);
    if (input.buyerAgentId === input.sellerAgentId) {
      throw new ServiceError(400, "invalid_request", "Buyer and seller must be different agents.");
    }
    const buyer = this.requireActiveAgent(organization.id, input.buyerAgentId);
    const seller = this.requireActiveAgent(organization.id, input.sellerAgentId);
    const quote = quoteEscrowSettlement(canonical);
    const buyerWallet = this.requireWallet(buyer.walletId);
    const sellerWallet = this.requireWallet(seller.walletId);
    const buyerBalance = await this.wallets.getBalance(buyerWallet.address);
    if (compareUsdc(buyerBalance, canonical) < 0) {
      throw new ServiceError(409, "insufficient_balance", "Buyer balance cannot cover the escrow lock.");
    }

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
        organizationId: escrow.organizationId,
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
      organizationId: escrow.organizationId,
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

function normalizeMemo(memo: string | null): string | null {
  if (memo === null) return null;
  const trimmed = memo.trim();
  if (!trimmed) return null;
  if (trimmed.length > 140) {
    throw new ServiceError(400, "invalid_request", "memo must be at most 140 characters.");
  }
  return trimmed;
}

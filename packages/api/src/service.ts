import {
  addUsdc,
  compareUsdc,
  createId,
  createSandboxApiKey,
  evaluateSpend,
  formatUsdc,
  MockWalletProvider,
  parseUsdc,
  quoteSandboxFee,
  SANDBOX_MAX_ACTIVE_AGENTS,
  SANDBOX_TREASURY_GRANT_USDC,
  sumSpentTodayUsdc,
  type Agent,
  type LedgerDirection,
  type LedgerEntry,
  type Organization,
  type Policy,
  type RuntimeMode,
  type Transaction,
  type Wallet,
  type WalletProvider,
} from "@albesa/core";
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

const NAME_MAX = 80;
const VENDOR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface ServiceOptions {
  mode?: RuntimeMode;
  now?: () => Date;
  wallets?: WalletProvider;
  store?: MemoryStore;
}

export class AgentFinanceService {
  private readonly store: MemoryStore;
  private readonly wallets: WalletProvider;
  private readonly mode: RuntimeMode;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ServiceOptions = {}) {
    this.store = options.store ?? new MemoryStore();
    this.wallets = options.wallets ?? new MockWalletProvider();
    this.mode = options.mode ?? "sandbox";
    this.now = options.now ?? (() => new Date());
  }

  authenticate(apiKey: string): string | null {
    return this.store.apiKeys.get(apiKey) ?? null;
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
    this.store.apiKeys.set(apiKey, organization.id);

    if (this.mode === "sandbox") {
      await this.mintSandboxGrant(organization, wallet, createdAt);
    }

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
    return { transaction, balanceUsdc: await this.wallets.getBalance(wallet.address) };
  }

  private async mintSandboxGrant(organization: Organization, wallet: Wallet, createdAt: string): Promise<void> {
    if (!(this.wallets instanceof MockWalletProvider)) {
      throw new ServiceError(403, "invalid_request", "Sandbox grants are only available on the mock wallet adapter.");
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

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
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

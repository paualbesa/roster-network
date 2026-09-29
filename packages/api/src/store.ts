import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseUsdc } from "@albesa/core";
import type {
  Agent,
  Escrow,
  LedgerEntry,
  MockWalletSnapshot,
  Organization,
  Policy,
  Transaction,
  Wallet,
} from "@albesa/core";

const FILE_VERSION = 1;

export class SandboxStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxStoreError";
  }
}

/**
 * Process-local sandbox state. `apiKeys` maps a SHA-256 hex digest to an organization id.
 * The secret itself is never stored.
 */
export class MemoryStore {
  readonly organizations = new Map<string, Organization>();
  readonly apiKeys = new Map<string, string>();
  readonly agents = new Map<string, Agent>();
  readonly wallets = new Map<string, Wallet>();
  readonly policies = new Map<string, Policy>();
  readonly escrows = new Map<string, Escrow>();
  readonly transactions: Transaction[] = [];
  readonly ledger: LedgerEntry[] = [];

  commit(_wallet: MockWalletSnapshot | null): void {}

  readWalletState(): MockWalletSnapshot {
    return { balances: [], sequence: 0 };
  }
}

interface FileDocument {
  version: typeof FILE_VERSION;
  organizations: Organization[];
  apiKeyHashes: { hash: string; organizationId: string }[];
  agents: Agent[];
  wallets: Wallet[];
  policies: Policy[];
  escrows: Escrow[];
  transactions: Transaction[];
  ledger: LedgerEntry[];
  wallet: MockWalletSnapshot;
}

/**
 * JSON file for one API process. Writes are atomic (temp file, then rename).
 * Wallet balances are included so a restart can refill the sandbox wallet provider,
 * including escrow custody holds. Escrows are optional on older version-1 files.
 */
export class JsonFileStore extends MemoryStore {
  private wallet: MockWalletSnapshot = { balances: [], sequence: 0 };

  private constructor(private readonly filePath: string) {
    super();
  }

  static open(filePath: string): JsonFileStore {
    const trimmed = filePath.trim();
    if (!trimmed) throw new SandboxStoreError("Sandbox data file path is required.");
    const store = new JsonFileStore(trimmed);
    store.load();
    return store;
  }

  override commit(wallet: MockWalletSnapshot | null): void {
    if (wallet) this.wallet = cloneWalletSnapshot(wallet);
    this.write();
  }

  override readWalletState(): MockWalletSnapshot {
    return cloneWalletSnapshot(this.wallet);
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unreadable";
      throw new SandboxStoreError(`Could not read sandbox data file: ${message}`);
    }
    const document = parseDocument(parsed);
    for (const organization of document.organizations) this.organizations.set(organization.id, organization);
    for (const entry of document.apiKeyHashes) this.apiKeys.set(entry.hash, entry.organizationId);
    for (const agent of document.agents) this.agents.set(agent.id, agent);
    for (const wallet of document.wallets) this.wallets.set(wallet.id, wallet);
    for (const policy of document.policies) this.policies.set(policy.id, policy);
    for (const escrow of document.escrows) this.escrows.set(escrow.id, escrow);
    this.transactions.push(...document.transactions);
    this.ledger.push(...document.ledger);
    this.wallet = document.wallet;
  }

  private write(): void {
    const document: FileDocument = {
      version: FILE_VERSION,
      organizations: [...this.organizations.values()],
      apiKeyHashes: [...this.apiKeys.entries()].map(([hash, organizationId]) => ({ hash, organizationId })),
      agents: [...this.agents.values()],
      wallets: [...this.wallets.values()],
      policies: [...this.policies.values()],
      escrows: [...this.escrows.values()],
      transactions: this.transactions.slice(),
      ledger: this.ledger.slice(),
      wallet: this.readWalletState(),
    };
    const json = `${JSON.stringify(document, null, 2)}\n`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid.toString()}.tmp`;
    writeFileSync(temporary, json, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

function parseDocument(value: unknown): FileDocument {
  if (!isRecord(value) || value.version !== FILE_VERSION) {
    throw new SandboxStoreError("Sandbox data file must be version 1.");
  }
  return {
    version: FILE_VERSION,
    organizations: asEntities<Organization>(value.organizations, "organizations"),
    apiKeyHashes: parseKeyHashes(value.apiKeyHashes),
    agents: asEntities<Agent>(value.agents, "agents"),
    wallets: asEntities<Wallet>(value.wallets, "wallets"),
    policies: asEntities<Policy>(value.policies, "policies"),
    escrows: value.escrows === undefined ? [] : asEntities<Escrow>(value.escrows, "escrows"),
    transactions: asEntities<Transaction>(value.transactions, "transactions"),
    ledger: asEntities<LedgerEntry>(value.ledger, "ledger"),
    wallet: parseWallet(value.wallet),
  };
}

function parseKeyHashes(value: unknown): { hash: string; organizationId: string }[] {
  if (!Array.isArray(value)) throw new SandboxStoreError("apiKeyHashes must be an array.");
  const hashes: { hash: string; organizationId: string }[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.hash !== "string" || typeof item.organizationId !== "string") {
      throw new SandboxStoreError("apiKeyHashes entries must include hash and organizationId.");
    }
    if (!/^[0-9a-f]{64}$/.test(item.hash)) {
      throw new SandboxStoreError("apiKeyHashes entries must be SHA-256 hex digests.");
    }
    hashes.push({ hash: item.hash, organizationId: item.organizationId });
  }
  return hashes;
}

function parseWallet(value: unknown): MockWalletSnapshot {
  if (!isRecord(value) || !Array.isArray(value.balances) || typeof value.sequence !== "number") {
    throw new SandboxStoreError("Sandbox data file is missing the mock wallet snapshot.");
  }
  if (!Number.isInteger(value.sequence) || value.sequence < 0) {
    throw new SandboxStoreError("Mock wallet sequence must be a non-negative integer.");
  }
  const balances: { address: string; balanceUsdc: string }[] = [];
  for (const entry of value.balances) {
    if (!isRecord(entry) || typeof entry.address !== "string" || typeof entry.balanceUsdc !== "string") {
      throw new SandboxStoreError("Mock wallet snapshot has an invalid balance entry.");
    }
    if (!entry.address) throw new SandboxStoreError("Mock wallet snapshot has an empty address.");
    balances.push({ address: entry.address, balanceUsdc: entry.balanceUsdc });
  }
  const snapshot: MockWalletSnapshot = { balances, sequence: value.sequence };
  if (value.networkFeesCollectedUsdc !== undefined) {
    if (typeof value.networkFeesCollectedUsdc !== "string") {
      throw new SandboxStoreError("Simulated network fee total must be a USDC string.");
    }
    try {
      parseUsdc(value.networkFeesCollectedUsdc);
    } catch {
      throw new SandboxStoreError("Simulated network fee total must be a USDC string.");
    }
    snapshot.networkFeesCollectedUsdc = value.networkFeesCollectedUsdc;
  }
  return snapshot;
}

function cloneWalletSnapshot(wallet: MockWalletSnapshot): MockWalletSnapshot {
  const snapshot: MockWalletSnapshot = {
    sequence: wallet.sequence,
    balances: wallet.balances.map((entry) => ({ address: entry.address, balanceUsdc: entry.balanceUsdc })),
  };
  if (wallet.networkFeesCollectedUsdc !== undefined) {
    snapshot.networkFeesCollectedUsdc = wallet.networkFeesCollectedUsdc;
  }
  return snapshot;
}

function asEntities<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new SandboxStoreError(`${label} must be an array.`);
  const entities: T[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) {
      throw new SandboxStoreError(`${label}[${index.toString()}] is missing an id.`);
    }
    entities.push(item as T);
  }
  return entities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

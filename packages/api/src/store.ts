import type { Agent, LedgerEntry, Organization, Policy, Transaction, Wallet } from "@albesa/core";

export class MemoryStore {
  readonly organizations = new Map<string, Organization>();
  readonly apiKeys = new Map<string, string>();
  readonly agents = new Map<string, Agent>();
  readonly wallets = new Map<string, Wallet>();
  readonly policies = new Map<string, Policy>();
  readonly transactions: Transaction[] = [];
  readonly ledger: LedgerEntry[] = [];
}

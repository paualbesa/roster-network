export type RuntimeMode = "sandbox" | "testnet";

export type ChainId = "mock" | "base-sepolia";

export type AssetCode = "USDC";

export type AgentStatus = "active" | "suspended";

export type WalletOwnerType = "organization" | "agent";

export type TransactionType = "sandbox_grant" | "fund" | "payment";

export type TransactionStatus = "settled" | "rejected";

export type LedgerDirection = "credit" | "debit";

export type PolicyBlockReason =
  | "daily_limit_exceeded"
  | "vendor_not_allowlisted"
  | "invalid_amount";

export type RejectionReason = PolicyBlockReason | "insufficient_balance";

export interface Organization {
  id: string;
  name: string;
  treasuryWalletId: string;
  mode: RuntimeMode;
  createdAt: string;
}

export interface Agent {
  id: string;
  organizationId: string;
  name: string;
  walletId: string;
  policyId: string;
  status: AgentStatus;
  createdAt: string;
}

export interface Wallet {
  id: string;
  organizationId: string;
  ownerType: WalletOwnerType;
  ownerId: string;
  address: string;
  chain: ChainId;
  asset: AssetCode;
  createdAt: string;
}

export interface Policy {
  id: string;
  organizationId: string;
  agentId: string;
  dailySpendLimitUsdc: string;
  vendorAllowlist: string[];
  createdAt: string;
}

export interface Transaction {
  id: string;
  organizationId: string;
  agentId: string | null;
  type: TransactionType;
  status: TransactionStatus;
  fromWalletId: string | null;
  toAddress: string;
  vendorId: string | null;
  amountUsdc: string;
  feeUsdc: string;
  rejectionReason: RejectionReason | null;
  providerRef: string | null;
  chain: ChainId;
  memo: string | null;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  organizationId: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amountUsdc: string;
  balanceAfterUsdc: string;
  memo: string;
  createdAt: string;
}

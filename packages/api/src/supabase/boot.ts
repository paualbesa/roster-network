import {
  createWalletProvider,
  isPersistentSandboxWallet,
  type RuntimeMode,
  type WalletProvider,
  type WalletRail,
} from "@albesa/core";
import { CapabilityRegistry } from "@albesa/registry";
import { MemoryReputationLedger } from "@albesa/reputation";
import type { SolanaEngineConfig } from "@albesa/solana";
import { createApp, type AppHttpOptions } from "../app.js";
import { MemoryJobStore } from "../jobs.js";
import { AgentFinanceService } from "../service.js";
import { MemoryStore } from "../store.js";
import { verifySupabaseAccessToken } from "./auth.js";
import { createAnonClient, createServiceClient } from "./client.js";
import type { SupabaseConfig } from "./env.js";
import { SupabaseMirror, createSupabaseTableClient } from "./mirror.js";
import { UPSERT_ORDER, applySnapshot, rowsToSnapshot } from "./rows.js";

export interface SupabaseApp {
  app: ReturnType<typeof createApp>;
  mirror: SupabaseMirror;
  wallets: WalletProvider;
}

/** Load Postgres into the in-memory stores and flush later writes back. */
export async function openSupabaseApp(options: {
  config: SupabaseConfig;
  mode: RuntimeMode;
  walletRail: WalletRail;
  now?: () => Date;
  autofill?: "sync" | "async";
  solana?: SolanaEngineConfig;
  http?: AppHttpOptions;
}): Promise<SupabaseApp> {
  const serviceClient = createServiceClient(options.config);
  const anonClient = createAnonClient(options.config);
  const io = createSupabaseTableClient(serviceClient);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of UPSERT_ORDER) {
    tables[table] = await io.selectAll(table);
  }
  const snapshot = rowsToSnapshot(tables);
  const store = new MemoryStore();
  const jobs = new MemoryJobStore();
  const reputation = new MemoryReputationLedger();
  const registry = new CapabilityRegistry(options.now ? { now: options.now } : {});
  applySnapshot({ snapshot, store, jobs, reputation, registry });
  const wallets = createWalletProvider(options.walletRail);
  if (isPersistentSandboxWallet(wallets)) wallets.importState(snapshot.wallet);
  const mirror = new SupabaseMirror(io, store, jobs, reputation, registry);
  mirror.rememberWallet(snapshot.wallet);
  mirror.attach();
  const service = new AgentFinanceService({
    mode: options.mode,
    wallets,
    store,
    reputation,
    ...(options.now ? { now: options.now } : {}),
  });
  const app = createApp({
    ...(options.http ?? { storage: "supabase" }),
    mode: options.mode,
    walletRail: options.walletRail,
    service,
    jobs,
    registry,
    ...(options.now ? { now: options.now } : {}),
    ...(options.autofill ? { autofill: options.autofill } : {}),
    ...(options.solana ? { solana: options.solana } : {}),
    supabase: {
      verifyAccessToken: (accessToken) => verifySupabaseAccessToken(anonClient, accessToken),
      matchCapabilities: (query, limit) => mirror.matchCapabilities(query, limit),
      flush: () => mirror.flush(),
    },
  });
  return { app, mirror, wallets };
}

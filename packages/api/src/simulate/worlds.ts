import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatUsdc,
  isPersistentSandboxWallet,
  MockWalletProvider,
  parseUsdc,
  type WalletProvider,
} from "@albesa/core";
import { CapabilityRegistry } from "@albesa/registry";
import { JsonReputationLedger } from "@albesa/reputation";
import { mockSolanaEngineConfig } from "@albesa/solana";
import { createApp } from "../app.js";
import { bootstrapSandboxFleet } from "../fleet.js";
import { JsonJobStore } from "../jobs.js";
import { AgentFinanceService } from "../service.js";
import { JsonFileStore } from "../store.js";
import { openSupabaseApp } from "../supabase/boot.js";
import type { SupabaseConfig } from "../supabase/env.js";

export interface FleetHandle {
  organizationId: string;
  sellerAgentId: string;
  listings: { id: string; name: string }[];
  createdOrganization: boolean;
}

export interface SimWorld {
  name: string;
  request(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response>;
  /** Move the sandbox clock. Live worlds wait on the wall clock instead. */
  advance(ms: number): Promise<void>;
  /** Sum of every sandbox balance, including fee sinks and escrow holds. Null on a remote API. */
  walletSum(): Promise<string | null>;
  bootstrapFleet(): Promise<FleetHandle | null>;
  reload?(): Promise<void>;
  close?(): Promise<void>;
}

export interface VirtualClock {
  now: () => Date;
  advance(ms: number): void;
}

export function virtualClock(start = Date.parse("2026-10-05T12:00:00.000Z")): VirtualClock {
  let current = start;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

export function sumWallet(wallets: WalletProvider): string | null {
  if (!isPersistentSandboxWallet(wallets)) return null;
  let total = 0n;
  for (const entry of wallets.exportState().balances) total += parseUsdc(entry.balanceUsdc);
  return formatUsdc(total);
}

export function openMemoryWorld(): SimWorld {
  const clock = virtualClock();
  const wallets = new MockWalletProvider();
  const app = createApp({
    mode: "sandbox",
    now: clock.now,
    autofill: "sync",
    solana: mockSolanaEngineConfig(),
    service: new AgentFinanceService({ mode: "sandbox", wallets, now: clock.now }),
  });
  return {
    name: "memory",
    request: (path, init) => Promise.resolve(app.request(path, init)),
    advance: async (ms) => {
      clock.advance(ms);
    },
    walletSum: async () => sumWallet(wallets),
    bootstrapFleet: () => bootstrapSandboxFleet(app),
  };
}

export function openJsonWorld(directory = mkdtempSync(join(tmpdir(), "roster-sim-"))): SimWorld {
  const clock = virtualClock();
  const dataFile = join(directory, "sandbox.json");
  const reputationFile = join(directory, "reputation.json");
  const jobsFile = join(directory, "jobs.json");
  const registryPath = join(directory, "registry.json");

  const open = () => {
    const store = JsonFileStore.open(dataFile);
    const wallets = new MockWalletProvider();
    wallets.importState(store.readWalletState());
    const app = createApp({
      mode: "sandbox",
      now: clock.now,
      autofill: "sync",
      solana: mockSolanaEngineConfig(),
      service: new AgentFinanceService({
        mode: "sandbox",
        wallets,
        now: clock.now,
        store,
        reputation: JsonReputationLedger.open(reputationFile),
      }),
      jobs: JsonJobStore.open(jobsFile),
      registry: new CapabilityRegistry({ filePath: registryPath, now: clock.now }),
    });
    return { app, wallets };
  };

  let current = open();
  return {
    name: "json",
    request: (path, init) => Promise.resolve(current.app.request(path, init)),
    advance: async (ms) => {
      clock.advance(ms);
    },
    walletSum: async () => sumWallet(current.wallets),
    bootstrapFleet: () => bootstrapSandboxFleet(current.app),
    reload: async () => {
      current = open();
    },
    close: async () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function openPostgresWorld(config: SupabaseConfig): Promise<SimWorld> {
  const clock = virtualClock();
  const open = () =>
    openSupabaseApp({
      config,
      mode: "sandbox",
      walletRail: "mock",
      now: clock.now,
      autofill: "sync",
      solana: mockSolanaEngineConfig(),
    });
  let current = await open();
  return {
    name: "postgres",
    request: (path, init) => Promise.resolve(current.app.request(path, init)),
    advance: async (ms) => {
      clock.advance(ms);
    },
    walletSum: async () => sumWallet(current.wallets),
    bootstrapFleet: () => bootstrapSandboxFleet(current.app),
    reload: async () => {
      await current.mirror.flush();
      current = await open();
    },
  };
}

export function joinApiUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}${path.startsWith("/") ? path : `/${path}`}`;
}

export function openLiveWorld(baseUrl: string): SimWorld {
  return {
    name: "live",
    request: (path, init) => fetch(joinApiUrl(baseUrl, path), init),
    advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    walletSum: async () => null,
    bootstrapFleet: async () => {
      const token = process.env.ROSTER_SIM_ADMIN_TOKEN?.trim() || process.env.ROSTER_ADMIN_TOKEN?.trim() || "";
      if (!token) return null;
      const response = await fetch(joinApiUrl(baseUrl, "/v1/admin/fleet/bootstrap"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Live fleet bootstrap failed (${response.status.toString()}): ${detail.slice(0, 240)}`);
      }
      const body = (await response.json()) as { fleet: FleetHandle };
      return body.fleet;
    },
  };
}

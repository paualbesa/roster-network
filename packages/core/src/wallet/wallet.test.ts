import { describe, expect, it } from "vitest";
import { resolveRuntimeMode } from "../mode.js";
import { MockWalletProvider } from "./mock.js";
import { createWalletProvider, resolveWalletRail } from "./select.js";
import { SolanaUsdcWalletProvider, type SolanaUsdcWalletOptions } from "./solana.js";

describe("MockWalletProvider", () => {
  it("moves USDC between mock addresses and refuses an overdraft", async () => {
    const wallets = new MockWalletProvider();
    const treasury = await wallets.createAddress("treasury:org_1");
    const agent = await wallets.createAddress("agent:agt_1");
    await wallets.credit(treasury.address, "5.00");
    const result = await wallets.transfer({
      fromAddress: treasury.address,
      toAddress: agent.address,
      amountUsdc: "1.25",
      idempotencyKey: "fund_1",
    });
    expect(result.status).toBe("settled");
    expect(result.chain).toBe("mock");
    expect(result.networkFeeUsdc).toBeUndefined();
    expect(result.latencyMs).toBeUndefined();
    expect(await wallets.getBalance(treasury.address)).toBe("3.750000");
    expect(await wallets.getBalance(agent.address)).toBe("1.250000");
    await expect(
      wallets.transfer({
        fromAddress: agent.address,
        toAddress: "mock:vendor:vendor_data",
        amountUsdc: "2",
        idempotencyKey: "pay_1",
      }),
    ).rejects.toThrow(/Insufficient balance/);
  });

  it("restores balances and continues the transfer sequence", async () => {
    const first = new MockWalletProvider();
    const treasury = await first.createAddress("treasury:org_1");
    await first.credit(treasury.address, "2");
    await first.transfer({
      fromAddress: treasury.address,
      toAddress: "mock:vendor:vendor_data",
      amountUsdc: "0.50",
      idempotencyKey: "pay_1",
    });
    const second = new MockWalletProvider();
    second.importState(first.exportState());
    expect(await second.getBalance(treasury.address)).toBe("1.500000");
    const next = await second.transfer({
      fromAddress: treasury.address,
      toAddress: "mock:vendor:vendor_data",
      amountUsdc: "0.25",
      idempotencyKey: "pay_2",
    });
    expect(next.providerRef).toBe("mock_tx_2");
    expect(await second.getBalance(treasury.address)).toBe("1.250000");
  });
});

describe("SolanaUsdcWalletProvider", () => {
  it("stays a sandbox stub and refuses RPC URLs and key material", async () => {
    const wallets = new SolanaUsdcWalletProvider();
    expect(wallets.id).toBe("solana-usdc");
    expect(wallets.chain).toBe("solana-devnet-sim");
    await expect(wallets.createAddress("agent:agt_1")).rejects.toThrow(/not implemented/);
    await expect(wallets.getBalance("addr")).rejects.toThrow(/No chain calls are made/);
    await expect(
      wallets.transfer({
        fromAddress: "addr",
        toAddress: "other",
        amountUsdc: "1",
        idempotencyKey: "tx_1",
      }),
    ).rejects.toThrow(/not implemented/);
    expect(() => new SolanaUsdcWalletProvider({ rpcUrl: "https://api.devnet.solana.com" })).toThrow(/RPC URLs/);
    expect(() => new SolanaUsdcWalletProvider({ mnemonic: "abandon abandon" } as SolanaUsdcWalletOptions)).toThrow(
      /private keys, mnemonics, and seeds/,
    );
  });
});

describe("resolveWalletRail", () => {
  it("defaults to mock and accepts the sandbox aliases", () => {
    expect(resolveWalletRail({})).toBe("mock");
    expect(resolveWalletRail({ ROSTER_WALLET: "  " })).toBe("mock");
    expect(resolveWalletRail({ ROSTER_WALLET: "base-sim" })).toBe("base-sim");
    expect(resolveWalletRail({ ALBESA_WALLET: "BASE-SIM" })).toBe("base-sim");
    expect(resolveWalletRail({ ROSTER_WALLET: "solana-sim", ALBESA_WALLET: "solana-sim" })).toBe("solana-sim");
    expect(resolveWalletRail({ ROSTER_WALLET: "solana-devnet" })).toBe("solana-devnet");
    expect(resolveWalletRail({ ROSTER_RAIL: "solana-devnet" })).toBe("solana-devnet");
    expect(() => createWalletProvider("solana-devnet")).toThrow(/fee-payer/);
    expect(createWalletProvider("mock")).toBeInstanceOf(MockWalletProvider);
    expect(createWalletProvider("base-sim").id).toBe("base-usdc");
    expect(createWalletProvider("base-sim").chain).toBe("base-sepolia-sim");
    expect(createWalletProvider("solana-sim")).toBeInstanceOf(SolanaUsdcWalletProvider);
  });

  it("rejects an unknown rail, a disagreement, and does not add a mainnet wallet", () => {
    expect(() => resolveWalletRail({ ROSTER_WALLET: "mainnet" })).toThrow(/Unsupported wallet rail/);
    expect(() => resolveWalletRail({ ROSTER_WALLET: "mock", ALBESA_WALLET: "base-sim" })).toThrow(/disagree/);
  });
});

describe("resolveRuntimeMode", () => {
  it("defaults to sandbox and accepts either mode alias", () => {
    expect(resolveRuntimeMode({})).toBe("sandbox");
    expect(resolveRuntimeMode({ ALBESA_MODE: "testnet" })).toBe("testnet");
    expect(resolveRuntimeMode({ ROSTER_MODE: "testnet" })).toBe("testnet");
    expect(resolveRuntimeMode({ ROSTER_MODE: "  ", ALBESA_MODE: "testnet" })).toBe("testnet");
    expect(resolveRuntimeMode({ ROSTER_MODE: "sandbox", ALBESA_MODE: "sandbox" })).toBe("sandbox");
  });

  it("rejects mainnet on ROSTER_MODE and ALBESA_MODE", () => {
    expect(() => resolveRuntimeMode({ ALBESA_MODE: "mainnet" })).toThrow(/mainnet is disabled/);
    expect(() => resolveRuntimeMode({ ROSTER_MODE: "mainnet" })).toThrow(/mainnet is disabled/);
    expect(() => resolveRuntimeMode({ ROSTER_MODE: "mainnet", ALBESA_MODE: "mainnet" })).toThrow(
      /mainnet is disabled/,
    );
  });

  it("rejects a disagreement or an unknown value", () => {
    expect(() => resolveRuntimeMode({ ROSTER_MODE: "sandbox", ALBESA_MODE: "testnet" })).toThrow(/disagree/);
    expect(() => resolveRuntimeMode({ ROSTER_MODE: "prod" })).toThrow(/Unsupported runtime mode/);
  });
});

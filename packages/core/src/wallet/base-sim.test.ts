import { describe, expect, it } from "vitest";
import { addUsdc, formatUsdc, parseUsdc } from "../money.js";
import {
  BaseUsdcWalletProvider,
  SIMULATED_BASE_LATENCY_MS,
  SIMULATED_BASE_NETWORK_FEE_USDC,
  simulatedBaseAddress,
  type BaseUsdcWalletOptions,
} from "./base.js";

describe("BaseUsdcWalletProvider", () => {
  it("mints a deterministic sandbox address and funds it without a key", async () => {
    const wallets = new BaseUsdcWalletProvider();
    const other = new BaseUsdcWalletProvider();
    const treasury = await wallets.createAddress("treasury:org_1");
    const again = await other.createAddress("treasury:org_1");
    const agent = await wallets.createAddress("agent:agt_1");

    expect(wallets.id).toBe("base-usdc");
    expect(wallets.chain).toBe("base-sepolia-sim");
    expect(treasury.address).toBe(again.address);
    expect(treasury.address).toBe(simulatedBaseAddress("treasury:org_1"));
    expect(treasury.address).toMatch(/^base-sim:0x[0-9a-f]{40}$/);
    expect(treasury.address).not.toBe(agent.address);
    expect(treasury.address.includes("org_1")).toBe(false);

    await wallets.credit(treasury.address, "5.00");
    const repeat = await wallets.createAddress("treasury:org_1");
    expect(repeat.address).toBe(treasury.address);
    expect(await wallets.getBalance(treasury.address)).toBe("5.000000");
    expect(await wallets.getBalance(agent.address)).toBe("0.000000");
  });

  it("transfers principal like the mock rail and accounts a tiny simulated fee", async () => {
    const wallets = new BaseUsdcWalletProvider();
    const treasury = await wallets.createAddress("treasury:org_1");
    const agent = await wallets.createAddress("agent:agt_1");
    await wallets.credit(treasury.address, "5.00");

    const funded = await wallets.transfer({
      fromAddress: treasury.address,
      toAddress: agent.address,
      amountUsdc: "1.25",
      idempotencyKey: "fund_1",
    });
    const paid = await wallets.transfer({
      fromAddress: agent.address,
      toAddress: simulatedBaseAddress("vendor:vendor_data"),
      amountUsdc: "0.25",
      idempotencyKey: "pay_1",
    });

    expect(funded.status).toBe("settled");
    expect(funded.chain).toBe("base-sepolia-sim");
    expect(funded.providerRef).toBe("base_sim_tx_1");
    expect(funded.networkFeeUsdc).toBe(SIMULATED_BASE_NETWORK_FEE_USDC);
    expect(paid.networkFeeUsdc).toBe(SIMULATED_BASE_NETWORK_FEE_USDC);
    expect(funded.latencyMs).toBe(SIMULATED_BASE_LATENCY_MS);
    expect(paid.latencyMs).toBe(SIMULATED_BASE_LATENCY_MS);
    expect(SIMULATED_BASE_LATENCY_MS).toBeLessThan(2_000);
    expect(parseUsdc(SIMULATED_BASE_NETWORK_FEE_USDC)).toBeLessThan(parseUsdc("0.001"));

    expect(await wallets.getBalance(treasury.address)).toBe("3.750000");
    expect(await wallets.getBalance(agent.address)).toBe("1.000000");
    expect(await wallets.getBalance(simulatedBaseAddress("vendor:vendor_data"))).toBe("0.250000");

    const stats = wallets.diagnostics();
    expect(stats).toEqual({
      rail: "base-sim",
      chain: "base-sepolia-sim",
      networkFeeUsdc: "0.000001",
      latencyMs: 180,
      transferCount: 2,
      feesCollectedUsdc: "0.000002",
    });
    expect(addUsdc(funded.networkFeeUsdc ?? "0", paid.networkFeeUsdc ?? "0")).toBe(stats.feesCollectedUsdc);

    const supply = wallets
      .exportState()
      .balances.reduce((sum, entry) => sum + parseUsdc(entry.balanceUsdc), 0n);
    expect(formatUsdc(supply)).toBe("5.000000");
    expect(parseUsdc(stats.feesCollectedUsdc)).toBeGreaterThan(0n);

    const replay = await wallets.transfer({
      fromAddress: treasury.address,
      toAddress: agent.address,
      amountUsdc: "1.250000",
      idempotencyKey: "fund_1",
    });
    expect(replay.providerRef).toBe(funded.providerRef);
    expect(wallets.diagnostics().feesCollectedUsdc).toBe("0.000002");
    expect(await wallets.getBalance(treasury.address)).toBe("3.750000");

    await expect(
      wallets.transfer({
        fromAddress: treasury.address,
        toAddress: agent.address,
        amountUsdc: "9",
        idempotencyKey: "fund_1",
      }),
    ).rejects.toThrow(/different transfer/);
    await expect(
      wallets.transfer({
        fromAddress: agent.address,
        toAddress: simulatedBaseAddress("vendor:vendor_data"),
        amountUsdc: "2",
        idempotencyKey: "pay_over",
      }),
    ).rejects.toThrow(/Insufficient balance/);
    expect(wallets.diagnostics().transferCount).toBe(2);
  });

  it("restores balances, the transfer sequence, and collected fees", async () => {
    const first = new BaseUsdcWalletProvider();
    const treasury = await first.createAddress("treasury:org_1");
    await first.credit(treasury.address, "2");
    await first.transfer({
      fromAddress: treasury.address,
      toAddress: simulatedBaseAddress("vendor:vendor_data"),
      amountUsdc: "0.50",
      idempotencyKey: "pay_1",
    });
    const second = new BaseUsdcWalletProvider();
    second.importState(first.exportState());
    expect(await second.getBalance(treasury.address)).toBe("1.500000");
    expect(second.diagnostics().feesCollectedUsdc).toBe("0.000001");
    const next = await second.transfer({
      fromAddress: treasury.address,
      toAddress: simulatedBaseAddress("vendor:vendor_data"),
      amountUsdc: "0.25",
      idempotencyKey: "pay_2",
    });
    expect(next.providerRef).toBe("base_sim_tx_2");
    expect(second.diagnostics().feesCollectedUsdc).toBe("0.000002");
    expect(await second.getBalance(treasury.address)).toBe("1.250000");
  });

  it("refuses RPC URLs and key fields, and stores none of them", () => {
    expect(() => new BaseUsdcWalletProvider({ rpcUrl: "https://sepolia.base.org" })).toThrow(/RPC URLs/);
    expect(() => new BaseUsdcWalletProvider({ privateKey: "0xabc" } as BaseUsdcWalletOptions)).toThrow(
      /private keys, mnemonics, and seeds/,
    );
    expect(() => new BaseUsdcWalletProvider({ seed: "hunter2" } as BaseUsdcWalletOptions)).toThrow(
      /private keys, mnemonics, and seeds/,
    );
    expect(() => new BaseUsdcWalletProvider({ mnemonic: "abandon abandon" } as BaseUsdcWalletOptions)).toThrow(
      /private keys, mnemonics, and seeds/,
    );

    const wallets = new BaseUsdcWalletProvider();
    expect(Object.getOwnPropertyNames(wallets).join(",")).not.toMatch(/private|mnemonic|seed|secret|rpc/i);
    expect(JSON.stringify(wallets.exportState())).not.toMatch(/privateKey|mnemonic|seed|rpcUrl/i);
    expect(JSON.stringify(wallets.diagnostics())).not.toMatch(/privateKey|mnemonic|seed|rpcUrl/i);
  });
});

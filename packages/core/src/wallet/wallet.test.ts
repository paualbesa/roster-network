import { describe, expect, it } from "vitest";
import { resolveRuntimeMode } from "../mode.js";
import { BaseUsdcWalletProvider } from "./base.js";
import { MockWalletProvider } from "./mock.js";

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

describe("BaseUsdcWalletProvider", () => {
  it("stays a stub and does not settle", async () => {
    const wallets = new BaseUsdcWalletProvider({ rpcUrl: "https://sepolia.base.org" });
    expect(wallets.chain).toBe("base-sepolia");
    await expect(wallets.createAddress("agent:agt_1")).rejects.toThrow(/not implemented/);
    await expect(wallets.getBalance("0xabc")).rejects.toThrow(/not implemented/);
    await expect(
      wallets.transfer({
        fromAddress: "0xabc",
        toAddress: "0xdef",
        amountUsdc: "1",
        idempotencyKey: "tx_1",
      }),
    ).rejects.toThrow(/not implemented/);
  });
});

describe("resolveRuntimeMode", () => {
  it("defaults to sandbox and rejects mainnet", () => {
    expect(resolveRuntimeMode({})).toBe("sandbox");
    expect(resolveRuntimeMode({ ALBESA_MODE: "testnet" })).toBe("testnet");
    expect(() => resolveRuntimeMode({ ALBESA_MODE: "mainnet" })).toThrow(/mainnet is disabled/);
  });
});

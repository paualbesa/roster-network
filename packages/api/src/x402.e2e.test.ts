import { serve } from "@hono/node-server";
import { Keypair, type VersionedTransaction } from "@solana/web3.js";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { bootstrapSandboxFleet } from "./fleet.js";
import { decodeHeader, DEVNET_USDC_MINT, encodeHeader, type PaymentRequirements } from "./x402/protocol.js";
import { buildExactSvmPayment, type SvmSettlementChain } from "./x402/svm.js";

/** Local API over real HTTP; the chain is mocked (no RPC, no funds). */
class MockChain implements SvmSettlementChain {
  readonly network = "solana-devnet";
  readonly kp = Keypair.generate();
  count = 0;
  get feePayer() {
    return this.kp.publicKey.toBase58();
  }
  async settle(tx: VersionedTransaction) {
    tx.sign([this.kp]);
    this.count += 1;
    return Buffer.from(tx.signatures[0]!).toString("hex");
  }
}

describe("x402 e2e over HTTP (local api, mocked chain)", () => {
  const chain = new MockChain();
  let base = "";
  let close: () => void = () => {};
  beforeAll(async () => {
    const app = createApp({ mode: "sandbox", autofill: "sync", dataCatalog: null, dataStore: null, x402: { payTo: Keypair.generate().publicKey.toBase58(), asset: DEVNET_USDC_MINT, chain, publicBaseUrl: null } });
    await bootstrapSandboxFleet(app);
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        base = `http://127.0.0.1:${info.port.toString()}`;
        resolve();
      });
      close = () => server.close();
    });
  }, 30_000);
  afterAll(() => close());

  it("an x402 client discovers, gets 402, pays and receives the result", async () => {
    const resources = (await (await fetch(`${base}/x402/resources?limit=5`)).json()) as { items: { resource: string; accepts: PaymentRequirements[] }[] };
    expect(resources.items.length).toBeGreaterThan(0);
    const url = resources.items[0]!.resource;
    expect(url.startsWith(base)).toBe(true);
    const challenge = await fetch(url);
    expect(challenge.status).toBe(402);
    expect(challenge.headers.get("payment-required")).toBeTruthy();
    const req = ((await challenge.json()) as { accepts: PaymentRequirements[] }).accepts[0]!;
    const tx = buildExactSvmPayment({ requirement: req, payer: Keypair.generate(), recentBlockhash: Keypair.generate().publicKey.toBase58() });
    const header = encodeHeader({ x402Version: 1, scheme: req.scheme, network: req.network, payload: { transaction: tx } });
    const paid = await fetch(url, { headers: { "X-PAYMENT": header } });
    expect(paid.status).toBe(200);
    const settlement = decodeHeader(paid.headers.get("x-payment-response") ?? "") as { success: boolean };
    expect(settlement.success).toBe(true);
    const body = (await paid.json()) as { delivered: boolean; job: { status: string } };
    expect(body).toMatchObject({ delivered: true, job: { status: "released" } });
    expect(chain.count).toBe(1);
  }, 30_000);
});

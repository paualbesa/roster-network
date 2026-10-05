import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockWalletProvider } from "@albesa/core";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { escrowLockIntent, quoteOnChainEscrowFee } from "./escrow-mode.js";
import { LocalKycDocumentStore, parseKycSubmission, resolveKycLimits, sniffKycDocument } from "./kyc.js";
import { AgentFinanceService } from "./service.js";
import { JsonFileStore, MemoryStore } from "./store.js";
import { applySnapshot, captureSnapshot, rowsToSnapshot, snapshotToRows } from "./supabase/rows.js";
import { MemoryJobStore } from "./jobs.js";
import { MemoryReputationLedger } from "@albesa/reputation";
import { CapabilityRegistry } from "@albesa/registry";

const TOKEN = "operator-kyc-token";
const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%fake test document\n");

type App = ReturnType<typeof createApp>;

async function boot(options: { escrowMode?: "custodial-mock" | "noncustodial-sim"; clock?: { now: Date } } = {}) {
  const clock = options.clock;
  const now = clock ? () => clock.now : undefined;
  const service = new AgentFinanceService({
    mode: "sandbox",
    wallets: new MockWalletProvider(),
    kycLimits: { tier0Usdc: "5.000000", tier1Usdc: "50.000000" },
    ...(options.escrowMode ? { escrowMode: options.escrowMode } : {}),
    ...(now ? { now } : {}),
  });
  const app = createApp({ mode: "sandbox", service, adminToken: TOKEN, ...(now ? { now } : {}) });
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme KYC" }),
  });
  const org = (await created.json()) as { apiKey: string; organization: { id: string } };
  const auth = { authorization: `Bearer ${org.apiKey}` };
  const json = { ...auth, "content-type": "application/json" };
  const agent = async (name: string) => {
    const response = await app.request("/v1/agents", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name, dailySpendLimitUsdc: "100.00", vendorAllowlist: [] }),
    });
    return ((await response.json()) as { agent: { id: string } }).agent.id;
  };
  const buyerId = await agent("buyer");
  const sellerId = await agent("seller");
  await app.request(`/v1/agents/${buyerId}/fund`, { method: "POST", headers: json, body: JSON.stringify({ amountUsdc: "100.00" }) });
  const lock = (amountUsdc: string) =>
    app.request("/v1/escrows", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ buyerAgentId: buyerId, sellerAgentId: sellerId, amountUsdc, schema }),
    });
  return { app, service, org, auth, json, buyerId, sellerId, lock };
}

function submission(fields: Record<string, string>, document?: { bytes: Uint8Array; name: string; type: string }): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (document) form.set("document", new Blob([document.bytes], { type: document.type }), document.name);
  return form;
}

const individual = { entityType: "individual", legalName: "Ada Lovelace", country: "es", dateOfBirth: "1990-12-10" };
const admin = { "x-roster-admin-token": TOKEN, "content-type": "application/json" };

async function submit(app: App, auth: Record<string, string>, form: FormData) {
  return app.request("/v1/kyc/submission", { method: "POST", headers: auth, body: form });
}

describe("KYC tiers", () => {
  it("reads limits from the environment with sane defaults", () => {
    expect(resolveKycLimits({})).toEqual({ tier0Usdc: "1000.000000", tier1Usdc: "25000.000000" });
    expect(resolveKycLimits({ ROSTER_KYC_T0_LIMIT_USDC: "250", ROSTER_KYC_T1_LIMIT_USDC: "9000.5" })).toEqual({
      tier0Usdc: "250.000000",
      tier1Usdc: "9000.500000",
    });
    expect(() => resolveKycLimits({ ROSTER_KYC_T0_LIMIT_USDC: "abc" })).toThrow(/ROSTER_KYC_T0_LIMIT_USDC/);
    expect(() => resolveKycLimits({ ROSTER_KYC_T0_LIMIT_USDC: "500", ROSTER_KYC_T1_LIMIT_USDC: "100" })).toThrow();
  });

  it("detects documents by magic bytes and validates applicant fields", () => {
    expect(sniffKycDocument(PNG)).toBe("image/png");
    expect(sniffKycDocument(PDF)).toBe("application/pdf");
    expect(sniffKycDocument(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffKycDocument(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffKycDocument(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    const now = new Date("2026-10-05T00:00:00Z");
    expect(parseKycSubmission(individual, now)).toMatchObject({ country: "ES", companyRegNo: null });
    expect(parseKycSubmission({ legalName: "Roster SL", country: "ES", companyRegNo: "B-12345678" }, now)).toMatchObject({
      entityType: "company",
      dateOfBirth: null,
    });
    expect(() => parseKycSubmission({ ...individual, dateOfBirth: "2015-01-01" }, now)).toThrow(/18/);
    expect(() => parseKycSubmission({ ...individual, dateOfBirth: "1990-02-31" }, now)).toThrow();
    expect(() => parseKycSubmission({ ...individual, country: "Spain" }, now)).toThrow(/ISO/);
  });

  it("enforces the Tier 0 cap at lock time with an actionable error", async () => {
    const { app, auth, lock } = await boot();
    const kyc = await app.request("/v1/kyc", { headers: auth });
    expect(kyc.status).toBe(200);
    expect(((await kyc.json()) as { kyc: unknown }).kyc).toMatchObject({
      tier: 0,
      status: "none",
      usedUsdc: "0.000000",
      limitUsdc: "5.000000",
      windowDays: 30,
    });
    expect((await lock("3.00")).status).toBe(201);
    const blocked = await lock("2.50");
    expect(blocked.status).toBe(403);
    const body = (await blocked.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: "kyc_limit_exceeded",
      tier: 0,
      usedUsdc: "3.000000",
      requestedUsdc: "2.500000",
      limitUsdc: "5.000000",
      remainingUsdc: "2.000000",
      upgrade: { tier: 1, limitUsdc: "50.000000", endpoint: "POST /v1/kyc/submission", console: "/console/kyc" },
    });
    expect((await lock("2.00")).status).toBe(201);
  });

  it("does not count refunded escrows and drops volume after 30 days", async () => {
    const clock = { now: new Date("2026-09-01T10:00:00Z") };
    const { app, json, lock } = await boot({ clock });
    const first = (await (await lock("5.00")).json()) as { escrow: { id: string } };
    expect((await lock("1.00")).status).toBe(403);
    const refund = await app.request(`/v1/escrows/${first.escrow.id}/result`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ result: { wrong: true } }),
    });
    expect(((await refund.json()) as { escrow: { status: string } }).escrow.status).toBe("refunded");
    expect((await lock("5.00")).status).toBe(201);
    expect((await lock("0.50")).status).toBe(403);
    clock.now = new Date("2026-10-02T10:00:01Z");
    expect((await lock("5.00")).status).toBe(201);
  });

  it("runs submission, signed preview, approval, audit and document deletion", async () => {
    const { app, auth, org, lock } = await boot();
    const orgId = org.organization.id;

    expect((await app.request("/v1/kyc", {})).status).toBe(401);
    expect((await submit(app, {}, submission(individual, { bytes: PNG, name: "id.png", type: "image/png" }))).status).toBe(401);

    const svg = await submit(app, auth, submission(individual, { bytes: new TextEncoder().encode("<svg/>"), name: "id.png", type: "image/png" }));
    expect(svg.status).toBe(400);
    const missing = await submit(app, auth, submission(individual));
    expect(missing.status).toBe(400);
    const badDob = await submit(app, auth, submission({ ...individual, dateOfBirth: "yesterday" }, { bytes: PNG, name: "id.png", type: "image/png" }));
    expect(badDob.status).toBe(400);
    const tooBig = new Uint8Array(5 * 1024 * 1024 + 10);
    tooBig.set(PDF);
    const big = await submit(app, auth, submission(individual, { bytes: tooBig, name: "big.pdf", type: "application/pdf" }));
    expect(big.status).toBe(413);

    const ok = await submit(app, auth, submission(individual, { bytes: PDF, name: "passport.pdf", type: "application/pdf" }));
    expect(ok.status).toBe(201);
    const submitted = ((await ok.json()) as { kyc: Record<string, unknown> }).kyc;
    expect(submitted).toMatchObject({ status: "pending", tier: 0, document: { mimeType: "application/pdf", deleted: false } });
    expect(JSON.stringify(submitted)).not.toContain("kyc-documents");

    const again = await submit(app, auth, submission(individual, { bytes: PNG, name: "id.png", type: "image/png" }));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("kyc_pending");

    // Pending does not lift the cap yet; the error says so.
    expect((await lock("5.00")).status).toBe(201);
    const pendingBlocked = (await (await lock("1.00")).json()) as { error: { upgrade: { how: string; status: string } } };
    expect(pendingBlocked.error.upgrade.status).toBe("pending");
    expect(pendingBlocked.error.upgrade.how).toMatch(/pending/);

    expect((await app.request("/v1/admin/kyc")).status).toBe(401);
    const queue = (await (await app.request("/v1/admin/kyc?status=pending", { headers: admin })).json()) as {
      pending: number;
      entries: { organizationId: string; organizationName: string; submission: { legalName: string }; hasDocument: boolean }[];
    };
    expect(queue.pending).toBe(1);
    expect(queue.entries[0]).toMatchObject({ organizationId: orgId, organizationName: "Acme KYC", hasDocument: true });
    expect(queue.entries[0]?.submission.legalName).toBe("Ada Lovelace");

    const deleteEarly = await app.request(`/v1/admin/kyc/${orgId}/document`, { method: "DELETE", headers: admin, body: "{}" });
    expect(deleteEarly.status).toBe(409);

    const link = await app.request(`/v1/admin/kyc/${orgId}/document-url`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ reviewer: "Pau" }),
    });
    expect(link.status).toBe(200);
    const signed = (await link.json()) as { url: string; ttlS: number; mimeType: string };
    expect(signed.ttlS).toBeLessThanOrEqual(120);
    expect(signed.mimeType).toBe("application/pdf");
    const preview = await app.request(signed.url);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("application/pdf");
    expect(preview.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(PDF);
    const forged = await app.request(`${signed.url.slice(0, -4)}AAAA`);
    expect(forged.status).toBe(404);

    const rejectNoReason = await app.request(`/v1/admin/kyc/${orgId}/reject`, { method: "POST", headers: admin, body: "{}" });
    expect(rejectNoReason.status).toBe(400);
    const approved = await app.request(`/v1/admin/kyc/${orgId}/approve`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ reviewer: "Pau" }),
    });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { kyc: unknown }).kyc).toMatchObject({ tier: 1, status: "approved", limitUsdc: "50.000000" });
    expect((await lock("20.00")).status).toBe(201);
    const twice = await app.request(`/v1/admin/kyc/${orgId}/approve`, { method: "POST", headers: admin, body: "{}" });
    expect(twice.status).toBe(409);

    const removed = await app.request(`/v1/admin/kyc/${orgId}/document`, {
      method: "DELETE",
      headers: admin,
      body: JSON.stringify({ reviewer: "Pau" }),
    });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { kyc: { document: { deleted: boolean }; tier: number } }).kyc).toMatchObject({
      tier: 1,
      document: { deleted: true },
    });
    expect((await app.request(signed.url)).status).toBe(404);
    expect((await app.request(`/v1/admin/kyc/${orgId}/document-url`, { method: "POST", headers: admin, body: "{}" })).status).toBe(404);

    const audit = (await (await app.request("/v1/admin/kyc", { headers: admin })).json()) as {
      audit: { action: string; actor: string; at: string }[];
    };
    expect(audit.audit.map((entry) => `${entry.action}:${entry.actor}`)).toEqual([
      "document_deleted:admin:Pau",
      "approved:admin:Pau",
      "document_viewed:admin:Pau",
      "submitted:org:" + orgId,
    ]);
  });

  it("lets a rejected applicant resubmit and replaces the old document", async () => {
    const { app, auth, org } = await boot();
    const orgId = org.organization.id;
    expect((await submit(app, auth, submission(individual, { bytes: PNG, name: "a.png", type: "image/png" }))).status).toBe(201);
    const rejected = await app.request(`/v1/admin/kyc/${orgId}/reject`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ reviewer: "Pau", reason: "Document is blurry; upload a sharper photo." }),
    });
    expect(((await rejected.json()) as { kyc: unknown }).kyc).toMatchObject({
      status: "rejected",
      tier: 0,
      rejectionReason: "Document is blurry; upload a sharper photo.",
    });
    const mine = (await (await app.request("/v1/kyc", { headers: auth })).json()) as { kyc: { rejectionReason: string; upgrade: string } };
    expect(mine.kyc.rejectionReason).toMatch(/blurry/);
    expect(mine.kyc.upgrade).toBeTruthy();
    const company = { entityType: "company", legalName: "Acme SL", country: "ES", companyRegNo: "B12345678" };
    expect((await submit(app, auth, submission(company, { bytes: PDF, name: "reg.pdf", type: "application/pdf" }))).status).toBe(201);
  });

  it("expires preview links after the TTL", async () => {
    const clock = { now: new Date("2026-10-05T10:00:00Z") };
    const store = new LocalKycDocumentStore({ now: () => clock.now });
    await store.put("org/doc.pdf", PDF, "application/pdf");
    const { url } = await store.signedUrl("org/doc.pdf", 60);
    const token = url.split("/").pop() ?? "";
    expect(store.read(token)?.mimeType).toBe("application/pdf");
    clock.now = new Date("2026-10-05T10:01:01Z");
    expect(store.read(token)).toBeNull();
  });

  it("persists profiles and audit in the JSON file and the Supabase rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-kyc-"));
    try {
      const file = join(dir, "sandbox.json");
      const store = JsonFileStore.open(file);
      const service = new AgentFinanceService({ mode: "sandbox", store, kycLimits: { tier0Usdc: "5", tier1Usdc: "50" } });
      const created = await service.createOrganization("Persist");
      const orgId = created.organization.id;
      await service.submitKyc(orgId, { entityType: "individual", legalName: "Ada", country: "ES", dateOfBirth: "1990-01-01", companyRegNo: null }, {
        path: `${orgId}/doc.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
        sha256: "00",
        uploadedAt: new Date().toISOString(),
        deletedAt: null,
      });
      await service.reviewKyc(orgId, "approved", "Pau", null);
      const reopened = JsonFileStore.open(file);
      expect(reopened.kycProfiles.get(orgId)).toMatchObject({ status: "approved", tier: 1 });
      expect(reopened.kycAudit.map((entry) => entry.action)).toEqual(["submitted", "approved"]);

      const memory = new MemoryStore();
      for (const [id, value] of reopened.organizations) memory.organizations.set(id, value);
      for (const [id, value] of reopened.kycProfiles) memory.kycProfiles.set(id, value);
      memory.kycAudit.push(...reopened.kycAudit);
      const jobs = new MemoryJobStore();
      const reputation = new MemoryReputationLedger();
      const registry = new CapabilityRegistry();
      const rows = snapshotToRows(captureSnapshot({ store: memory, jobs, reputation, registry, wallet: { balances: [], sequence: 0 } }));
      expect(rows.kyc_profiles?.[0]).toMatchObject({ organization_id: orgId, status: "approved", tier: 1 });
      expect(rows.kyc_audit_log).toHaveLength(2);
      const restored = new MemoryStore();
      applySnapshot({ snapshot: rowsToSnapshot(rows), store: restored, jobs, reputation, registry });
      expect(restored.kycProfiles.get(orgId)?.submission?.legalName).toBe("Ada");
      expect(restored.kycAudit.map((entry) => entry.actor)).toEqual([`org:${orgId}`, "admin:Pau"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("escrow modes", () => {
  it("defaults to custodial-mock and reports it on /health", async () => {
    const { app, lock } = await boot();
    const health = (await (await app.request("/health")).json()) as { escrowMode: string; kyc: { tier0LimitUsdc: string } };
    expect(health.escrowMode).toBe("custodial-mock");
    expect(health.kyc.tier0LimitUsdc).toBe("5.000000");
    const locked = (await (await lock("1.00")).json()) as { escrow: { custody: Record<string, unknown> } };
    expect(locked.escrow.custody).toMatchObject({ mode: "custodial-mock", custodian: "roster", vault: null, buyerAuthorization: null });
  });

  it("noncustodial-sim models a buyer-signed lock into a program vault and still settles", async () => {
    const { app, json, lock } = await boot({ escrowMode: "noncustodial-sim" });
    const health = (await (await app.request("/health")).json()) as { escrowMode: string };
    expect(health.escrowMode).toBe("noncustodial-sim");
    const locked = (await (await lock("2.00")).json()) as {
      escrow: {
        id: string;
        custody: {
          custodian: string;
          programId: string;
          vault: string;
          releaseAuthority: string;
          onChainFeeUsdc: string;
          buyerAuthorization: { signer: string; message: string; signature: string };
        };
      };
    };
    const custody = locked.escrow.custody;
    expect(custody.custodian).toBe("program");
    expect(custody.releaseAuthority).toBe("program-rules");
    expect(custody.vault).toMatch(/^sim-pda:[0-9a-f]{40}$/);
    expect(custody.onChainFeeUsdc).toBe("0.023000");
    expect(custody.buyerAuthorization.message).toContain(`escrow=${locked.escrow.id}`);
    expect(custody.buyerAuthorization.message).toContain("fee=0.023000");
    expect(custody.buyerAuthorization.signature).toMatch(/^sim-ed25519:/);
    const released = await app.request(`/v1/escrows/${locked.escrow.id}/result`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ result: { ok: true } }),
    });
    expect(((await released.json()) as { escrow: { status: string } }).escrow.status).toBe("released");
  });

  it("quotes the on-chain fee as 1% + 0.003 capped at the price", () => {
    expect(quoteOnChainEscrowFee("1.000000")).toBe("0.013000");
    expect(quoteOnChainEscrowFee("0.002000")).toBe("0.002000");
    const message = escrowLockIntent({
      escrowId: "esc_1",
      buyerAddress: "buyer",
      sellerAddress: "seller",
      amountUsdc: "10.000000",
      schema: { type: "object" },
      programId: "prog",
      vault: "vault",
    });
    expect(message.split("\n")[0]).toBe("roster-escrow-lock:v1");
    expect(message).toContain("fee=0.103000");
  });
});

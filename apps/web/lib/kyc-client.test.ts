import { describe, expect, it } from "vitest";
import { kycAuditLabel, kycDocumentHref } from "./admin-client";
import { RosterApiError, describeEscrowMode, kycUsagePercent, readHealth, readKycPayload, rosterErrorMessage } from "./roster-client";

describe("KYC client helpers", () => {
  it("reads a KYC payload defensively", () => {
    const kyc = readKycPayload({
      kyc: {
        tier: 1,
        status: "approved",
        windowDays: 30,
        usedUsdc: "250.000000",
        limitUsdc: "25000.000000",
        remainingUsdc: "24750.000000",
        limits: { tier0Usdc: "1000.000000", tier1Usdc: "25000.000000" },
        submission: { entityType: "company", legalName: "Acme SL", country: "ES", companyRegNo: "B1", submittedAt: "2026-10-05T10:00:00Z" },
        document: { mimeType: "application/pdf", sizeBytes: 1200, uploadedAt: "2026-10-05T10:00:00Z", deleted: true },
        reviewedAt: "2026-10-05T11:00:00Z",
        rejectionReason: null,
        upgrade: null,
      },
    });
    expect(kyc).toMatchObject({ tier: 1, status: "approved", submission: { entityType: "company", dateOfBirth: null }, document: { deleted: true } });
    expect(readKycPayload({ kyc: { status: "weird" } })).toMatchObject({ tier: 0, status: "none", submission: null });
    expect(() => readKycPayload({})).toThrow();
  });

  it("computes usage percent with clamping", () => {
    expect(kycUsagePercent({ usedUsdc: "250.000000", limitUsdc: "1000.000000" })).toBe(25);
    expect(kycUsagePercent({ usedUsdc: "2000", limitUsdc: "1000" })).toBe(100);
    expect(kycUsagePercent({ usedUsdc: "1", limitUsdc: "0" })).toBe(0);
  });

  it("maps signed URLs and audit labels", () => {
    expect(kycDocumentHref("/v1/kyc/documents/abc.def")).toBe("/roster-api/v1/kyc/documents/abc.def");
    const supabase = "https://wbesppsdeyssfqynuezb.supabase.co/storage/v1/object/sign/kyc-documents/org/doc.pdf?token=x";
    expect(kycDocumentHref(supabase)).toBe(supabase);
    expect(kycAuditLabel("document_viewed")).toBe("Document viewed");
  });

  it("reads escrow mode from /health and explains kyc_limit_exceeded", () => {
    expect(readHealth({ version: "abc", escrowMode: "noncustodial-sim" }).escrowMode).toBe("noncustodial-sim");
    expect(readHealth({ version: "abc" }).escrowMode).toBe("custodial-mock");
    expect(describeEscrowMode("noncustodial-sim")).toMatch(/no keys/);
    const error = new RosterApiError(403, "kyc_limit_exceeded", "Over the Tier 0 limit.");
    expect(rosterErrorMessage(error)).toContain("/console/kyc");
  });
});

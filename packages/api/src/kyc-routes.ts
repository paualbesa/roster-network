import { createId } from "@albesa/core";
import type { Env, Hono } from "hono";
import {
  KYC_DOCUMENT_MAX_BYTES,
  KYC_SIGNED_URL_TTL_S,
  KycInputError,
  LocalKycDocumentStore,
  kycDocumentPath,
  normalizeReason,
  normalizeReviewer,
  parseKycSubmission,
  sha256Hex,
  sniffKycDocument,
  type KycDocumentStore,
  type KycStatus,
} from "./kyc.js";
import { ServiceError, type AgentFinanceService } from "./service.js";

export const KYC_SUBMISSION_PATH = "/v1/kyc/submission";
export const KYC_DOCUMENT_TOKEN_RE = /^\/v1\/kyc\/documents\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

interface KycRouteDeps {
  service: AgentFinanceService;
  documents: KycDocumentStore;
  now: () => Date;
}

function invalid(message: string): ServiceError {
  return new ServiceError(400, "invalid_request", message);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw invalid("Expected a JSON body.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function rethrowInput(error: unknown): never {
  if (error instanceof KycInputError) throw invalid(error.message);
  throw error;
}

/** Applicant routes: read tier/usage, submit Tier 1. Mounted behind API-key auth. */
export function registerKycRoutes<E extends Env & { Variables: { orgId: string } }>(app: Hono<E>, deps: KycRouteDeps): void {
  app.get("/v1/kyc", async (c) => {
    const kyc = await deps.service.getKyc(c.get("orgId"));
    return c.json({ kyc });
  });

  app.post(KYC_SUBMISSION_PATH, async (c) => {
    const orgId = c.get("orgId");
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw invalid("Send multipart/form-data with the fields and a `document` file (JPEG, PNG, WebP, or PDF up to 5 MB).");
    }
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw invalid("Could not read the multipart body.");
    }
    const fields: Record<string, unknown> = {};
    for (const key of ["entityType", "legalName", "country", "dateOfBirth", "companyRegNo"]) {
      const value = form.get(key);
      if (typeof value === "string") fields[key] = value;
    }
    let submission;
    try {
      submission = parseKycSubmission(fields, deps.now());
    } catch (error) {
      rethrowInput(error);
    }
    const file = form.get("document");
    if (!file || typeof file === "string") throw invalid("Attach the ID document as the `document` file field.");
    if (file.size === 0) throw invalid("The document is empty.");
    if (file.size > KYC_DOCUMENT_MAX_BYTES) {
      return c.json(
        { error: { code: "payload_too_large", message: "The document must be at most 5 MB." } },
        413,
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = sniffKycDocument(bytes);
    if (!mimeType) throw invalid("The document must be a JPEG, PNG, WebP image or a PDF.");
    await deps.service.assertKycSubmittable(orgId);
    const path = kycDocumentPath(orgId, createId("kycdoc"), mimeType);
    await deps.documents.put(path, bytes, mimeType);
    let result;
    try {
      result = await deps.service.submitKyc(orgId, submission, {
        path,
        mimeType,
        sizeBytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
        uploadedAt: deps.now().toISOString(),
        deletedAt: null,
      });
    } catch (error) {
      await deps.documents.remove(path).catch(() => undefined);
      throw error;
    }
    if (result.replacedDocumentPath) {
      await deps.documents.remove(result.replacedDocumentPath).catch((error: unknown) => {
        console.error(JSON.stringify({ msg: "kyc_document_cleanup_failed", orgId }), error);
      });
    }
    return c.json({ kyc: result.kyc }, 201);
  });

  // Signed preview links for the in-process store (JSON sandbox and tests).
  // Supabase deployments hand out Storage signed URLs instead.
  app.get("/v1/kyc/documents/:token", (c) => {
    if (!(deps.documents instanceof LocalKycDocumentStore)) {
      return c.json({ error: { code: "not_found", message: "Document links are served by Supabase Storage." } }, 404);
    }
    const found = deps.documents.read(c.req.param("token"));
    if (!found) return c.json({ error: { code: "not_found", message: "This document link is invalid or expired." } }, 404);
    return new Response(found.bytes, {
      status: 200,
      headers: {
        "content-type": found.mimeType,
        "cache-control": "no-store, private",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
      },
    });
  });
}

function parseStatus(raw: string | undefined): KycStatus | null {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "all") return null;
  if (value === "pending" || value === "approved" || value === "rejected") return value;
  throw invalid('status must be "pending", "approved", "rejected", or "all".');
}

/** Operator routes under /v1/admin (the admin token gate runs first). */
export function registerKycAdminRoutes<E extends Env>(app: Hono<E>, deps: KycRouteDeps): void {
  app.get("/v1/admin/kyc", async (c) => {
    const queue = await deps.service.listKycQueue(parseStatus(c.req.query("status")));
    const entries = queue.entries.map(({ documentPath, ...entry }) => ({ ...entry, hasDocument: documentPath !== null }));
    return c.json({
      limits: deps.service.kycLimits,
      pending: entries.filter((entry) => entry.status === "pending").length,
      entries,
      audit: queue.audit,
      storage: deps.documents.kind,
    });
  });

  app.post("/v1/admin/kyc/:orgId/document-url", async (c) => {
    const body = await readJsonObject(c.req.raw);
    const reviewer = normalizeReviewer(body.reviewer);
    const opened = await deps.service.openKycDocument(c.req.param("orgId"), reviewer);
    const signed = await deps.documents.signedUrl(opened.path, KYC_SIGNED_URL_TTL_S);
    return c.json({ url: signed.url, expiresAt: signed.expiresAt, mimeType: opened.mimeType, ttlS: KYC_SIGNED_URL_TTL_S });
  });

  app.post("/v1/admin/kyc/:orgId/approve", async (c) => {
    const body = await readJsonObject(c.req.raw);
    const kyc = await deps.service.reviewKyc(c.req.param("orgId"), "approved", normalizeReviewer(body.reviewer), null);
    return c.json({ kyc });
  });

  app.post("/v1/admin/kyc/:orgId/reject", async (c) => {
    const body = await readJsonObject(c.req.raw);
    let reason: string;
    try {
      reason = normalizeReason(body.reason);
    } catch (error) {
      rethrowInput(error);
    }
    const kyc = await deps.service.reviewKyc(c.req.param("orgId"), "rejected", normalizeReviewer(body.reviewer), reason);
    return c.json({ kyc });
  });

  app.delete("/v1/admin/kyc/:orgId/document", async (c) => {
    const body = await readJsonObject(c.req.raw);
    const orgId = c.req.param("orgId");
    const path = await deps.service.kycDocumentForDeletion(orgId);
    await deps.documents.remove(path);
    const kyc = await deps.service.markKycDocumentDeleted(orgId, normalizeReviewer(body.reviewer));
    return c.json({ kyc });
  });
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { formatUsdc, parseUsdc } from "@albesa/core";

/**
 * Tiered free KYC with manual review.
 *
 * Tier 0 is every organization by default (wallet + verified email or API key).
 * Tier 1 needs basic identity data plus one ID document reviewed by an operator.
 * Limits apply to escrow volume the organization locked as buyer over a rolling
 * 30-day window (held + released; refunds do not count).
 *
 * Data minimization: only the fields below are stored. The document lives in a
 * private bucket, is reachable through short-lived signed URLs, and an operator
 * can delete it after review (the review decision and audit trail remain).
 */

export type KycTier = 0 | 1;
export type KycStatus = "none" | "pending" | "approved" | "rejected";
export type KycEntityType = "individual" | "company";

export const KYC_WINDOW_DAYS = 30;
export const KYC_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Multipart overhead allowance on top of the document. */
export const KYC_SUBMISSION_MAX_BODY_BYTES = KYC_DOCUMENT_MAX_BYTES + 64 * 1024;
export const KYC_SIGNED_URL_TTL_S = 60;
export const KYC_BUCKET = "kyc-documents";
export const KYC_DEFAULT_T0_LIMIT_USDC = "1000";
export const KYC_DEFAULT_T1_LIMIT_USDC = "25000";
export const KYC_UPGRADE_HINT =
  "Submit Tier 1 verification (legal name, country, date of birth or company registration number, one ID document) with POST /v1/kyc/submission or in the console at /console/kyc. An operator reviews it manually.";

export type KycDocumentMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export const KYC_DOCUMENT_TYPES: Record<KycDocumentMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export interface KycSubmission {
  entityType: KycEntityType;
  legalName: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string;
  /** YYYY-MM-DD, individuals only. */
  dateOfBirth: string | null;
  /** Companies only. */
  companyRegNo: string | null;
  submittedAt: string;
}

export interface KycDocumentRecord {
  /** Object path inside the private bucket. */
  path: string;
  mimeType: KycDocumentMime;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  deletedAt: string | null;
}

export interface KycProfile {
  organizationId: string;
  status: KycStatus;
  submission: KycSubmission | null;
  document: KycDocumentRecord | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  /** Tier the organization holds. Approved => 1. A rejection after approval does not happen; resubmits start pending. */
  tier: KycTier;
  updatedAt: string;
}

export type KycAuditAction = "submitted" | "approved" | "rejected" | "document_viewed" | "document_deleted";

export interface KycAuditEntry {
  id: string;
  organizationId: string;
  action: KycAuditAction;
  /** `org:<id>` for the applicant, `admin:<reviewer>` for operators. */
  actor: string;
  reason: string | null;
  at: string;
}

export interface KycLimits {
  tier0Usdc: string;
  tier1Usdc: string;
}

export interface KycUsage {
  tier: KycTier;
  status: KycStatus;
  windowDays: number;
  usedUsdc: string;
  limitUsdc: string;
  remainingUsdc: string;
  limits: KycLimits;
}

export class KycInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KycInputError";
  }
}

function readLimit(raw: string | undefined, fallback: string, name: string): string {
  const value = raw?.trim() || fallback;
  let micros: bigint;
  try {
    micros = parseUsdc(value);
  } catch {
    throw new Error(`${name} must be a USDC amount like 1000 or 1000.50.`);
  }
  if (micros <= 0n) throw new Error(`${name} must be positive.`);
  return formatUsdc(micros);
}

/** `ROSTER_KYC_T0_LIMIT_USDC` (default 1000) and `ROSTER_KYC_T1_LIMIT_USDC` (default 25000). */
export function resolveKycLimits(env: Record<string, string | undefined> = process.env): KycLimits {
  const tier0Usdc = readLimit(env.ROSTER_KYC_T0_LIMIT_USDC, KYC_DEFAULT_T0_LIMIT_USDC, "ROSTER_KYC_T0_LIMIT_USDC");
  const tier1Usdc = readLimit(env.ROSTER_KYC_T1_LIMIT_USDC, KYC_DEFAULT_T1_LIMIT_USDC, "ROSTER_KYC_T1_LIMIT_USDC");
  if (parseUsdc(tier1Usdc) < parseUsdc(tier0Usdc)) {
    throw new Error("ROSTER_KYC_T1_LIMIT_USDC must be at least ROSTER_KYC_T0_LIMIT_USDC.");
  }
  return { tier0Usdc, tier1Usdc };
}

export function emptyKycProfile(organizationId: string, now: string): KycProfile {
  return {
    organizationId,
    status: "none",
    submission: null,
    document: null,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    tier: 0,
    updatedAt: now,
  };
}

export function limitForTier(tier: KycTier, limits: KycLimits): string {
  return tier === 1 ? limits.tier1Usdc : limits.tier0Usdc;
}

/** Detect the document type from its first bytes. The declared content type is ignored. */
export function sniffKycDocument(bytes: Uint8Array): KycDocumentMime | null {
  const at = (index: number) => bytes[index] ?? -1;
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 5 && at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d) {
    return "application/pdf";
  }
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const COUNTRY_RE = /^[A-Z]{2}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REG_NO_RE = /^[A-Za-z0-9][A-Za-z0-9 ./-]{1,39}$/;

function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) if (isControl(value.charCodeAt(index))) return true;
  return false;
}

function stripControlChars(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) if (!isControl(value.charCodeAt(index))) out += value[index];
  return out;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Validate applicant fields. Throws {@link KycInputError} with a message safe to return. */
export function parseKycSubmission(
  fields: Record<string, unknown>,
  now: Date,
): Omit<KycSubmission, "submittedAt"> {
  const entityRaw = text(fields.entityType).toLowerCase() || (text(fields.companyRegNo) ? "company" : "individual");
  if (entityRaw !== "individual" && entityRaw !== "company") {
    throw new KycInputError('entityType must be "individual" or "company".');
  }
  const entityType = entityRaw as KycEntityType;
  const legalName = text(fields.legalName).replace(/\s+/g, " ");
  if (legalName.length < 2 || legalName.length > 160) {
    throw new KycInputError("legalName must be 2-160 characters.");
  }
  if (hasControlChars(legalName) || /[<>]/.test(legalName)) throw new KycInputError("legalName contains unsupported characters.");
  const country = text(fields.country).toUpperCase();
  if (!COUNTRY_RE.test(country)) throw new KycInputError("country must be an ISO 3166-1 alpha-2 code like ES.");
  if (entityType === "individual") {
    const dateOfBirth = text(fields.dateOfBirth);
    const match = DATE_RE.exec(dateOfBirth);
    if (!match) throw new KycInputError("dateOfBirth must be YYYY-MM-DD for an individual.");
    const parsed = new Date(`${dateOfBirth}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateOfBirth) {
      throw new KycInputError("dateOfBirth is not a valid date.");
    }
    const eighteen = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
    if (parsed > eighteen) throw new KycInputError("The applicant must be at least 18 years old.");
    if (parsed.getUTCFullYear() < 1900) throw new KycInputError("dateOfBirth is too far in the past.");
    return { entityType, legalName, country, dateOfBirth, companyRegNo: null };
  }
  const companyRegNo = text(fields.companyRegNo);
  if (!REG_NO_RE.test(companyRegNo)) {
    throw new KycInputError("companyRegNo must be 2-40 letters, digits, spaces, dots, slashes, or dashes.");
  }
  return { entityType, legalName, country, dateOfBirth: null, companyRegNo };
}

export function normalizeReviewer(raw: unknown): string {
  const value = text(raw).replace(/\s+/g, " ").slice(0, 80);
  if (!value) return "operator";
  return stripControlChars(value).replace(/[<>]/g, "");
}

export function normalizeReason(raw: unknown): string {
  const value = text(raw).replace(/\s+/g, " ");
  if (value.length < 3 || value.length > 500) throw new KycInputError("reason must be 3-500 characters.");
  return stripControlChars(value);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface KycSignedUrl {
  url: string;
  expiresAt: string;
}

/** Private document storage. Implementations never expose a public URL. */
export interface KycDocumentStore {
  readonly kind: "memory" | "local" | "supabase";
  put(path: string, bytes: Uint8Array, mimeType: KycDocumentMime): Promise<void>;
  signedUrl(path: string, ttlSeconds: number): Promise<KycSignedUrl>;
  remove(path: string): Promise<void>;
}

/**
 * In-process store for tests and the JSON sandbox. Preview links are HMAC-signed
 * API paths (`/v1/kyc/documents/<token>`) that expire after the TTL.
 */
export class LocalKycDocumentStore implements KycDocumentStore {
  readonly kind: "memory" | "local";
  private readonly memory = new Map<string, { bytes: Uint8Array; mimeType: KycDocumentMime }>();
  private readonly secret: Buffer;

  constructor(
    private readonly options: { directory?: string; now?: () => Date; secret?: string } = {},
  ) {
    this.kind = options.directory ? "local" : "memory";
    this.secret = options.secret ? Buffer.from(options.secret, "utf8") : randomBytes(32);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private file(path: string): string {
    const root = resolve(this.options.directory ?? ".");
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) throw new Error("KYC document path escapes the store.");
    return target;
  }

  async put(path: string, bytes: Uint8Array, mimeType: KycDocumentMime): Promise<void> {
    if (this.options.directory) {
      const target = this.file(path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
      writeFileSync(`${target}.type`, mimeType, { mode: 0o600 });
      return;
    }
    this.memory.set(path, { bytes: Uint8Array.from(bytes), mimeType });
  }

  async signedUrl(path: string, ttlSeconds: number): Promise<KycSignedUrl> {
    const expires = Math.floor(this.now().getTime() / 1000) + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ p: path, e: expires }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return {
      url: `/v1/kyc/documents/${payload}.${signature}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  /** Resolve a preview token. Null when it is forged, expired, or the document is gone. */
  read(token: string): { bytes: Uint8Array; mimeType: KycDocumentMime } | null {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const presented = Buffer.from(signature, "base64url");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    } catch {
      return null;
    }
    if (typeof decoded !== "object" || decoded === null) return null;
    const { p, e } = decoded as { p?: unknown; e?: unknown };
    if (typeof p !== "string" || typeof e !== "number") return null;
    if (e * 1000 < this.now().getTime()) return null;
    if (this.options.directory) {
      const target = this.file(p);
      if (!existsSync(target)) return null;
      const mimeType = (existsSync(`${target}.type`) ? readFileSync(`${target}.type`, "utf8") : "application/pdf") as KycDocumentMime;
      return { bytes: readFileSync(target), mimeType };
    }
    return this.memory.get(p) ?? null;
  }

  has(path: string): boolean {
    if (this.options.directory) return existsSync(this.file(path));
    return this.memory.has(path);
  }

  async remove(path: string): Promise<void> {
    if (this.options.directory) {
      const target = this.file(path);
      rmSync(target, { force: true });
      rmSync(`${target}.type`, { force: true });
      return;
    }
    this.memory.delete(path);
  }
}

/** Minimal slice of supabase-js Storage used here (keeps tests free of the SDK). */
export interface SupabaseStorageLike {
  from(bucket: string): {
    upload(
      path: string,
      body: Uint8Array | Blob | ArrayBuffer,
      options: { contentType: string; upsert: boolean; cacheControl?: string },
    ): Promise<{ error: { message: string } | null }>;
    createSignedUrl(path: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
    remove(paths: string[]): Promise<{ error: { message: string } | null }>;
  };
}

/** Private Supabase Storage bucket. Uses the service role; links are signed and short-lived. */
export class SupabaseKycDocumentStore implements KycDocumentStore {
  readonly kind = "supabase" as const;

  constructor(
    private readonly storage: SupabaseStorageLike,
    private readonly bucket: string = KYC_BUCKET,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async put(path: string, bytes: Uint8Array, mimeType: KycDocumentMime): Promise<void> {
    const { error } = await this.storage
      .from(this.bucket)
      .upload(path, bytes, { contentType: mimeType, upsert: false, cacheControl: "0" });
    if (error) throw new Error(`KYC document upload failed: ${error.message}`);
  }

  async signedUrl(path: string, ttlSeconds: number): Promise<KycSignedUrl> {
    const { data, error } = await this.storage.from(this.bucket).createSignedUrl(path, ttlSeconds);
    if (error || !data) throw new Error(`KYC signed URL failed: ${error?.message ?? "no data"}`);
    return { url: data.signedUrl, expiresAt: new Date(this.now().getTime() + ttlSeconds * 1000).toISOString() };
  }

  async remove(path: string): Promise<void> {
    const { error } = await this.storage.from(this.bucket).remove([path]);
    if (error) throw new Error(`KYC document delete failed: ${error.message}`);
  }
}

export function kycDocumentPath(organizationId: string, documentId: string, mimeType: KycDocumentMime): string {
  return join(organizationId, `${documentId}.${KYC_DOCUMENT_TYPES[mimeType]}`).split(sep).join("/");
}

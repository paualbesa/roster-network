import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/**
 * Sandbox account passwords. New hashes use scrypt with a per-user salt:
 * `scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>`.
 * Older rows hold an unsalted SHA-256 hex digest. They still verify, and the
 * caller should store `hashPassword(password)` again when `needsRehash` is true.
 */
const SCRYPT_PREFIX = "scrypt";
const DEFAULT_COST = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const LEGACY_SHA256_RE = /^[0-9a-f]{64}$/;

export interface PasswordCheck {
  ok: boolean;
  /** True when the stored hash is legacy SHA-256 or uses weaker scrypt parameters. */
  needsRehash: boolean;
}

function scrypt(password: string, salt: Buffer, cost: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N: cost.N, r: cost.r, p: cost.p, maxmem: 128 * cost.N * cost.r * 2 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, DEFAULT_COST);
  return [
    SCRYPT_PREFIX,
    DEFAULT_COST.N.toString(),
    DEFAULT_COST.r.toString(),
    DEFAULT_COST.p.toString(),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export function isLegacyPasswordHash(stored: string): boolean {
  return LEGACY_SHA256_RE.test(stored);
}

export async function verifyPassword(stored: string, password: string): Promise<PasswordCheck> {
  if (isLegacyPasswordHash(stored)) {
    const presented = createHash("sha256").update(password, "utf8").digest("hex");
    return { ok: constantTimeEqual(Buffer.from(stored, "utf8"), Buffer.from(presented, "utf8")), needsRehash: true };
  }
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return { ok: false, needsRehash: false };
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0) || N > 1 << 20 || r > 32 || p > 16) {
    return { ok: false, needsRehash: false };
  }
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return { ok: false, needsRehash: false };
  const key = await scrypt(password, salt, { N, r, p });
  const ok = constantTimeEqual(key, expected);
  const weaker = N < DEFAULT_COST.N || r < DEFAULT_COST.r || p < DEFAULT_COST.p;
  return { ok, needsRehash: ok && weaker };
}

/** Burn the same work as a real check so unknown emails do not answer faster. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await scrypt(password, Buffer.alloc(SALT_BYTES), DEFAULT_COST);
}

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

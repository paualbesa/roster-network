export type WaitlistError = "invalid_body" | "invalid_email" | "invalid_role";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["developer", "operator"]);

/** Accept a short waitlist payload. The address is checked and then dropped. */
export function parseWaitlist(body: unknown): { ok: true } | { ok: false; error: WaitlistError } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid_body" };
  const record = body as Record<string, unknown>;
  const email = record.email;
  const role = record.role;
  if (typeof email !== "string" || !isWaitlistEmail(email)) return { ok: false, error: "invalid_email" };
  if (typeof role !== "string" || !ROLES.has(role)) return { ok: false, error: "invalid_role" };
  return { ok: true };
}

export function isWaitlistEmail(value: string): boolean {
  const email = value.trim();
  return email.length > 0 && email.length <= 254 && EMAIL.test(email);
}

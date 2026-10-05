export type WaitlistError = "invalid_body" | "invalid_email" | "invalid_role";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["developer", "operator"]);

export type WaitlistRole = "developer" | "operator";

/** Accept a short waitlist payload. The API stores the trimmed address with `landing:<role>` as the source. */
export function parseWaitlist(
  body: unknown,
): { ok: true; email: string; role: WaitlistRole } | { ok: false; error: WaitlistError } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid_body" };
  const record = body as Record<string, unknown>;
  const email = record.email;
  const role = record.role;
  if (typeof email !== "string" || !isWaitlistEmail(email)) return { ok: false, error: "invalid_email" };
  if (typeof role !== "string" || !ROLES.has(role)) return { ok: false, error: "invalid_role" };
  return { ok: true, email: email.trim(), role: role as WaitlistRole };
}

export function isWaitlistEmail(value: string): boolean {
  const email = value.trim();
  return email.length > 0 && email.length <= 254 && EMAIL.test(email);
}

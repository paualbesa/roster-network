/** HttpOnly cookie that carries the operator token to the same-origin proxy. */
export const ADMIN_COOKIE_NAME = "roster_admin_token";

export const ADMIN_COOKIE_MAX_AGE = 12 * 60 * 60;

export function parseAdminTokenInput(value: unknown): { ok: true; token: string } | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  const token = value.trim();
  if (token.length < 1 || token.length > 256) return { ok: false };
  if (/[\r\n;]/.test(token)) return { ok: false };
  return { ok: true, token };
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const raw = trimmed.slice(eq + 1);
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function readAdminCookie(header: string | null): string | null {
  return readCookie(header, ADMIN_COOKIE_NAME);
}

export function requestIsSecure(url: string, forwardedProto: string | null): boolean {
  const forwarded = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "https") return true;
  if (forwarded === "http") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function isAdminProxyPath(segments: readonly string[]): boolean {
  return segments[0] === "v1" && segments[1] === "admin";
}

/** Header the proxy sends upstream. Prefers an explicit header over the operator cookie. */
export function adminUpstreamToken(headers: Headers): string | null {
  const direct = headers.get("x-roster-admin-token")?.trim() ?? "";
  if (direct) return direct;
  return readAdminCookie(headers.get("cookie"));
}

const FORWARD_REQUEST = ["authorization", "content-type", "accept", "idempotency-key", "x-request-id"] as const;

/**
 * Client address headers for the API rate limiter. roster-api only listens on
 * 127.0.0.1, so it trusts what this proxy sends. Cloudflare sets cf-connecting-ip.
 */
export function forwardClientAddress(requestHeaders: Headers, headers: Headers): void {
  const cf = requestHeaders.get("cf-connecting-ip")?.trim();
  const forwarded = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = requestHeaders.get("x-real-ip")?.trim();
  const address = cf || forwarded || real;
  if (cf) headers.set("cf-connecting-ip", cf);
  if (address) headers.set("x-forwarded-for", address);
}

export function buildProxyHeaders(requestHeaders: Headers, segments: readonly string[]): Headers {
  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = requestHeaders.get(name);
    if (value) headers.set(name, value);
  }
  forwardClientAddress(requestHeaders, headers);
  if (isAdminProxyPath(segments)) {
    const token = adminUpstreamToken(requestHeaders);
    if (token) headers.set("x-roster-admin-token", token);
  }
  return headers;
}

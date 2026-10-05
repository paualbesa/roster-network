import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

/**
 * Browser origins allowed to call the API directly.
 *
 * The web console should prefer a same-origin Next.js proxy on
 * https://roster.network: the page calls its own host, and Next rewrites
 * that path to this process. Direct calls remain allowed from the production
 * site and from local dev servers.
 */
export function isRosterCorsOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
  if (url.hostname === "roster.network") {
    return url.protocol === "https:" && (url.port === "" || url.port === "443");
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return false;
  return url.protocol === "http:" || url.protocol === "https:";
}

export function rosterCors(): MiddlewareHandler {
  return cors({
    origin: (origin) => (isRosterCorsOrigin(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
    exposeHeaders: [
      "X-Request-Id",
      "Retry-After",
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
      "Idempotent-Replayed",
    ],
    maxAge: 86400,
  });
}

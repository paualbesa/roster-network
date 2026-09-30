/** Browser calls stay on this origin. The route handler forwards them to the Roster API. */
export const ROSTER_BROWSER_API_BASE = "/roster-api";

/** Local default when neither env var is set. Production should point this at the API process. */
export const DEFAULT_ROSTER_API_ORIGIN = "http://127.0.0.1:7001";

/**
 * Upstream origin for the `/roster-api` proxy.
 * `ROSTER_API_URL` is read at request time. `NEXT_PUBLIC_ROSTER_API_URL` is the documented build env.
 */
export function resolveRosterApiOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.ROSTER_API_URL?.trim() || env.NEXT_PUBLIC_ROSTER_API_URL?.trim() || DEFAULT_ROSTER_API_ORIGIN;
  return normalizeRosterApiOrigin(raw);
}

export function normalizeRosterApiOrigin(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Roster API URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Roster API URL must be http or https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Roster API URL cannot include credentials, a query, or a hash.");
  }
  const path = url.pathname.replace(/\/$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

/** Join a fixed upstream with a decoded path. Rejects traversal and unexpected characters. */
export function rosterProxyTarget(origin: string, segments: readonly string[], search: string): string {
  const base = normalizeRosterApiOrigin(origin);
  if (segments.length === 0) throw new Error("Roster API path is required.");
  const safe = segments.map((segment) => {
    if (segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/.test(segment)) {
      throw new Error("Roster API path is not allowed.");
    }
    return segment;
  });
  if (search !== "" && !/^\?[A-Za-z0-9._~%=&+,:-]*$/.test(search)) {
    throw new Error("Roster API query is not allowed.");
  }
  return `${base}/${safe.join("/")}${search}`;
}

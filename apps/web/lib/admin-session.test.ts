import { describe, expect, it } from "vitest";
import {
  ADMIN_COOKIE_NAME,
  adminUpstreamToken,
  buildProxyHeaders,
  isAdminProxyPath,
  parseAdminTokenInput,
  readAdminCookie,
  requestIsSecure,
} from "./admin-session";

describe("admin operator cookie", () => {
  it("accepts a trimmed token and rejects blank or broken values", () => {
    expect(parseAdminTokenInput("  sandbox-operator  ")).toEqual({ ok: true, token: "sandbox-operator" });
    expect(parseAdminTokenInput("")).toEqual({ ok: false });
    expect(parseAdminTokenInput("line\nbreak")).toEqual({ ok: false });
    expect(parseAdminTokenInput(12)).toEqual({ ok: false });
  });

  it("reads the operator cookie and ignores other cookies", () => {
    expect(readAdminCookie(`theme=dark; ${ADMIN_COOKIE_NAME}=${encodeURIComponent("ops token")}`)).toBe("ops token");
    expect(readAdminCookie("theme=dark")).toBeNull();
    expect(readAdminCookie(null)).toBeNull();
  });

  it("treats https and x-forwarded-proto as secure", () => {
    expect(requestIsSecure("http://127.0.0.1:7000/admin", "https")).toBe(true);
    expect(requestIsSecure("http://127.0.0.1:7000/admin", "http")).toBe(false);
    expect(requestIsSecure("https://roster.network/admin", null)).toBe(true);
    expect(requestIsSecure("http://127.0.0.1:3000/admin", null)).toBe(false);
  });
});

describe("admin proxy headers", () => {
  it("forwards the operator cookie only on admin paths", () => {
    const headers = new Headers({
      cookie: `${ADMIN_COOKIE_NAME}=sandbox-operator`,
      authorization: "Bearer user-key",
      accept: "application/json",
    });
    const admin = buildProxyHeaders(headers, ["v1", "admin", "overview"]);
    expect(admin.get("x-roster-admin-token")).toBe("sandbox-operator");
    expect(admin.get("authorization")).toBe("Bearer user-key");
    expect(admin.get("cookie")).toBeNull();

    const jobs = buildProxyHeaders(headers, ["v1", "jobs"]);
    expect(jobs.get("x-roster-admin-token")).toBeNull();
    expect(jobs.get("authorization")).toBe("Bearer user-key");
  });

  it("prefers an explicit admin header over the cookie", () => {
    const headers = new Headers({
      cookie: `${ADMIN_COOKIE_NAME}=from-cookie`,
      "x-roster-admin-token": "from-header",
    });
    expect(adminUpstreamToken(headers)).toBe("from-header");
    expect(isAdminProxyPath(["v1", "admin", "jobs", "expire"])).toBe(true);
    expect(isAdminProxyPath(["health"])).toBe(false);
  });
});

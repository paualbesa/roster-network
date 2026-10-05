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

  it("forwards the client address, Idempotency-Key, and request id upstream", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "203.0.113.7, 172.68.0.1",
      "idempotency-key": "job-1",
      "x-request-id": "trace-12345678",
      cookie: "other=1",
    });
    const forwarded = buildProxyHeaders(headers, ["v1", "jobs"]);
    expect(forwarded.get("cf-connecting-ip")).toBe("203.0.113.7");
    expect(forwarded.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(forwarded.get("idempotency-key")).toBe("job-1");
    expect(forwarded.get("x-request-id")).toBe("trace-12345678");
    expect(forwarded.get("cookie")).toBeNull();

    const bare = buildProxyHeaders(new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }), ["v1", "jobs"]);
    expect(bare.get("x-forwarded-for")).toBe("198.51.100.4");
    expect(bare.get("cf-connecting-ip")).toBeNull();
  });
});

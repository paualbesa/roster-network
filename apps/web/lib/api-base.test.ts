import { describe, expect, it } from "vitest";
import { normalizeRosterApiOrigin, resolveRosterApiOrigin, rosterProxyTarget } from "./api-base";

describe("Roster API origin", () => {
  it("defaults to the local sandbox API on port 7001", () => {
    expect(resolveRosterApiOrigin({})).toBe("http://127.0.0.1:7001");
  });

  it("prefers the server env over the public build env", () => {
    expect(
      resolveRosterApiOrigin({
        ROSTER_API_URL: "http://127.0.0.1:8787/",
        NEXT_PUBLIC_ROSTER_API_URL: "http://127.0.0.1:7001",
      }),
    ).toBe("http://127.0.0.1:8787");
  });

  it("keeps an https origin and drops a trailing slash", () => {
    expect(normalizeRosterApiOrigin("https://api.roster.network/sandbox/")).toBe(
      "https://api.roster.network/sandbox",
    );
  });

  it("rejects credentials and non-http URLs", () => {
    expect(() => normalizeRosterApiOrigin("http://user:pass@127.0.0.1:7001")).toThrow(/credentials/);
    expect(() => normalizeRosterApiOrigin("file:///tmp/api")).toThrow(/http/);
  });
});

describe("rosterProxyTarget", () => {
  it("builds a same-path upstream URL and keeps a search string", () => {
    expect(
      rosterProxyTarget("http://127.0.0.1:7001", ["v1", "registry", "search"], "?q=parse+receipts&semantic=1"),
    ).toBe("http://127.0.0.1:7001/v1/registry/search?q=parse+receipts&semantic=1");
  });

  it("rejects traversal and an empty path", () => {
    expect(() => rosterProxyTarget("http://127.0.0.1:7001", ["..", "v1"], "")).toThrow(/not allowed/);
    expect(() => rosterProxyTarget("http://127.0.0.1:7001", [], "")).toThrow(/required/);
    expect(() => rosterProxyTarget("http://127.0.0.1:7001", ["v1"], "?q=a b")).toThrow(/query/);
  });
});

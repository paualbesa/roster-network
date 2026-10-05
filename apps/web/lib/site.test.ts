import { describe, expect, it } from "vitest";
import { normalizeSiteUrl } from "./site";

describe("site URL", () => {
  it("keeps only an http(s) origin", () => {
    expect(normalizeSiteUrl("https://roster.network/")).toBe("https://roster.network");
    expect(normalizeSiteUrl(" https://roster.network/docs ")).toBe("https://roster.network");
    expect(normalizeSiteUrl("")).toBeNull();
    expect(normalizeSiteUrl(undefined)).toBeNull();
    expect(normalizeSiteUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeSiteUrl("not a url")).toBeNull();
  });
});

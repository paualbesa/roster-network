import { describe, expect, it } from "vitest";
import { readPublicSupabaseEnv } from "./config";

describe("public Supabase env", () => {
  it("stays off when nothing is set", () => {
    expect(readPublicSupabaseEnv({})).toBeNull();
  });

  it("accepts the public names and the server names", () => {
    expect(
      readPublicSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: " https://example.supabase.co ",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: " anon ",
      }),
    ).toEqual({ url: "https://example.supabase.co", anonKey: "anon" });
    expect(readPublicSupabaseEnv({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon" })).toEqual({
      url: "https://example.supabase.co",
      anonKey: "anon",
    });
  });

  it("refuses a url without an anon key", () => {
    expect(() => readPublicSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" })).toThrow(
      /ANON_KEY/,
    );
  });
});

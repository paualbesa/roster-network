import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEMANTIC_DIMENSIONS } from "@albesa/registry";
import { describe, expect, it } from "vitest";
import { readSupabaseConfig } from "./env.js";
import { toVectorLiteral } from "./vector.js";

describe("Supabase env", () => {
  it("keeps the JSON files when every variable is unset", () => {
    expect(readSupabaseConfig({})).toBeNull();
  });

  it("refuses a partial configuration", () => {
    expect(() => readSupabaseConfig({ SUPABASE_URL: "https://example.supabase.co" })).toThrow(/all be set/);
    expect(() =>
      readSupabaseConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_ANON_KEY: "anon",
      }),
    ).toThrow(/SERVICE_ROLE_KEY/);
  });

  it("reads the three server variables and trims them", () => {
    expect(
      readSupabaseConfig({
        SUPABASE_URL: " https://example.supabase.co ",
        SUPABASE_ANON_KEY: " anon ",
        SUPABASE_SERVICE_ROLE_KEY: " service ",
      }),
    ).toEqual({
      url: "https://example.supabase.co",
      anonKey: "anon",
      serviceRoleKey: "service",
    });
  });
});

describe("pgvector width", () => {
  it("matches the registry embedding and the migration", () => {
    const literal = toVectorLiteral(new Float64Array([0.5, -0.25]));
    expect(literal.split(",")).toHaveLength(SEMANTIC_DIMENSIONS);
    expect(literal.startsWith("[0.5,-0.25,")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);

    const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const sql = readFileSync(join(root, "supabase/migrations/20261001120000_roster_core.sql"), "utf8");
    expect(sql).toContain(`vector(${SEMANTIC_DIMENSIONS.toString()})`);
    expect(sql).toContain("using hnsw (embedding vector_cosine_ops)");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("private.current_organization_id");
    expect(sql).not.toContain("service_role_key");
  });
});

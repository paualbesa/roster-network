import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runScenarios } from "./simulate/scenarios.js";
import { readSupabaseConfig } from "./supabase/env.js";
import { openJsonWorld, openMemoryWorld, openPostgresWorld } from "./simulate/worlds.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function postgresConfig(): ReturnType<typeof readSupabaseConfig> | Error {
  try {
    return readSupabaseConfig();
  } catch (error) {
    return error instanceof Error ? error : new Error("Invalid Supabase configuration.");
  }
}

describe("sandbox simulation", () => {
  it("passes against the in-memory store", async () => {
    const report = await runScenarios(openMemoryWorld());
    expect(report.results.filter((result) => result.status === "fail")).toEqual([]);
  });

  it("passes against the JSON files and reloads them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "roster-sim-test-"));
    directories.push(directory);
    const world = openJsonWorld(directory);
    const report = await runScenarios(world);
    expect(report.results.find((result) => result.name === "reload")?.status).toBe("pass");
    expect(report.results.filter((result) => result.status === "fail")).toEqual([]);
  });

  const supabase = postgresConfig();
  it.skipIf(supabase === null)("passes against Postgres when SUPABASE_* is set", async () => {
    if (supabase instanceof Error) throw supabase;
    if (supabase === null) return;
    const report = await runScenarios(await openPostgresWorld(supabase));
    expect(report.results.filter((result) => result.status === "fail")).toEqual([]);
  });
});

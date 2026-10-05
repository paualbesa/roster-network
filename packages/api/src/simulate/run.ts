import { readSupabaseConfig } from "../supabase/env.js";
import { countReport, formatReport, type ScenarioReport, type ScenarioResult } from "./scenarios.js";
import { runScenarios } from "./scenarios.js";
import { joinApiUrl, openJsonWorld, openLiveWorld, openMemoryWorld, openPostgresWorld } from "./worlds.js";

const PILLAR_PATHS = ["/v1/registry/search", "/v1/jobs", "/v1/escrows", "/v1/escrow/settle", "/v1/agents/{agentId}/passport"];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Roster sandbox simulation

  pnpm simulate
  pnpm simulate -- --base-url https://roster.network/roster-api
  pnpm simulate -- --base-url https://roster.network/roster-api --execute

The default run uses the in-memory store and a temporary JSON store.
Postgres runs only when SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are all set.
--base-url is a read-only sandbox probe. --execute replays the full suite against that API
and refuses anything other than mode=sandbox on the mock or base-sim rail.`);
    return;
  }

  const reports: ScenarioReport[] = [];
  const memory = openMemoryWorld();
  reports.push(await runScenarios(memory));
  const json = openJsonWorld();
  try {
    reports.push(await runScenarios(json));
  } finally {
    await json.close?.();
  }

  const supabase = readPostgresConfig();
  if (supabase instanceof Error) {
    reports.push({
      world: "postgres",
      results: [{ name: "config", status: "fail", detail: supabase.message }],
    });
  } else if (supabase === null) {
    reports.push({
      world: "postgres",
      results: [
        {
          name: "suite",
          status: "skip",
          detail: "SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are unset",
        },
      ],
    });
  } else {
    const postgres = await openPostgresWorld(supabase);
    reports.push(await runScenarios(postgres));
  }

  if (!args.baseUrl) {
    reports.push({
      world: "live",
      results: [{ name: "suite", status: "skip", detail: "pass --base-url to probe a sandbox API" }],
    });
  } else if (args.execute) {
    reports.push(await executeLive(args.baseUrl));
  } else {
    reports.push(await probeLive(args.baseUrl));
  }

  console.log("Roster sandbox simulation\n");
  console.log(reports.map((report) => formatReport(report)).join("\n\n"));
  const totals = countReport(reports);
  console.log(
    `\n${totals.passed.toString()} passed, ${totals.failed.toString()} failed, ${totals.skipped.toString()} skipped`,
  );
  if (totals.failed > 0) process.exitCode = 1;
}

async function executeLive(baseUrl: string): Promise<ScenarioReport> {
  const gate = await readHealth(baseUrl);
  if (gate.status === "fail") return { world: "live", results: [gate] };
  if (gate.detail?.includes("rail solana-sim")) {
    return {
      world: "live",
      results: [{ name: "health", status: "fail", detail: "solana-sim rail cannot settle. Refusing --execute." }],
    };
  }
  return runScenarios(openLiveWorld(baseUrl));
}

async function probeLive(baseUrl: string): Promise<ScenarioReport> {
  const results: ScenarioResult[] = [];
  results.push(await readHealth(baseUrl));
  results.push(await readOpenApi(baseUrl));
  results.push(await expectPublicSearch(baseUrl));
  results.push(await expectUnauthorized(baseUrl, "/v1/jobs"));
  results.push(await expectUnauthorized(baseUrl, "/v1/jobs", "POST"));
  results.push(await expectJsonNotFound(baseUrl));
  const failed = results.some((result) => result.status === "fail");
  if (!failed) {
    results.push({
      name: "read-only",
      status: "pass",
      detail: "no organizations or escrow writes. Pass --execute to run the suite against this sandbox API.",
    });
  }
  return { world: "live", results };
}

async function readHealth(baseUrl: string): Promise<ScenarioResult> {
  try {
    const response = await fetch(joinApiUrl(baseUrl, "/health"));
    if (!response.ok) return { name: "health", status: "fail", detail: `HTTP ${response.status.toString()}` };
    const body = (await response.json()) as { ok?: boolean; product?: string; mode?: string; rail?: string; asset?: string };
    if (body.product !== "Roster" || body.ok !== true || body.asset !== "USDC") {
      return { name: "health", status: "fail", detail: "response is not the Roster USDC API" };
    }
    if (body.mode === "mainnet") {
      return { name: "health", status: "fail", detail: "refusing mainnet" };
    }
    if (body.mode !== "sandbox") {
      return { name: "health", status: "fail", detail: `mode ${body.mode ?? "missing"} is not sandbox` };
    }
    if (body.rail !== "mock" && body.rail !== "base-sim" && body.rail !== "solana-sim") {
      return { name: "health", status: "fail", detail: `rail ${body.rail ?? "missing"} is not a sandbox rail` };
    }
    return { name: "health", status: "pass", detail: `mode sandbox, rail ${body.rail}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "health request failed";
    return { name: "health", status: "fail", detail };
  }
}

async function readOpenApi(baseUrl: string): Promise<ScenarioResult> {
  try {
    const response = await fetch(joinApiUrl(baseUrl, "/openapi.json"));
    if (!response.ok) return { name: "openapi", status: "fail", detail: `HTTP ${response.status.toString()}` };
    const body = (await response.json()) as { paths?: Record<string, unknown> };
    const missing = PILLAR_PATHS.filter((path) => body.paths?.[path] === undefined);
    if (missing.length > 0) return { name: "openapi", status: "fail", detail: `missing ${missing.join(", ")}` };
    return { name: "openapi", status: "pass" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "openapi request failed";
    return { name: "openapi", status: "fail", detail };
  }
}

async function expectUnauthorized(baseUrl: string, path: string, method = "GET"): Promise<ScenarioResult> {
  try {
    const response = await fetch(joinApiUrl(baseUrl, path), method === "GET" ? undefined : { method });
    if (response.status !== 401) {
      return { name: `auth ${method} ${path}`, status: "fail", detail: `expected 401, got ${response.status.toString()}` };
    }
    return { name: `auth ${method} ${path}`, status: "pass" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "auth probe failed";
    return { name: `auth ${method} ${path}`, status: "fail", detail };
  }
}

async function expectPublicSearch(baseUrl: string): Promise<ScenarioResult> {
  const name = "public GET /v1/registry/search";
  try {
    const response = await fetch(joinApiUrl(baseUrl, "/v1/registry/search?q=receipt&limit=5"));
    if (response.status !== 200) return { name, status: "fail", detail: `expected 200, got ${response.status.toString()}` };
    const body = (await response.json()) as { hits?: unknown };
    if (!Array.isArray(body.hits)) return { name, status: "fail", detail: "response has no hits array" };
    if (!response.headers.get("x-request-id")) return { name, status: "fail", detail: "missing X-Request-Id" };
    return { name, status: "pass", detail: `${body.hits.length.toString()} hits` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "search probe failed";
    return { name, status: "fail", detail };
  }
}

async function expectJsonNotFound(baseUrl: string): Promise<ScenarioResult> {
  const name = "404 JSON";
  try {
    const response = await fetch(joinApiUrl(baseUrl, "/no-such-route"));
    const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    if (response.status !== 404 || body?.error?.code !== "not_found") {
      return { name, status: "fail", detail: `got ${response.status.toString()} ${body?.error?.code ?? "non-JSON"}` };
    }
    return { name, status: "pass" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "404 probe failed";
    return { name, status: "fail", detail };
  }
}

function readPostgresConfig(): ReturnType<typeof readSupabaseConfig> | Error {
  try {
    return readSupabaseConfig();
  } catch (error) {
    return error instanceof Error ? error : new Error("Invalid Supabase configuration.");
  }
}

function parseArgs(argv: string[]): { help: boolean; execute: boolean; baseUrl: string | null } {
  let help = false;
  let execute = false;
  let baseUrl: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // `pnpm simulate -- --base-url …` forwards the separator on pnpm 10.
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--execute") execute = true;
    else if (arg === "--base-url") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--base-url requires an API origin.");
      baseUrl = next;
      index += 1;
    } else if (arg?.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length);
    } else if (arg) {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("--base-url must be an http(s) URL.");
    }
  }
  return { help, execute, baseUrl };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "simulation failed";
  console.error(message);
  process.exitCode = 1;
});

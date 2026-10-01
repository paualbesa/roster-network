import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const configPath = join(root, "ecosystem.config.cjs");

interface Pm2App {
  name: string;
  cwd: string;
  script: string;
  args?: string;
  env: Record<string, string | undefined>;
}

describe("PM2 ecosystem", () => {
  const previousDataDir = process.env.ROSTER_DATA_DIR;
  const previousAdminToken = process.env.ROSTER_ADMIN_TOKEN;
  const previousSupabaseUrl = process.env.SUPABASE_URL;
  const previousSupabaseAnon = process.env.SUPABASE_ANON_KEY;
  const previousSupabaseService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const previousPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousPublicAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  afterEach(() => {
    restoreEnv("ROSTER_DATA_DIR", previousDataDir);
    restoreEnv("ROSTER_ADMIN_TOKEN", previousAdminToken);
    restoreEnv("SUPABASE_URL", previousSupabaseUrl);
    restoreEnv("SUPABASE_ANON_KEY", previousSupabaseAnon);
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", previousSupabaseService);
    restoreEnv("NEXT_PUBLIC_SUPABASE_URL", previousPublicUrl);
    restoreEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", previousPublicAnon);
    delete require.cache[configPath];
  });

  it("keeps the marketing site and adds roster-api on loopback port 7001", () => {
    delete process.env.ROSTER_DATA_DIR;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const apps = loadApps();
    const web = apps.find((app) => app.name === "roster-web");
    const api = apps.find((app) => app.name === "roster-api");
    expect(web?.env.PORT).toBe("7000");
    expect(web?.args).toContain("7000");
    expect(api).toBeDefined();
    expect(api?.cwd.endsWith(`${join("packages", "api")}`)).toBe(true);
    expect(api?.script.endsWith(join("packages", "api", "dist", "server.js"))).toBe(true);
    expect(api?.env.HOST).toBe("127.0.0.1");
    expect(api?.env.PORT).toBe("7001");
    expect(api?.env.ROSTER_MODE).toBe("sandbox");
    expect(api?.env.NODE_ENV).toBe("production");
    expect(api?.env.ROSTER_API_KEY).toBeUndefined();
    expect(api?.env.ALBESA_API_KEY).toBeUndefined();
    expect(api?.env.ALBESA_MODE).toBeUndefined();
    expect(api?.env.ROSTER_WALLET).toBeUndefined();
    expect(api?.env.SUPABASE_URL).toBeUndefined();
    expect(api?.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(web?.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();

    const dataDir = expectedDataDir();
    expect(api?.env.ALBESA_DATA_FILE).toBe(join(dataDir, "sandbox.json"));
    expect(api?.env.ROSTER_REPUTATION_FILE).toBe(join(dataDir, "reputation.json"));
    expect(api?.env.REGISTRY_INDEX_PATH).toBe(join(dataDir, "registry.json"));
    expect(api?.env.ROSTER_JOBS_FILE).toBe(join(dataDir, "jobs.json"));
  });

  it("forwards ROSTER_ADMIN_TOKEN to roster-api and does not invent one", () => {
    delete process.env.ROSTER_ADMIN_TOKEN;
    const absent = loadApps().find((app) => app.name === "roster-api");
    expect(absent?.env.ROSTER_ADMIN_TOKEN).toBeUndefined();
    expect(loadApps().find((app) => app.name === "roster-web")?.env.ROSTER_ADMIN_TOKEN).toBeUndefined();

    process.env.ROSTER_ADMIN_TOKEN = "  sandbox-operator  ";
    const present = loadApps().find((app) => app.name === "roster-api");
    expect(present?.env.ROSTER_ADMIN_TOKEN).toBe("sandbox-operator");
    expect(loadApps().find((app) => app.name === "roster-web")?.env.ROSTER_ADMIN_TOKEN).toBeUndefined();

    process.env.ROSTER_ADMIN_TOKEN = "   ";
    expect(loadApps().find((app) => app.name === "roster-api")?.env.ROSTER_ADMIN_TOKEN).toBeUndefined();
  });

  it("forwards Supabase env to the API and keeps the service role off the site", () => {
    process.env.SUPABASE_URL = " https://wbesppsdeyssfqynuezb.supabase.co ";
    process.env.SUPABASE_ANON_KEY = " anon-key ";
    process.env.SUPABASE_SERVICE_ROLE_KEY = " service-role ";
    const apps = loadApps();
    const api = apps.find((app) => app.name === "roster-api");
    const web = apps.find((app) => app.name === "roster-web");
    expect(api?.env.SUPABASE_URL).toBe("https://wbesppsdeyssfqynuezb.supabase.co");
    expect(api?.env.SUPABASE_ANON_KEY).toBe("anon-key");
    expect(api?.env.SUPABASE_SERVICE_ROLE_KEY).toBe("service-role");
    expect(web?.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://wbesppsdeyssfqynuezb.supabase.co");
    expect(web?.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("anon-key");
    expect(web?.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });
});

function loadApps(): Pm2App[] {
  delete require.cache[configPath];
  const ecosystem = require(configPath) as { apps: Pm2App[] };
  return ecosystem.apps;
}

function expectedDataDir(): string {
  if (existsSync("/home/ats-server/albesa")) return "/home/ats-server/albesa/roster-data";
  return join(root, "data");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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

  afterEach(() => {
    restoreEnv("ROSTER_DATA_DIR", previousDataDir);
    restoreEnv("ROSTER_ADMIN_TOKEN", previousAdminToken);
    delete require.cache[configPath];
  });

  it("keeps the marketing site and adds roster-api on loopback port 7001", () => {
    delete process.env.ROSTER_DATA_DIR;
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

function restoreEnv(name: "ROSTER_DATA_DIR" | "ROSTER_ADMIN_TOKEN", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

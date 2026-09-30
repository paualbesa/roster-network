import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { isRosterCorsOrigin } from "./cors.js";

const production = "https://roster.network";

describe("Roster CORS", () => {
  it("allows the production site and local dev origins", () => {
    expect(isRosterCorsOrigin(production)).toBe(true);
    expect(isRosterCorsOrigin("https://roster.network:443")).toBe(true);
    expect(isRosterCorsOrigin("http://localhost:3000")).toBe(true);
    expect(isRosterCorsOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isRosterCorsOrigin("https://localhost:3000")).toBe(true);
    expect(isRosterCorsOrigin("http://localhost")).toBe(true);
  });

  it("rejects other sites", () => {
    expect(isRosterCorsOrigin("http://roster.network")).toBe(false);
    expect(isRosterCorsOrigin("https://evil.example")).toBe(false);
    expect(isRosterCorsOrigin("https://roster.network.evil.example")).toBe(false);
    expect(isRosterCorsOrigin("https://user:pass@roster.network")).toBe(false);
    expect(isRosterCorsOrigin("not a url")).toBe(false);
  });

  it("answers /health without auth and echoes an allowed origin", async () => {
    const app = createApp({ mode: "sandbox" });
    const health = await app.request("/health", { headers: { origin: production } });
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBe(production);
    expect(await health.json()).toMatchObject({ ok: true, product: "Roster" });
  });

  it("omits the allow-origin header when the caller sends none or a foreign origin", async () => {
    const app = createApp({ mode: "sandbox" });
    const plain = await app.request("/health");
    expect(plain.status).toBe(200);
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();

    const foreign = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers a browser preflight for the production origin", async () => {
    const app = createApp({ mode: "sandbox" });
    const preflight = await app.request("/v1/accounts/login", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("keeps CORS on an error response", async () => {
    const app = createApp({ mode: "sandbox" });
    const rejected = await app.request("/v1/organizations", {
      method: "POST",
      headers: { origin: production, "content-type": "application/json" },
      body: "{",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("access-control-allow-origin")).toBe(production);
  });
});

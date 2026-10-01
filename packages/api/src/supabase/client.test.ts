import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { openSupabaseApp } from "./boot.js";
import { createAnonClient, createServiceClient } from "./client.js";

const config = {
  url: "https://example.supabase.co",
  anonKey: "anon-key",
  serviceRoleKey: "service-role-key",
};

describe("Supabase client boot without a native WebSocket", () => {
  const nativeWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

  afterEach(() => {
    if (nativeWebSocket) Object.defineProperty(globalThis, "WebSocket", nativeWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });

  it("creates the service and anon clients that openSupabaseApp uses", async () => {
    Reflect.deleteProperty(globalThis, "WebSocket");
    expect(typeof globalThis.WebSocket).toBe("undefined");

    const service = createServiceClient(config);
    const anon = createAnonClient(config);

    expect(service.realtime.transport).toBe(WebSocket);
    expect(anon.realtime.transport).toBe(WebSocket);
    await service.realtime.disconnect();
    await anon.realtime.disconnect();
  });

  it("opens the supabase app and serves health when tables are empty", async () => {
    Reflect.deleteProperty(globalThis, "WebSocket");
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json", "content-range": "*/0" },
      });
    };
    try {
      const opened = await openSupabaseApp({
        config,
        mode: "sandbox",
        walletRail: "mock",
      });
      const health = await opened.app.request("/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, mode: "sandbox", rail: "mock" });
      expect(calls.some((url) => url.includes("/rest/v1/organizations"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

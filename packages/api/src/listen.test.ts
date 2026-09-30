import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { readListenAddress } from "./listen.js";

describe("readListenAddress", () => {
  it("defaults to loopback port 8787", () => {
    expect(readListenAddress({})).toEqual({ hostname: "127.0.0.1", port: 8787 });
    expect(readListenAddress({ HOST: "  ", PORT: "7001" })).toEqual({ hostname: "127.0.0.1", port: 7001 });
    expect(readListenAddress({ HOST: "127.0.0.1", PORT: "7001" })).toEqual({
      hostname: "127.0.0.1",
      port: 7001,
    });
  });

  it("rejects a port that cannot be bound", () => {
    expect(() => readListenAddress({ PORT: "0" })).toThrow(/positive integer/);
    expect(() => readListenAddress({ PORT: "nope" })).toThrow(/positive integer/);
    expect(() => readListenAddress({ PORT: "70000" })).toThrow(/positive integer/);
  });
});

describe("API listen", () => {
  it("serves GET /health on HOST and PORT without auth", async () => {
    const port = await ephemeralPort();
    const listen = readListenAddress({ HOST: "127.0.0.1", PORT: String(port) });
    const app = createApp({ mode: "sandbox" });
    let server: ReturnType<typeof serve> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server = serve({ fetch: app.fetch, hostname: listen.hostname, port: listen.port }, (info) => {
          try {
            expect(info.address).toBe("127.0.0.1");
            expect(info.port).toBe(port);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        server.on("error", reject);
      });
      const health = await fetch(`http://127.0.0.1:${port.toString()}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, product: "Roster", mode: "sandbox" });
    } finally {
      if (server) {
        await new Promise<void>((resolve) => {
          server?.close(() => resolve());
        });
      }
    }
  });
});

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("expected a TCP port"));
        return;
      }
      const { port } = address;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

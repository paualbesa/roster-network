export interface ListenAddress {
  hostname: string;
  port: number;
}

/** Bind address for `pnpm --filter @albesa/api start`. Defaults to 127.0.0.1:8787. */
export function readListenAddress(env: NodeJS.ProcessEnv = process.env): ListenAddress {
  const hostname = env.HOST?.trim() || "127.0.0.1";
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PORT must be a positive integer.");
  }
  return { hostname, port };
}

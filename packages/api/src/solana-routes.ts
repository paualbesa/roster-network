import {
  prepareLock,
  resolveSolanaEngineConfig,
  settleEscrow,
  type PrepareLockInput,
  type SettleInput,
  type SolanaEngineConfig,
} from "@albesa/solana";
import type { Env, Hono } from "hono";
import { ServiceError } from "./service.js";

export function registerSolanaEscrowRoutes<E extends Env>(
  app: Hono<E>,
  config: SolanaEngineConfig = resolveSolanaEngineConfig(),
): void {
  app.post("/v1/escrow/prepare-lock", async (c) => {
    const input = parsePrepareLock(await readJson(c));
    const result = await prepareLock(input, config);
    return c.json(result, 201);
  });

  app.post("/v1/escrow/settle", async (c) => {
    const input = parseSettle(await readJson(c));
    const result = await settleEscrow(input, config);
    return c.json(result);
  });
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ServiceError(400, "invalid_request", "Expected a JSON body.");
  }
}

function expectRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ServiceError(400, "invalid_request", "Expected a JSON object.");
  }
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ServiceError(400, "invalid_request", `${key} is required.`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | null {
  if (!(key in body) || body[key] === undefined || body[key] === null) return null;
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ServiceError(400, "invalid_request", `${key} must be a string.`);
  }
  return value.trim();
}

function parsePrepareLock(body: unknown): PrepareLockInput {
  const record = expectRecord(body);
  const input: PrepareLockInput = {
    buyerPubkey: requireString(record, "buyerPubkey"),
    amountUsdc: requireString(record, "amountUsdc"),
  };
  const escrowId = optionalString(record, "escrowId");
  const jobId = optionalString(record, "jobId");
  const buyerTokenAccount = optionalString(record, "buyerTokenAccount");
  if (escrowId) input.escrowId = escrowId;
  if (jobId) input.jobId = jobId;
  if (buyerTokenAccount) input.buyerTokenAccount = buyerTokenAccount;
  return input;
}

function parseSettle(body: unknown): SettleInput {
  const record = expectRecord(body);
  if ("verified" in record && record.verified !== undefined && typeof record.verified !== "boolean") {
    throw new ServiceError(400, "invalid_request", "verified must be a boolean.");
  }
  const input: SettleInput = {
    escrowId: requireString(record, "escrowId"),
    buyerPubkey: requireString(record, "buyerPubkey"),
    providerPubkey: requireString(record, "providerPubkey"),
    amountUsdc: requireString(record, "amountUsdc"),
    verified: record.verified === true,
  };
  const jobId = optionalString(record, "jobId");
  const providerTokenAccount = optionalString(record, "providerTokenAccount");
  if (jobId) input.jobId = jobId;
  if (providerTokenAccount) input.providerTokenAccount = providerTokenAccount;
  return input;
}

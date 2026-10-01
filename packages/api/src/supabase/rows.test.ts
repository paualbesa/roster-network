import type { Organization, UserAccount, Wallet } from "@albesa/core";
import { SEMANTIC_DIMENSIONS } from "@albesa/registry";
import { describe, expect, it } from "vitest";
import { emptySnapshot, rowsToSnapshot, snapshotToRows } from "./rows.js";

describe("Supabase row mapping", () => {
  it("round-trips an organization, a linked profile, and the wallet snapshot", () => {
    const organization: Organization = {
      id: "org_1",
      name: "Ada",
      treasuryWalletId: "wal_1",
      mode: "sandbox",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const user: UserAccount = {
      id: "usr_1",
      email: "ada@example.com",
      displayName: "Ada",
      organizationId: organization.id,
      createdAt: organization.createdAt,
    };
    const wallet: Wallet = {
      id: "wal_1",
      organizationId: organization.id,
      ownerType: "organization",
      ownerId: organization.id,
      address: "mock:treasury:org_1",
      chain: "mock",
      asset: "USDC",
      createdAt: organization.createdAt,
    };
    const snapshot = emptySnapshot();
    snapshot.organizations.push(organization);
    snapshot.users.push(user);
    snapshot.authLinks.push({ authUserId: "00000000-0000-4000-8000-000000000001", userId: user.id });
    snapshot.wallets.push(wallet);
    snapshot.wallet = {
      balances: [{ address: wallet.address, balanceUsdc: "1000.000000" }],
      sequence: 3,
      networkFeesCollectedUsdc: "0.000001",
    };
    snapshot.embeddings.cap_1 = `[${new Array(SEMANTIC_DIMENSIONS).fill("0").join(",")}]`;

    const rows = snapshotToRows(snapshot);
    const restored = rowsToSnapshot(rows);
    expect(restored.organizations).toEqual(snapshot.organizations);
    expect(restored.users).toEqual(snapshot.users);
    expect(restored.authLinks).toEqual(snapshot.authLinks);
    expect(restored.wallets).toEqual(snapshot.wallets);
    expect(restored.wallet).toEqual(snapshot.wallet);
    expect(rows.wallet_balances).toEqual([
      { address: wallet.address, organization_id: organization.id, balance_usdc: "1000.000000" },
    ]);
    expect(rows.password_hashes).toEqual([]);
    expect(rows.api_key_hashes).toEqual([]);
  });
});

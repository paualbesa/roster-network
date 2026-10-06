# Non-custodial escrow: design direction

Status: DEVNET program implemented (`programs/roster-escrow`, mode `noncustodial-devnet`).
Sandbox can still model the flow with `ROSTER_ESCROW_MODE=noncustodial-sim`.
See `docs/SECURITY_REVIEW_ESCROW.md` before mainnet.

## Why

Today the sandbox escrow is **custodial-mock**: the buyer's lock moves to a hold
address that Roster mints, and Roster's process decides release or refund. That is
fine for a sandbox with play money. With real USDC it would make Roster a
custodian of customer funds, which brings:

- money-transmitter / CASP licensing exposure (MiCA in the EU, state MTLs in the US)
- a single hot wallet holding everyone's funds, which becomes a target
- users having to trust Roster's database rather than verifiable rules.

The goal is that **Roster never holds keys that can move escrowed funds**. Buyers lock
from their own wallets into a program-controlled vault. Release and refund are
enforced by program rules, with an oracle or arbiter only able to choose between
the outcomes the program allows.

## Actors

| Actor | Holds keys to | Can do |
|---|---|---|
| Buyer agent / org wallet | its own USDC token account | sign `lock`, sign `cancel` before acceptance, claim refund after the deadline |
| Seller agent wallet | its own token account | sign `accept`, receive payout |
| Escrow program (Solana) / contract (Base) | nothing; vault authority is a PDA or the contract itself | move vault funds only per the state machine |
| Verifier oracle (Roster-operated at first) | an attestation key, **not** a fund key | attest "result matched the schema hash" or "mismatch", nothing else |
| Arbiter (optional, multisig) | a dispute key | pick release or refund within the dispute window |
| Roster fee account | receives fees | passive; cannot withdraw from vaults |

## Primary design: Solana program with PDA vaults

Solana is the first target because the gasless relayer and the 1% + 0.003 USDC
fee engine already exist in `packages/solana` (the fee payer sponsors SOL; it never
has authority over user tokens).

### Accounts

- `Config` PDA, seeds `["config"]`: fee bps (100 = 1%), flat fee (3 000 micro-USDC),
  fee recipient token account, oracle pubkey, arbiter pubkey, max deadline.
  Upgrade authority sits with a multisig and can later be revoked to freeze the rules.
- `Escrow` PDA, seeds `["escrow", buyer, escrow_id]`: buyer, seller, amount, fee,
  `schema_hash` (sha256 of the result JSON Schema), `deadline_ts`, `state`.
- `Vault` token account (USDC mint) whose authority is the `Escrow` PDA.
  No private key exists for it; only the program can sign for it.

### Instructions and state machine

```
            lock (buyer signs)
   (none) ───────────────────────► Held
                                     │
         settle(oracle attests match)│──► Released  (vault → seller net, vault → fee account)
     settle(oracle attests mismatch) │──► Refunded  (vault → buyer, no fee)
          refund_after_deadline      │──► Refunded  (anyone can call once now > deadline_ts)
          dispute(buyer|seller)      │──► Disputed ──arbiter_resolve──► Released | Refunded
```

1. **lock**: the buyer signs a transaction that transfers `amount` from the buyer's
   token account into the `Vault`. The message commits to escrow id, seller,
   amount, fee, schema hash and deadline (sandbox mirrors this as the canonical
   `roster-escrow-lock:v1` intent, see below). Roster's relayer may pay the SOL
   network fee, but the buyer's signature is what authorizes the token transfer.
2. **settle**: anyone submits the oracle's ed25519 attestation
   `(escrow, result_hash, verdict)`; the program verifies it with the ed25519
   precompile against `Config.oracle`. The oracle can only pick between
   *release to the named seller* and *refund to the named buyer*. It can never
   redirect funds elsewhere.
3. **refund_after_deadline**: permissionless refund when the SLA deadline passed
   without a settle. This removes liveness dependence on Roster.
4. **dispute / arbiter_resolve** (v2): a short window after `settle` where either
   party can escalate to a multisig arbiter. Funds still move only to buyer or seller.

### How the 1% + 0.003 USDC fee is taken on-chain

At `lock`, the program computes and stores
`fee = min(amount, amount * fee_bps / 10_000 + flat_fee)` using integer micro-USDC
(6 decimals), so the buyer sees the exact fee before signing.

At **release**, inside the same instruction, two CPI transfers leave the vault:
`amount - fee` to the seller's token account and `fee` to `Config.fee_recipient`.
At **refund** (schema mismatch or deadline), the full `amount` returns to the buyer
and no fee is taken, matching today's sandbox rule ("timeout and refund collect
nothing"). Because the split happens in program code, Roster's fee account
cannot take more than the stored fee, and it cannot take anything from a refund.

Example: price 10.00 USDC → fee 0.10 + 0.003 = 0.103 USDC, seller nets 9.897 USDC.

## Alternative: Base (EVM) contract

Same state machine as a single `RosterEscrow` contract:

- Buyer calls `lock(escrowId, seller, amount, schemaHash, deadline)` after an
  ERC-20 `approve`, or in one transaction with EIP-2612 `permit` / Permit2. With an
  ERC-4337 paymaster Roster can sponsor gas without touching funds.
- Funds sit in the contract's balance, keyed by `escrowId`. No owner function can
  withdraw arbitrary balances; `settle` verifies an EIP-712 oracle signature;
  `refundAfterDeadline` is permissionless.
- Fee split on release: `transfer(seller, amount - fee)` and
  `transfer(feeRecipient, fee)` with the same formula.
- Ship it non-upgradeable, or behind a timelocked multisig proxy whose admin cannot
  touch escrowed balances.

## What Roster still runs (and what it cannot do)

- **Runs:** discovery and ranking, job metadata, the result verifier (schema check)
  that signs oracle attestations, gas sponsorship, reputation.
- **Cannot:** move funds out of a vault except to the buyer or seller named at lock
  time, take a fee on a refund, block a refund past the deadline, or freeze user
  wallets.
- **Oracle key compromise** limits damage to choosing the wrong one of the two
  parties for in-flight escrows. Mitigations: HSM/KMS key, per-escrow caps from KYC
  tiers, dispute window + arbiter, rotation via `Config` (multisig).

## Sandbox model: `ROSTER_ESCROW_MODE=noncustodial-sim`

Code: `packages/api/src/escrow-mode.ts`, `packages/core/src/escrow/types.ts`.

- `/health` reports `escrowMode`; the console shows it on the dashboard and the hire page.
- Every escrow carries `custody`:
  - `custodial-mock`: `{ custodian: "roster", releaseAuthority: "roster-operator" }`.
  - `noncustodial-sim`: `{ custodian: "program", programId: "RosterEscrowSim111…",
    vault: "sim-pda:<sha256(escrow, program, escrowId, buyer)>",
    buyerAuthorization: { signer, message, signature: "sim-ed25519:…" },
    releaseAuthority: "program-rules", onChainFeeUsdc }`.
- `buyerAuthorization.message` is the canonical lock intent the buyer wallet would
  sign: program, escrow id, vault, buyer, seller, amount, fee, schema hash.
- Settlement still uses the sandbox mock rail so all existing tests, jobs and the
  simulator behave the same. The sim records custody; it does not create a real
  signature or touch any chain.

## Rollout plan

1. Sandbox: `noncustodial-sim` on staging; SDK exposes `custody` on escrows. (done)
2. Devnet program (Anchor) + audit-ready tests: lock, settle(match/mismatch),
   refund_after_deadline, fee math property tests.
3. SDK: buyer-side signing (wallet adapter / local keypair for agents), relayer
   only co-signs as fee payer.
4. External audit, then mainnet behind KYC tier caps and per-escrow limits.
5. Retire `custodial-mock` for real funds; keep it only for the sandbox.

## Open questions for Pau

- Solana first (existing gasless engine) vs Base (EVM tooling, Coinbase reach).
- Who operates the arbiter multisig, and the dispute window length.
- Whether the oracle stays Roster-run or moves to a decentralized verifier set.
- Legal review of the "never custodial" claim under MiCA before marketing it.

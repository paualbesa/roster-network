# Security review: Roster non-custodial escrow (`roster-escrow`)

Status: **internal review only**. Not an external audit. Do not raise per-job
limits or enable mainnet until an independent audit signs off.

Program id (DEVNET): `9kEkd18dibRCwMS7tesWE2nYgg5zR4QqqS7oYYeCFL61`  
Artifacts: `programs/roster-escrow/`, client `packages/solana/src/noncustodial-escrow.ts`.

## Threat model

| Threat | Mitigation in program | Residual risk |
|---|---|---|
| Roster steals escrowed USDC | No Roster key is vault authority; vault authority is Escrow PDA; only `Release`/`Refund`/`ArbiterResolve` move tokens, and destinations are fixed (seller ATA owned by `escrow.seller`, buyer ATA owned by `escrow.buyer`, or `Config.fee_recipient`) | Upgrade authority / bug in account checks |
| Arbiter drains vault to self | Arbiter may only choose release-to-seller or refund-to-buyer; fee ATA must equal `Config.fee_recipient`; seller/buyer ATA owner+mint checked | Compromised arbiter can pick the wrong party |
| Fee over-collection | Fee stored at fund time; release pays exactly `amount - fee` and `fee`; refund pays full `amount` (no fee) | Misconfigured `fee_bps` / `flat_fee` at init |
| Double release / release after refund | State tombstone `Released`/`Refunded`; vault closed after settle | Caller must not reuse `escrow_id` |
| Wrong mint / fake vault | Mint must match `Config.mint` and escrow; vault PDA seeds `["vault", escrow]` | — |
| Wrong signer | Buyer signs fund/release (Held); arbiter only when `Disputed`; refund permissionless after deadline | Buyer key compromise |
| Deadline griefing | Buyer may cancel (refund) while Held; after deadline anyone can crank refund | Buyer cancels after seller work (product/legal) |
| Overflow / fee edge | `checked_*` math; reject `fee >= amount` | — |
| Rent griefing | Vault closed on settle; escrow account kept as tombstone to block id reuse | Escrow rent locked until we add explicit close-after-settle with id bloom |

## Invariants

1. Vault token account authority = Escrow PDA; no private key exists for it.
2. While `Held` or `Disputed`, token balance on vault == `escrow.amount` (until settle CPI).
3. On release: seller receives `amount - fee`, fee recipient receives `fee`, vault closed.
4. On refund: buyer receives `amount`, vault closed, fee not taken.
5. Arbiter cannot set an arbitrary destination.
6. `CreateAndFund` requires buyer signature and `deadline_ts > now`.

## Test coverage

| Layer | What |
|---|---|
| Rust host (`cargo test -p roster-escrow`) | Fee unit tests; PDA stability; state-machine negatives (double release, release after refund, dispute window, deadline refund) |
| TS (`packages/solana` vitest) | Fee parity; PDA helpers; instruction discriminants; wrong-signer meta shape |
| DEVNET E2E (`scripts/e2e-escrow-devnet.mjs`) | Live fund→release and fund→refund with explorer signatures |

Still needed before large limits: property tests (proptest), BPF `cargo-test-sbf` bankrun suite, fuzz on instruction data, formal review of close/reinit, upgrade-authority freeze plan.

## What still needs an external audit

- Full account meta / CPI review (SPL Token edge cases, re-entrancy via malicious mint).
- Upgrade authority ops: multisig, timelock, eventual immorability.
- Economic review of buyer-cancel-anytime while Held vs seller delivery risk.
- Oracle attestation path (design doc) if/when added — not in v1 program.
- Legal review of “non-custodial” under MiCA / US MTL before marketing.

## Mainnet config (prepared, **not enabled**)

| Knob | Value |
|---|---|
| USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Per-job cap | `100.000000` USDC |
| Env | `ROSTER_ESCROW_PROGRAM_ID=…` (mainnet deploy), `ROSTER_ESCROW_MODE` stays off mainnet until go-live; `ROSTER_ESCROW_MAINNET=0` |
| Fee payer | Separate mainnet fee-payer key on server (do not reuse DEVNET key) |

### Go-live checklist

- [ ] External audit report + remediations merged
- [ ] Upgrade authority moved to multisig (or revoked)
- [ ] ToS / risk disclosure page live (non-custodial wording legal-reviewed)
- [ ] Fee schedule on (`1% + 0.003`), matching on-chain Config
- [ ] KYC tier caps enforced in API (Tier 0/1) and per-job cap 100 USDC
- [ ] Mainnet program id pinned in env; `ROSTER_ESCROW_MODE` only after canary
- [ ] Monitoring: vault balance ≠ amount alerts; arbiter action log
- [ ] Incident runbook: pause hirings (API), cannot pause on-chain refunds after deadline (by design)
- [ ] No mainnet fee-payer key in git / chat / CI logs

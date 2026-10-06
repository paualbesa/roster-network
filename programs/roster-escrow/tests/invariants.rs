//! Host-side invariant and negative-path tests (no validator).
//! BPF integration tests: `cargo test-sbf -p roster-escrow`.

use roster_escrow::compute_fee;
use roster_escrow::error::EscrowError;
use roster_escrow::state::{EscrowState, CONFIG_SEED, ESCROW_SEED, VAULT_SEED};
use solana_program::pubkey::Pubkey;

#[test]
fn pda_seeds_are_stable() {
    let program = Pubkey::new_unique();
    let buyer = Pubkey::new_unique();
    let escrow_id = [7u8; 32];
    let (a, _) = Pubkey::find_program_address(&[ESCROW_SEED, buyer.as_ref(), &escrow_id], &program);
    let (b, _) = Pubkey::find_program_address(&[ESCROW_SEED, buyer.as_ref(), &escrow_id], &program);
    assert_eq!(a, b);
    let (vault, _) = Pubkey::find_program_address(&[VAULT_SEED, a.as_ref()], &program);
    assert_ne!(vault, a);
    let (cfg, _) = Pubkey::find_program_address(&[CONFIG_SEED], &program);
    assert_ne!(cfg, vault);
}

#[test]
fn fee_edge_cases() {
    assert_eq!(compute_fee(1_000_000, 100, 3_000).unwrap(), 13_000); // 1 USDC
    assert!(matches!(
        compute_fee(3_000, 100, 3_000),
        Err(EscrowError::FeeExceedsAmount)
    ));
    assert!(matches!(
        compute_fee(2_999, 100, 3_000),
        Err(EscrowError::FeeExceedsAmount)
    ));
    // Exactly fee == amount - 1 is ok
    let fee = compute_fee(3_001, 0, 3_000).unwrap();
    assert_eq!(fee, 3_000);
}

#[test]
fn state_discriminants_unique() {
    assert_ne!(EscrowState::Held as u8, EscrowState::Released as u8);
    assert_ne!(EscrowState::Refunded as u8, EscrowState::Disputed as u8);
    assert_ne!(EscrowState::Released as u8, EscrowState::Refunded as u8);
}

/// Models the allowed transitions for documentation/tests without the runtime.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Action {
    Fund,
    ReleaseBuyer,
    ReleaseArbiter,
    RefundBuyer,
    RefundDeadline,
    RefundArbiter,
    Dispute,
}

fn apply(state: EscrowState, action: Action, after_deadline: bool, in_dispute_window: bool) -> Result<EscrowState, &'static str> {
    match (state, action) {
        (EscrowState::Uninit, Action::Fund) => Ok(EscrowState::Held),
        (EscrowState::Held, Action::ReleaseBuyer) if !after_deadline => Ok(EscrowState::Released),
        (EscrowState::Held, Action::RefundBuyer) => Ok(EscrowState::Refunded),
        (EscrowState::Held, Action::RefundDeadline) if after_deadline => Ok(EscrowState::Refunded),
        (EscrowState::Held, Action::Dispute) if in_dispute_window && !after_deadline => Ok(EscrowState::Disputed),
        (EscrowState::Disputed, Action::ReleaseArbiter) => Ok(EscrowState::Released),
        (EscrowState::Disputed, Action::RefundArbiter) => Ok(EscrowState::Refunded),
        (EscrowState::Released, _) | (EscrowState::Refunded, _) => Err("already settled"),
        (EscrowState::Held, Action::ReleaseArbiter) => Err("arbiter only after dispute"),
        (EscrowState::Held, Action::RefundDeadline) if !after_deadline => Err("deadline not reached"),
        _ => Err("illegal"),
    }
}

#[test]
fn happy_path_fund_release() {
    let s = apply(EscrowState::Uninit, Action::Fund, false, true).unwrap();
    assert_eq!(s, EscrowState::Held);
    let s = apply(s, Action::ReleaseBuyer, false, true).unwrap();
    assert_eq!(s, EscrowState::Released);
    assert!(apply(s, Action::ReleaseBuyer, false, true).is_err());
    assert!(apply(s, Action::RefundBuyer, false, true).is_err());
}

#[test]
fn fund_then_deadline_refund() {
    let s = apply(EscrowState::Uninit, Action::Fund, false, true).unwrap();
    assert!(apply(s, Action::RefundDeadline, false, true).is_err());
    let s = apply(s, Action::RefundDeadline, true, true).unwrap();
    assert_eq!(s, EscrowState::Refunded);
}

#[test]
fn dispute_then_arbiter_only() {
    let s = apply(EscrowState::Uninit, Action::Fund, false, true).unwrap();
    let s = apply(s, Action::Dispute, false, true).unwrap();
    assert_eq!(s, EscrowState::Disputed);
    assert!(apply(s, Action::ReleaseBuyer, false, true).is_err());
    let s = apply(s, Action::ReleaseArbiter, false, true).unwrap();
    assert_eq!(s, EscrowState::Released);
}

#[test]
fn cannot_dispute_after_window() {
    let s = apply(EscrowState::Uninit, Action::Fund, false, true).unwrap();
    assert!(apply(s, Action::Dispute, false, false).is_err());
}

#[test]
fn double_release_forbidden() {
    let mut s = apply(EscrowState::Uninit, Action::Fund, false, true).unwrap();
    s = apply(s, Action::ReleaseBuyer, false, true).unwrap();
    assert_eq!(apply(s, Action::ReleaseBuyer, false, true).unwrap_err(), "already settled");
    assert_eq!(apply(s, Action::RefundBuyer, false, true).unwrap_err(), "already settled");
}

#[test]
fn release_after_refund_forbidden() {
    let mut s = apply(EscrowState::Uninit, Action::Fund, false, true).unwrap();
    s = apply(s, Action::RefundBuyer, false, true).unwrap();
    assert!(apply(s, Action::ReleaseBuyer, false, true).is_err());
}

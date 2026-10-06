#![allow(clippy::arithmetic_side_effects)]

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

// Placeholder; overwritten by `solana program deploy` keypair / scripts/deploy-escrow.sh
solana_program::declare_id!("9kEkd18dibRCwMS7tesWE2nYgg5zR4QqqS7oYYeCFL61");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, instruction_data)
}

/// Host-safe fee helper for unit tests / TypeScript parity checks.
pub fn compute_fee(amount: u64, fee_bps: u16, flat_fee: u64) -> Result<u64, error::EscrowError> {
    use error::EscrowError;
    if amount == 0 {
        return Err(EscrowError::ZeroAmount);
    }
    let percent = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(EscrowError::Overflow)?
        .checked_div(10_000)
        .ok_or(EscrowError::Overflow)? as u64;
    let fee = percent.checked_add(flat_fee).ok_or(EscrowError::Overflow)?;
    if fee >= amount {
        return Err(EscrowError::FeeExceedsAmount);
    }
    Ok(fee)
}

#[cfg(test)]
mod fee_tests {
    use super::*;
    use crate::error::EscrowError;

    #[test]
    fn fee_matches_doc_example() {
        // 10.00 USDC = 10_000_000 micros → 1% + 0.003 = 103_000
        let fee = compute_fee(10_000_000, 100, 3_000).unwrap();
        assert_eq!(fee, 103_000);
        assert_eq!(10_000_000 - fee, 9_897_000);
    }

    #[test]
    fn fee_rejects_too_small_amount() {
        // 0.002 USDC cannot cover 0.003 flat
        assert!(matches!(
            compute_fee(2_000, 100, 3_000),
            Err(EscrowError::FeeExceedsAmount)
        ));
    }

    #[test]
    fn fee_zero_amount() {
        assert!(matches!(compute_fee(0, 100, 3_000), Err(EscrowError::ZeroAmount)));
    }

    #[test]
    fn fee_truncates_percent_toward_zero() {
        // 1 micro * 1% = 0 + 3000 flat
        let fee = compute_fee(10_000, 100, 3_000).unwrap();
        assert_eq!(fee, 3_100); // 100 + 3000
    }
}

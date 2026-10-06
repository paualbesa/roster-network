use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const VAULT_SEED: &[u8] = b"vault";

pub const CONFIG_DISCRIMINATOR: u64 = 0x524f5f434647_u64; // "RO_CFG"
pub const ESCROW_DISCRIMINATOR: u64 = 0x524f5f455343_u64; // "RO_ESC"

#[repr(u8)]
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscrowState {
    /// Uninitialized / placeholder
    Uninit = 0,
    Held = 1,
    Released = 2,
    Refunded = 3,
    Disputed = 4,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Config {
    pub discriminator: u64,
    pub authority: Pubkey,
    pub arbiter: Pubkey,
    pub fee_recipient: Pubkey,
    pub mint: Pubkey,
    /// Basis points (100 = 1%).
    pub fee_bps: u16,
    /// Flat fee in token base units (micro-USDC for 6-dec mint).
    pub flat_fee: u64,
    /// Seconds after create during which dispute is allowed while Held.
    pub dispute_window_secs: i64,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 2 + 8 + 8 + 1;

    pub fn compute_fee(&self, amount: u64) -> Result<u64, crate::error::EscrowError> {
        if amount == 0 {
            return Err(crate::error::EscrowError::ZeroAmount);
        }
        let percent = (amount as u128)
            .checked_mul(self.fee_bps as u128)
            .ok_or(crate::error::EscrowError::Overflow)?
            .checked_div(10_000)
            .ok_or(crate::error::EscrowError::Overflow)? as u64;
        let fee = percent
            .checked_add(self.flat_fee)
            .ok_or(crate::error::EscrowError::Overflow)?;
        if fee >= amount {
            return Err(crate::error::EscrowError::FeeExceedsAmount);
        }
        Ok(fee)
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Escrow {
    pub discriminator: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub schema_hash: [u8; 32],
    pub created_ts: i64,
    pub deadline_ts: i64,
    pub state: EscrowState,
    /// Opaque 32-byte job/escrow id (caller-provided).
    pub escrow_id: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
}

impl Escrow {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 32 + 8 + 8 + 1 + 32 + 1 + 1;
}

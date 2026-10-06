use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum EscrowInstruction {
    /// Initialize global config PDA. Authority signs.
    /// Accounts: payer/authority [s,w], config [w], fee_recipient_token, mint, system, rent
    InitializeConfig {
        arbiter: Pubkey,
        fee_bps: u16,
        flat_fee: u64,
        dispute_window_secs: i64,
    },

    /// Create escrow PDA + vault ATA and fund from buyer ATA.
    /// Accounts: buyer [s,w], buyer_ata [w], seller, escrow [w], vault [w], config, mint,
    /// token_program, ata_program, system, rent, clock
    CreateAndFund {
        escrow_id: [u8; 32],
        amount: u64,
        schema_hash: [u8; 32],
        /// Absolute unix deadline for permissionless refund.
        deadline_ts: i64,
    },

    /// Release to seller + fee to fee_recipient. Buyer signs while Held,
    /// or arbiter while Disputed.
    /// Accounts: authority [s], escrow [w], vault [w], seller_ata [w], fee_ata [w],
    /// config, token_program, clock
    Release,

    /// Refund full amount to buyer. Buyer may call anytime while Held (cancel),
    /// anyone after deadline, or arbiter while Disputed.
    /// Accounts: authority [s] (or any after deadline), escrow [w], vault [w],
    /// buyer_ata [w], config, token_program, clock
    Refund,

    /// Buyer or seller moves Held → Disputed within dispute_window_secs of create.
    /// Accounts: party [s], escrow [w], config, clock
    Dispute,

    /// Arbiter chooses outcome while Disputed.
    /// Accounts: arbiter [s], escrow [w], vault [w], seller_ata [w], fee_ata [w],
    /// buyer_ata [w], config, token_program, clock
    ArbiterResolve { release: bool },
}

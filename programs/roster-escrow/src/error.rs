use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Error, Debug, Copy, Clone)]
pub enum EscrowError {
    #[error("Invalid instruction data")]
    InvalidInstruction = 0,
    #[error("Account constraint failed")]
    InvalidAccount = 1,
    #[error("Missing required signature")]
    MissingSignature = 2,
    #[error("Escrow is not in the expected state")]
    InvalidState = 3,
    #[error("Deadline has not passed yet")]
    DeadlineNotReached = 4,
    #[error("Deadline already passed")]
    DeadlinePassed = 5,
    #[error("Arithmetic overflow")]
    Overflow = 6,
    #[error("Fee exceeds amount")]
    FeeExceedsAmount = 7,
    #[error("Wrong mint")]
    WrongMint = 8,
    #[error("Wrong vault")]
    WrongVault = 9,
    #[error("Already settled")]
    AlreadySettled = 10,
    #[error("Unauthorized")]
    Unauthorized = 11,
    #[error("Amount must be greater than zero")]
    ZeroAmount = 12,
    #[error("Dispute window inactive")]
    DisputeInactive = 13,
}

impl From<EscrowError> for ProgramError {
    fn from(e: EscrowError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

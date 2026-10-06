use solana_program::program_error::ProgramError;

#[repr(u32)]
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum EscrowError {
    InvalidInstruction = 0,
    InvalidAccount = 1,
    MissingSignature = 2,
    InvalidState = 3,
    DeadlineNotReached = 4,
    DeadlinePassed = 5,
    Overflow = 6,
    FeeExceedsAmount = 7,
    WrongMint = 8,
    WrongVault = 9,
    AlreadySettled = 10,
    Unauthorized = 11,
    ZeroAmount = 12,
    DisputeInactive = 13,
}

impl From<EscrowError> for ProgramError {
    fn from(e: EscrowError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

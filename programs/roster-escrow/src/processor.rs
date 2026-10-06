use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};
use spl_token::{
    instruction::{close_account, initialize_account3, transfer_checked},
    state::Account as TokenAccount,
    state::Mint,
};

use crate::{
    error::EscrowError,
    instruction::EscrowInstruction,
    state::{Config, Escrow, EscrowState, CONFIG_DISCRIMINATOR, CONFIG_SEED, ESCROW_DISCRIMINATOR, ESCROW_SEED, VAULT_SEED},
};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let ix = EscrowInstruction::try_from_slice(data).map_err(|_| EscrowError::InvalidInstruction)?;
    match ix {
        EscrowInstruction::InitializeConfig {
            arbiter,
            fee_bps,
            flat_fee,
            dispute_window_secs,
        } => process_initialize_config(program_id, accounts, arbiter, fee_bps, flat_fee, dispute_window_secs),
        EscrowInstruction::CreateAndFund {
            escrow_id,
            amount,
            schema_hash,
            deadline_ts,
        } => process_create_and_fund(program_id, accounts, escrow_id, amount, schema_hash, deadline_ts),
        EscrowInstruction::Release => process_release(program_id, accounts),
        EscrowInstruction::Refund => process_refund(program_id, accounts),
        EscrowInstruction::Dispute => process_dispute(program_id, accounts),
        EscrowInstruction::ArbiterResolve { release } => process_arbiter_resolve(program_id, accounts, release),
    }
}

fn process_initialize_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    arbiter: Pubkey,
    fee_bps: u16,
    flat_fee: u64,
    dispute_window_secs: i64,
) -> ProgramResult {
    let acc = &mut accounts.iter();
    let authority = next_account_info(acc)?;
    let config_info = next_account_info(acc)?;
    let fee_recipient = next_account_info(acc)?;
    let mint_info = next_account_info(acc)?;
    let system_program = next_account_info(acc)?;

    if !authority.is_signer {
        return Err(EscrowError::MissingSignature.into());
    }
    if fee_bps > 1_000 {
        return Err(EscrowError::InvalidInstruction.into());
    }

    let (config_pda, bump) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config_info.key != &config_pda {
        return Err(EscrowError::InvalidAccount.into());
    }
    if !config_info.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let rent = Rent::get()?;
    let space = Config::LEN;
    let lamports = rent.minimum_balance(space);
    invoke_signed(
        &system_instruction::create_account(
            authority.key,
            config_info.key,
            lamports,
            space as u64,
            program_id,
        ),
        &[authority.clone(), config_info.clone(), system_program.clone()],
        &[&[CONFIG_SEED, &[bump]]],
    )?;

    let config = Config {
        discriminator: CONFIG_DISCRIMINATOR,
        authority: *authority.key,
        arbiter,
        fee_recipient: *fee_recipient.key,
        mint: *mint_info.key,
        fee_bps,
        flat_fee,
        dispute_window_secs,
        bump,
    };
    config.serialize(&mut &mut config_info.data.borrow_mut()[..])?;
    Ok(())
}

fn load_config(program_id: &Pubkey, info: &AccountInfo) -> Result<Config, ProgramError> {
    if info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let config = Config::try_from_slice(&info.data.borrow()).map_err(|_| EscrowError::InvalidAccount)?;
    if config.discriminator != CONFIG_DISCRIMINATOR {
        return Err(EscrowError::InvalidAccount.into());
    }
    let (expected, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if info.key != &expected {
        return Err(EscrowError::InvalidAccount.into());
    }
    Ok(config)
}

fn load_escrow(program_id: &Pubkey, info: &AccountInfo) -> Result<Escrow, ProgramError> {
    if info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let escrow = Escrow::try_from_slice(&info.data.borrow()).map_err(|_| EscrowError::InvalidAccount)?;
    if escrow.discriminator != ESCROW_DISCRIMINATOR {
        return Err(EscrowError::InvalidAccount.into());
    }
    Ok(escrow)
}

fn process_create_and_fund(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    escrow_id: [u8; 32],
    amount: u64,
    schema_hash: [u8; 32],
    deadline_ts: i64,
) -> ProgramResult {
    let acc = &mut accounts.iter();
    let buyer = next_account_info(acc)?;
    let buyer_ata = next_account_info(acc)?;
    let seller = next_account_info(acc)?;
    let escrow_info = next_account_info(acc)?;
    let vault_info = next_account_info(acc)?;
    let config_info = next_account_info(acc)?;
    let mint_info = next_account_info(acc)?;
    let token_program = next_account_info(acc)?;
    let system_program = next_account_info(acc)?;
    let rent_sysvar = next_account_info(acc)?;

    if !buyer.is_signer {
        return Err(EscrowError::MissingSignature.into());
    }
    let config = load_config(program_id, config_info)?;
    if mint_info.key != &config.mint {
        return Err(EscrowError::WrongMint.into());
    }
    let clock = Clock::get()?;
    if deadline_ts <= clock.unix_timestamp {
        return Err(EscrowError::DeadlinePassed.into());
    }

    let fee = config.compute_fee(amount)?;

    let (escrow_pda, escrow_bump) =
        Pubkey::find_program_address(&[ESCROW_SEED, buyer.key.as_ref(), &escrow_id], program_id);
    if escrow_info.key != &escrow_pda {
        return Err(EscrowError::InvalidAccount.into());
    }
    if !escrow_info.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let (vault_pda, vault_bump) =
        Pubkey::find_program_address(&[VAULT_SEED, escrow_pda.as_ref()], program_id);
    if vault_info.key != &vault_pda {
        return Err(EscrowError::WrongVault.into());
    }

    let rent = Rent::get()?;
    let escrow_space = Escrow::LEN;
    invoke_signed(
        &system_instruction::create_account(
            buyer.key,
            escrow_info.key,
            rent.minimum_balance(escrow_space),
            escrow_space as u64,
            program_id,
        ),
        &[buyer.clone(), escrow_info.clone(), system_program.clone()],
        &[&[ESCROW_SEED, buyer.key.as_ref(), &escrow_id, &[escrow_bump]]],
    )?;

    // Create vault token account owned by escrow PDA (not ATA — dedicated vault PDA).
    let mint = Mint::unpack(&mint_info.data.borrow())?;
    let vault_space = TokenAccount::LEN;
    invoke_signed(
        &system_instruction::create_account(
            buyer.key,
            vault_info.key,
            rent.minimum_balance(vault_space),
            vault_space as u64,
            token_program.key,
        ),
        &[buyer.clone(), vault_info.clone(), system_program.clone()],
        &[&[VAULT_SEED, escrow_pda.as_ref(), &[vault_bump]]],
    )?;
    invoke(
        &initialize_account3(token_program.key, vault_info.key, mint_info.key, &escrow_pda)?,
        &[vault_info.clone(), mint_info.clone(), rent_sysvar.clone()],
    )?;

    invoke(
        &transfer_checked(
            token_program.key,
            buyer_ata.key,
            mint_info.key,
            vault_info.key,
            buyer.key,
            &[],
            amount,
            mint.decimals,
        )?,
        &[
            buyer_ata.clone(),
            mint_info.clone(),
            vault_info.clone(),
            buyer.clone(),
            token_program.clone(),
        ],
    )?;

    let escrow = Escrow {
        discriminator: ESCROW_DISCRIMINATOR,
        buyer: *buyer.key,
        seller: *seller.key,
        mint: *mint_info.key,
        amount,
        fee,
        schema_hash,
        created_ts: clock.unix_timestamp,
        deadline_ts,
        state: EscrowState::Held,
        escrow_id,
        bump: escrow_bump,
        vault_bump,
    };
    escrow.serialize(&mut &mut escrow_info.data.borrow_mut()[..])?;
    Ok(())
}

fn escrow_signer_seeds<'a>(escrow: &'a Escrow) -> [&'a [u8]; 4] {
    [
        ESCROW_SEED,
        escrow.buyer.as_ref(),
        escrow.escrow_id.as_ref(),
        std::slice::from_ref(&escrow.bump),
    ]
}

fn assert_vault(program_id: &Pubkey, escrow: &Escrow, escrow_key: &Pubkey, vault: &AccountInfo) -> Result<(), ProgramError> {
    let (expected, _) = Pubkey::find_program_address(&[VAULT_SEED, escrow_key.as_ref()], program_id);
    if vault.key != &expected {
        return Err(EscrowError::WrongVault.into());
    }
    let _ = escrow;
    Ok(())
}


fn process_release(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let acc = &mut accounts.iter();
    let authority = next_account_info(acc)?;
    let escrow_info = next_account_info(acc)?;
    let vault_info = next_account_info(acc)?;
    let seller_ata = next_account_info(acc)?;
    let fee_ata = next_account_info(acc)?;
    let config_info = next_account_info(acc)?;
    let mint_info = next_account_info(acc)?;
    let token_program = next_account_info(acc)?;

    if !authority.is_signer {
        return Err(EscrowError::MissingSignature.into());
    }
    let config = load_config(program_id, config_info)?;
    let mut escrow = load_escrow(program_id, escrow_info)?;
    assert_vault(program_id, &escrow, escrow_info.key, vault_info)?;

    match escrow.state {
        EscrowState::Held => {
            if authority.key != &escrow.buyer {
                return Err(EscrowError::Unauthorized.into());
            }
        }
        EscrowState::Disputed => {
            if authority.key != &config.arbiter {
                return Err(EscrowError::Unauthorized.into());
            }
        }
        EscrowState::Released | EscrowState::Refunded => return Err(EscrowError::AlreadySettled.into()),
        EscrowState::Uninit => return Err(EscrowError::InvalidState.into()),
    }

    if mint_info.key != &escrow.mint || mint_info.key != &config.mint {
        return Err(EscrowError::WrongMint.into());
    }
    if fee_ata.key != &config.fee_recipient {
        return Err(EscrowError::InvalidAccount.into());
    }
    let seller_ta = TokenAccount::unpack(&seller_ata.data.borrow()).map_err(|_| EscrowError::InvalidAccount)?;
    if seller_ata.owner != token_program.key
        || seller_ta.owner != escrow.seller
        || seller_ta.mint != escrow.mint
    {
        return Err(EscrowError::InvalidAccount.into());
    }
    let fee_ta = TokenAccount::unpack(&fee_ata.data.borrow()).map_err(|_| EscrowError::InvalidAccount)?;
    if fee_ata.owner != token_program.key || fee_ta.mint != escrow.mint {
        return Err(EscrowError::InvalidAccount.into());
    }

    let mint = Mint::unpack(&mint_info.data.borrow())?;
    let seller_net = escrow
        .amount
        .checked_sub(escrow.fee)
        .ok_or(EscrowError::Overflow)?;

    let seeds = escrow_signer_seeds(&escrow);
    let signer = &[&seeds[..]];

    invoke_signed(
        &transfer_checked(
            token_program.key,
            vault_info.key,
            mint_info.key,
            seller_ata.key,
            escrow_info.key,
            &[],
            seller_net,
            mint.decimals,
        )?,
        &[
            vault_info.clone(),
            mint_info.clone(),
            seller_ata.clone(),
            escrow_info.clone(),
            token_program.clone(),
        ],
        signer,
    )?;

    if escrow.fee > 0 {
        invoke_signed(
            &transfer_checked(
                token_program.key,
                vault_info.key,
                mint_info.key,
                fee_ata.key,
                escrow_info.key,
                &[],
                escrow.fee,
                mint.decimals,
            )?,
            &[
                vault_info.clone(),
                mint_info.clone(),
                fee_ata.clone(),
                escrow_info.clone(),
                token_program.clone(),
            ],
            signer,
        )?;
    }

    // Close vault token account to reclaim rent (destination = authority / crank).
    invoke_signed(
        &close_account(
            token_program.key,
            vault_info.key,
            authority.key,
            escrow_info.key,
            &[],
        )?,
        &[vault_info.clone(), authority.clone(), escrow_info.clone(), token_program.clone()],
        signer,
    )?;

    escrow.state = EscrowState::Released;
    escrow.serialize(&mut &mut escrow_info.data.borrow_mut()[..])?;
    Ok(())
}

fn process_refund(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let acc = &mut accounts.iter();
    let authority = next_account_info(acc)?;
    let escrow_info = next_account_info(acc)?;
    let vault_info = next_account_info(acc)?;
    let buyer_ata = next_account_info(acc)?;
    let config_info = next_account_info(acc)?;
    let mint_info = next_account_info(acc)?;
    let token_program = next_account_info(acc)?;

    let config = load_config(program_id, config_info)?;
    let mut escrow = load_escrow(program_id, escrow_info)?;
    assert_vault(program_id, &escrow, escrow_info.key, vault_info)?;
    let clock = Clock::get()?;

    match escrow.state {
        EscrowState::Held => {
            let after_deadline = clock.unix_timestamp >= escrow.deadline_ts;
            let buyer_cancel = authority.is_signer && authority.key == &escrow.buyer;
            if !after_deadline && !buyer_cancel {
                return Err(EscrowError::Unauthorized.into());
            }
            // Permissionless after deadline: authority need not be buyer, but must still be a signer for tx.
            if !authority.is_signer {
                return Err(EscrowError::MissingSignature.into());
            }
        }
        EscrowState::Disputed => {
            if !authority.is_signer || authority.key != &config.arbiter {
                return Err(EscrowError::Unauthorized.into());
            }
        }
        EscrowState::Released | EscrowState::Refunded => return Err(EscrowError::AlreadySettled.into()),
        EscrowState::Uninit => return Err(EscrowError::InvalidState.into()),
    }

    if mint_info.key != &escrow.mint {
        return Err(EscrowError::WrongMint.into());
    }
    let buyer_ta = TokenAccount::unpack(&buyer_ata.data.borrow()).map_err(|_| EscrowError::InvalidAccount)?;
    if buyer_ata.owner != token_program.key
        || buyer_ta.owner != escrow.buyer
        || buyer_ta.mint != escrow.mint
    {
        return Err(EscrowError::InvalidAccount.into());
    }

    let mint = Mint::unpack(&mint_info.data.borrow())?;
    let seeds = escrow_signer_seeds(&escrow);
    let signer = &[&seeds[..]];

    invoke_signed(
        &transfer_checked(
            token_program.key,
            vault_info.key,
            mint_info.key,
            buyer_ata.key,
            escrow_info.key,
            &[],
            escrow.amount,
            mint.decimals,
        )?,
        &[
            vault_info.clone(),
            mint_info.clone(),
            buyer_ata.clone(),
            escrow_info.clone(),
            token_program.clone(),
        ],
        signer,
    )?;

    // Vault rent → authority (buyer cancel or permissionless crank incentive).
    invoke_signed(
        &close_account(
            token_program.key,
            vault_info.key,
            authority.key,
            escrow_info.key,
            &[],
        )?,
        &[vault_info.clone(), authority.clone(), escrow_info.clone(), token_program.clone()],
        signer,
    )?;

    escrow.state = EscrowState::Refunded;
    escrow.serialize(&mut &mut escrow_info.data.borrow_mut()[..])?;
    Ok(())
}

fn process_dispute(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let acc = &mut accounts.iter();
    let party = next_account_info(acc)?;
    let escrow_info = next_account_info(acc)?;
    let config_info = next_account_info(acc)?;

    if !party.is_signer {
        return Err(EscrowError::MissingSignature.into());
    }
    let config = load_config(program_id, config_info)?;
    let mut escrow = load_escrow(program_id, escrow_info)?;
    if escrow.state != EscrowState::Held {
        return Err(EscrowError::InvalidState.into());
    }
    if party.key != &escrow.buyer && party.key != &escrow.seller {
        return Err(EscrowError::Unauthorized.into());
    }
    let clock = Clock::get()?;
    if clock.unix_timestamp > escrow.created_ts.saturating_add(config.dispute_window_secs) {
        return Err(EscrowError::DisputeInactive.into());
    }
    if clock.unix_timestamp >= escrow.deadline_ts {
        return Err(EscrowError::DeadlinePassed.into());
    }

    escrow.state = EscrowState::Disputed;
    escrow.serialize(&mut &mut escrow_info.data.borrow_mut()[..])?;
    Ok(())
}

fn process_arbiter_resolve(program_id: &Pubkey, accounts: &[AccountInfo], release: bool) -> ProgramResult {
    // Reuse Release/Refund account metas with arbiter as authority — call into those paths
    // by temporarily requiring Disputed + arbiter (already enforced there).
    if release {
        process_release(program_id, accounts)
    } else {
        process_refund(program_id, accounts)
    }
}


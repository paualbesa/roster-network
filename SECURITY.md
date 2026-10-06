# Security Policy

## Supported versions

The `main` branch of [roster-network](https://github.com/paualbesa/roster-network) is the supported line. The public deployment at [roster.network](https://roster.network) runs sandbox mode (mock USDC) unless otherwise stated.

## Reporting a vulnerability

Email **info@roster.network** with:

- A clear description of the issue and impact
- Steps to reproduce or a proof of concept
- Affected commit SHA or release if known

Do not file a public GitHub issue for undisclosed security problems.

We aim to acknowledge reports within a few business days. Please give us reasonable time to fix before any public disclosure.

## Scope notes

- Sandbox API keys and passwords must never appear in git history or logs in plaintext.
- Mainnet Solana/Base settlement and fee-payer secrets belong only in server environment variables, never in the repository.
- Out of scope: denial of service against third-party data sources, social engineering, and physical access attacks.

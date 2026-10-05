# Security Policy

## Private Key Handling

**CRITICAL WARNING**: `sealbox` requires an Ed25519 private key (`SIGNER_PRIVATE_KEY`) to sign payloads and upload to Shelby. 

**You MUST use a dedicated, throwaway test key for this tool.**

Whoever holds this key controls any future token claims, data modifications, or administrative rights associated with the sealed blobs.

**DO NOT** use your main funded wallet, positioning wallet, or any account holding significant assets.

### Best Practices
1. Generate a fresh key pair specifically for `sealbox`.
2. Fund it via the [Shelby Faucet](https://faucet.shelbynet.shelby.xyz) with only the minimum amount needed for testing.
3. Never commit `.env` or paste your private key into logs, issues, or chat.
4. If using GitHub Actions (the optional `live-integration` job), store the key in **GitHub Repository Secrets** (`SIGNER_PRIVATE_KEY`), never inline in the workflow file.

## Reporting Vulnerabilities

If you discover a security vulnerability within `sealbox`, please open an issue or contact the maintainers directly. Do not disclose vulnerabilities publicly until a patch has been released.

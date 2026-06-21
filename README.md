# sealbox

A TypeScript / Node 22 CLI that "seals" a file to Shelby (shelbynet) as an immutable blob. Anyone can later prove the file is byte-identical to what was sealed, and when.

**v0.2.0** — Live Early-Access Ready

## Features
- **Seal**: SHA-256 hash, upload to Shelby S3 gateway, and sign with Ed25519.
- **Verify**: Re-fetch, re-hash, and verify cryptographic signatures.
- **List**: View all sealed files in a local manifest.
- **Doctor**: Preflight environment checks to validate live setup.
- **JSON Output**: Scripting-friendly `--json` flag on all commands.
- **Hardened**: Exponential backoff on S3/network errors, atomic manifest writes.

## Live Walkthrough

### 1. Setup Environment
Clone the repository and install dependencies:
```bash
git clone https://github.com/Rishidar-lab/sealbox.git
cd sealbox
npm install
npm run build
npm link
```

### 2. Configure Credentials
Copy `.env.example` to `.env` and fill in the values:
```bash
cp .env.example .env
```
- **SHELBY_API_KEY**: Get a free key at [geomi.dev](https://geomi.dev) to avoid anonymous rate limits.
- **SIGNER_PRIVATE_KEY**: Your Ed25519 private key hex. **Do not use your main wallet!** Use a dedicated throwaway key.

### 3. Fund Account
Visit the [Shelby Faucet](https://faucet.shelbynet.shelby.xyz) and fund your address with both **APT** (for gas) and **ShelbyUSD** (for storage).

### 4. Run Preflight Check
Validate your setup before attempting a live seal:
```bash
sealbox doctor
```
Expected output:
```text
sealbox doctor — preflight checklist
──────────────────────────────────────────────────
  ✓  SHELBY_S3_ENDPOINT           https://api.shelbynet.shelby.xyz/shelby
  ✓  SHELBY_API_KEY               (set — value hidden)
  ✓  SIGNER_PRIVATE_KEY           (set — value hidden)
  ✓  SHELBY_NETWORK               shelbynet
  ✓  S3 endpoint reachable        https://api.shelbynet.shelby.xyz/shelby
  ✓  APT balance > 0              0.1000 APT
  ✓  ShelbyUSD balance > 0        1.0000 ShelbyUSD
──────────────────────────────────────────────────

READY — all checks passed. You can run sealbox seal.
```

### 5. Seal a File
```bash
echo "Hello Shelby" > my-file.txt
sealbox seal my-file.txt
```
Expected output:
```text
Sealing my-file.txt (13 bytes)...

✓ Sealed successfully
  Seal ID:      a591a6d40bf42040
  SHA-256:      a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e
  Signer:       0x123...
  Explorer URL: https://explorer.shelby.xyz/shelbynet/blob/sealbox%2Fa591a6d40bf42040...
```

### 6. Verify the Seal
```bash
sealbox verify a591a6d40bf42040
```
Expected output:
```text
Verifying a591a6d40bf42040...

PASS ✓
  SHA-256:   a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e
  Sealed at: 2026-06-21T10:00:00.000Z
  Signer:    0x123...
  Sig check: ok
  Explorer:  https://explorer.shelby.xyz/shelbynet/blob/sealbox%2Fa591a6d40bf42040...
```

## Security
See [SECURITY.md](SECURITY.md) for critical warnings about private key handling.

## License
MIT

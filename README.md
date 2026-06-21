# sealbox

A TypeScript / Node 22 CLI that "seals" a file to Shelby (shelbynet) as an immutable blob. Anyone can later prove the file is byte-identical to what was sealed, and when.

## Features
- **Seal**: SHA-256 hash, upload to Shelby S3 gateway, and sign with Ed25519.
- **Verify**: Re-fetch, re-hash, and verify cryptographic signatures.
- **List**: View all sealed files in a local manifest.

## Setup

1. **Clone the repo**:
   ```bash
   git clone <repo_url>
   cd sealbox
   npm install
   ```

2. **Configure environment**:
   Copy `.env.example` to `.env` and fill in your details.
   - Get an API key at [geomi.dev](https://geomi.dev).
   - Fund your account via the [Shelby Faucet](https://faucet.shelbynet.shelby.xyz).

3. **Build**:
   ```bash
   npm run build
   npm link
   ```

## Usage

### Seal a file
```bash
sealbox seal ./path/to/file.txt
```

### Verify a seal
```bash
sealbox verify <sealId>
```

### List all seals
```bash
sealbox list
```

## Testing
```bash
npm test
```

## License
MIT

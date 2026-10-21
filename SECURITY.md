# Security Policy

## Private key handling

**CRITICAL WARNING**: `sealbox` requires an Ed25519 private key
(`SIGNER_PRIVATE_KEY`) to sign the record it writes to the manifest.

**You MUST use a dedicated, throwaway test key for this tool.**

Whoever holds this key can produce records that sealbox will verify as
authentic. If that key is a main funded wallet, then whoever holds it can
impersonate you in every sealbox record you ever produced.

**DO NOT** use your main funded wallet, positioning wallet, or any account
holding significant assets.

### Best practices

1. Generate a fresh key pair specifically for `sealbox`.
2. Fund it via the [Shelby Faucet](https://faucet.shelbynet.shelby.xyz) with
   only the minimum amount needed for testing.
3. Never commit `.env` (it is gitignored) and never paste your private key
   into logs, issues, chat, or CI output.
4. If you use GitHub Actions (the optional `live-integration` job), store the
   key in **GitHub Repository Secrets** (`SIGNER_PRIVATE_KEY`) — never inline
   in the workflow file.
5. Never ask anyone — including an AI assistant — to "check" your key. A
   key that has been pasted into a transcript should be considered burned.

### What sealbox does with the key

* The key is read from the environment and handed to
  `@aptos-labs/ts-sdk`'s `Ed25519PrivateKey`.
* The private key is **never** written to the manifest, never printed, and
  never included in `--json` output. `sealbox doctor` reports only *whether* a
  key is configured, never its value.
* After signing, sealbox calls the SDK's `clear()` on the key buffer. This is
  a **best-effort window-narrowing measure only**. JavaScript gives no
  guarantee that key material is erased from memory: the value also exists as
  an immutable string in `process.env`, may be copied by the garbage
  collector, may survive in JIT registers or on the engine stack, and is
  expanded into `BigInt` field elements inside the curve implementation. If
  you need real key-material hygiene, use a hardware-backed key or a
  non-extractable `crypto.subtle` key.
* The test suite contains only deterministic, publicly known, unfunded
  fixture keys. They are labelled as test fixtures and are not used by any
  release.

## Reporting a vulnerability

If you discover a security vulnerability within `sealbox`, please open a
private issue or contact the maintainers directly. Do not disclose
vulnerabilities publicly until a patch has been released.

## Hardening notes

* **Small-order public keys are rejected.** The Aptos SDK's
  `Ed25519PublicKey` constructor only validates the byte length, and the
  underlying curve verifier runs in ZIP-215 mode, which skips the small-order
  public-key rejection RFC 8032 relies on. Left unchecked, a record built on
  a small-order public key (for example the all-zero key) would verify
  against a signature nobody could have produced. sealbox validates the
  stored public key itself: it must be a strictly decoded (RFC 8032) curve
  point, must not be the identity element, and must lie in the prime-order
  subgroup. See `src/crypto.ts`.
* **The manifest is written atomically** (temp file + `fsync` + `rename`), and
  a manifest that cannot be parsed is reported rather than silently treated
  as empty.
* **Verification fails closed.** Malformed public keys, signatures, digests
  and signer identities are reported as typed failures; they never produce a
  `PASS`.

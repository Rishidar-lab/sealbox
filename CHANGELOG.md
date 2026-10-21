# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-21

A security-hardening and correctness release. It is not a response to a
reported exploitation of sealbox; it is the result of an internal review of
the v0.2.0 verification path, followed by a review of the Shelby storage
integration against the official Shelby documentation.

### Storage integration (contract conformance)

The v0.2.0 storage adapter was written against assumptions that the official
Shelby documentation does not support. Each point below was confirmed by
probing the live endpoints; see `docs/SHELBY-INTEGRATION.md`.

* **SigV4 signing region.** The Shelby S3 gateway signs with the region
  configured as its `server.region`, default `shelbyland`. v0.2.0 hard-coded
  `us-east-1`, which produces a signature the gateway rejects. The region is
  now `SHELBY_S3_REGION`, defaulting to `shelbyland`.
* **Bucket resolution.** A bucket must resolve to the Aptos account that
  owns the objects; the gateway supports legacy address-style bucket names.
  v0.2.0 hard-coded the literal `shelby`, which cannot resolve to any
  account. The bucket is now `SHELBY_S3_BUCKET`, defaulting to the signing
  account's address — the same address at seal time and the recorded
  `signerAddress` at verify time, so verification never needs the private
  key.
* **S3 signing credentials.** The gateway's `accessKeyId` /
  `secretAccessKey` are shared signing secrets, distinct from the Shelby
  API key. They are now `SHELBY_S3_ACCESS_KEY_ID` and
  `SHELBY_S3_SECRET_ACCESS_KEY`, falling back to `SHELBY_API_KEY`.
* **Request timeout.** The AWS SDK has no default request timeout, so a hung
  connection could block a seal or verify indefinitely. A bounded timeout
  (`SHELBY_S3_TIMEOUT_MS`, default 30 s) now aborts the request and is
  retried as a transient failure.
* **HTTP 401 and 403 are now distinct** (`AUTHENTICATION`,
  `AUTHORIZATION`) instead of being reported as a generic configuration
  error, so a blocked deployment names the actual cause.
* **The `{endpoint}/{bucket}/{key}` path shape was validated and left
  unchanged.** A probe of `GET /shelby/shelby/<key>` with an S3
  `Authorization` header returns the gateway's SigV4 error, proving an
  S3-compatible gateway is served at exactly that path.

### Fixed: `doctor` could never report a funded account

The balance check queried
`/accounts/{address}/resource/0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>`
percent-encoded. The fullnode rejects that form with **HTTP 400**
(`invalid struct tag`), so the check always reported "could not query" and
`doctor` could never reach READY. It now queries
`/accounts/{address}/balance/{coinType}`, which the node answers directly.
`doctor` also distinguishes a confirmed zero balance from a balance it could
not establish.

### Live integration

* Added `npm run integration:shelby`
  (`src/integration/live-shelby-smoke.ts`): a reusable harness that performs
  a real round trip — disposable fixture, local SHA-256, seal with a real
  Ed25519 signature, upload, download over the network, hash comparison,
  SealBox verification, and a local tamper check — with bounded retries, a
  request timeout, explicit HTTP status classification and a non-zero exit
  on any real failure. The remote object is never mutated to test tampering.
* **No successful live Shelby write is claimed.** The hosted gateway
  rejected the signing credentials with HTTP 401 and the account holds
  0 ShelbyUSD. The blocker and the exact continuation command are recorded
  in `docs/LIVE-SHELBY-BLOCKER.md`.

### Provenance

* `docs/PROVENANCE.md` records what the repository history proves about
  authorship and copyright, and what it cannot prove.
* `AUTHORSHIP.md` no longer claims sole authorship where the commit metadata
  says otherwise. The `LICENSE` notice is unchanged — see
  `docs/PROVENANCE.md` for why the copyright line was left alone.

### Security

- **Real Ed25519 verification.** `verifySignature()` no longer accepts a
  well-shaped but meaningless signature. sealbox now performs an actual
  Ed25519 signature verification over the canonical signed record, using
  `Ed25519PublicKey.verifyBytes()` from `@aptos-labs/ts-sdk`.
- **The public key is stored.** Manifest schema v2 records carry the signer's
  Ed25519 public key, so a record can be verified independently — by sealbox
  or by anyone else.
- **Signer identity is checked against the public key.** The Aptos
  authentication-key address derived from the stored public key must equal the
  stored `signerAddress`; otherwise verification fails with
  `SIGNER_MISMATCH`. Identity metadata can no longer be swapped while
  keeping a valid key/signature pair.
- **Canonical, domain-separated signed payload.** The signature now covers a
  versioned, length-prefixed, domain-separated record
  (`SEALBOX-MANIFEST-V2`) instead of a bare digest, so the metadata —
  including the timestamp and the storage identity — is authenticated too.
  The payload is deterministic, independent of JavaScript property ordering,
  locale-independent and free of unstable whitespace.
- **Fail-closed handling of malformed crypto.** Malformed public keys,
  signatures, digests and signer identities are reported as typed failures
  and never as a successful verification.
- **Small-order public keys are rejected.** The SDK's verifier runs in
  ZIP-215 mode, which skips the small-order public-key rejection; a record
  built on such a key would otherwise verify against a signature no signer
  could have produced. sealbox now validates the stored public key itself
  (strict RFC 8032 decoding, not the identity element, prime-order subgroup).
- **Explicit verification statuses.** `PASS` is now returned only when
  content integrity, signature authenticity and signer consistency all
  succeed. Failures are reported as `TAMPERED`, `INVALID_SIGNATURE`,
  `SIGNER_MISMATCH`, `INVALID_MANIFEST`, `UNSUPPORTED_SCHEMA`,
  `STORAGE_ERROR`, `NOT_FOUND`, `AMBIGUOUS_SEAL_ID` or
  `LEGACY_UNVERIFIABLE_SIGNATURE`, and the JSON output reports each
  verification component separately.

### Manifest

- **Schema v2.** Records carry `recordVersion`, `network`,
  `signatureScheme`, `signerPublicKey` and `signedPayloadVersion`.
- **Legacy v1 handling.** Schema v1 records are still parsed and their
  SHA-256 is still checked, but they are reported as
  `LEGACY_UNVERIFIABLE_SIGNATURE` with `signatureVerified: false`. They are
  never promoted to a verifiable record, and a record that carries v2 fields
  without a version marker is rejected as invalid rather than downgraded.
- **Corrupt manifests fail visibly.** A manifest that cannot be parsed is
  reported as an error instead of silently becoming an empty manifest, and
  it is never overwritten by a later write.
- **Seal-ID collision handling.** A record is never overwritten because its
  shortened seal ID matched another record; colliding records get a longer,
  still-unique prefix of the authoritative SHA-256 digest, and an ambiguous
  lookup is reported rather than resolved arbitrarily. The full SHA-256
  remains the authoritative content identifier.

### Reliability

- Atomic manifest writes are preserved and hardened (temp file, `fsync`,
  `rename`, directory flush, temporary-file cleanup on failure).
- The manifest is re-read from disk before a write, so a record added by
  another process is not clobbered.
- Storage: only transient failures are retried, retries stay bounded, and
  HTTP 401/402/403/429 are surfaced immediately instead of being retried or
  misreported.
- The storage endpoint is validated (scheme, credentials in URL) before use.
- Download bodies that are missing or of an unsupported type produce typed
  errors instead of a bare `TypeError`.
- `doctor` separates local configuration checks from live network checks and
  distinguishes a confirmed zero balance from a balance it could not
  establish.

### Tests

- Real cryptographic tests: the Ed25519 implementation is exercised locally
  against deterministic test-only keys. The cryptographic core is no longer
  mocked.
- Negative tests for forged signatures, mutated payloads, wrong public keys,
  wrong signer addresses, malformed keys and signatures.
- Tamper tests for one-byte modifications, truncation and empty replacements
  of stored content.
- A dedicated security regression suite (`src/security-regression.test.ts`)
  that reproduces the exact v0.2.0 defect and asserts the current
  implementation rejects it.
- Storage tests for upload, download, 404 propagation, transient retry,
  permanent failure, rate limiting, insufficient funds and bounded retries.
- CLI tests for `seal`, `verify`, `list`, `doctor` and `--json`, including
  the assertion that a forged signature can never yield
  `signatureVerified: true`.

### Documentation

- README rewritten so that the security claims match the implementation
  exactly, including an explicit list of what sealbox does **not** prove.
- The timestamp limitation is documented: `sealedAt` is a signer-attested
  timestamp, not an independently trusted one.
- "Immutable blob" is now attributed to Shelby's storage model rather than
  presented as an unconditional sealbox guarantee.
- The legacy v1 verification limitation is documented.
- SECURITY.md documents key handling, the limits of in-memory key clearing,
  and the small-order public-key hardening.

### Tooling

- `npm run lint` now runs ESLint (flat config) instead of a placeholder
  `echo`.
- `npm run typecheck` runs `tsc --noEmit`.
- Package metadata completed: description, repository, bugs, homepage,
  keywords, engines, `bin` and published `files`.
- `package.json` license corrected from `ISC` to `MIT`, matching the
  `LICENSE` file, the README and CONTRIBUTING.md.

## [0.2.0] - 2026-06-21
### Added
- Live Early-Access ready integration with Shelby.
- `sealbox doctor` command for preflight environment checks.
- `--json` flag across all commands for easier scripting.
- Exponential backoff and retry logic for S3/network operations.
- Clear error surfacing for insufficient funds and rate limits.
- Atomic writes and sha256 deduplication in the local manifest.
- Optional live-integration GitHub Actions job.
- Comprehensive documentation: live walkthrough in README, SECURITY.md, CONTRIBUTING.md.

## [0.1.0] - 2026-06-21
### Added
- Initial release.
- Core `seal`, `verify`, and `list` commands.
- Mock-tested scaffold with basic S3 upload and Ed25519 signing.

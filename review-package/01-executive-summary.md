# 01 — Executive summary

**Project:** SealBox — a TypeScript/Node CLI that seals artifacts to the
Shelby decentralized storage network and records a signed manifest.
**Release reviewed:** v0.3.0
**Code release SHA:** `89f657705864f3cf2d055f5c1fac5ccea56651c9`
(PR #2, merged into `main`; the release document was added by PR #3)

## What was wrong

v0.2.0 shipped a `verifySignature()` that performed **no cryptographic
verification**. It checked that the digest was 64 characters long, that the
signature string was non-empty and that the signer address was non-empty —
then returned `true`. `sealbox verify` therefore printed `PASS` for a
record whose signature no one had produced. The test suite concealed this:
it mocked the SDK and asserted that the string `"sig"` verified.

Two further defects were found during the v0.3.0 work:

1. **Small-order public keys authenticated.** The Aptos SDK's
   `Ed25519PublicKey` constructor validates only the byte length, and the
   curve verifier it uses runs in ZIP-215 mode, which skips the
   small-order public-key rejection RFC 8032 relies on. `verifyBytes()`
   returns `true` for the all-zero public key with the all-zero signature —
   a signature no legitimate signer can produce. v0.3.0 validates the
   stored public key itself.
2. **The storage integration did not match the documented Shelby
   contract.** The SigV4 region was hard-coded to `us-east-1` (the gateway
   signs with `shelbyland`), the bucket was hard-coded to a literal that
   cannot resolve to any account, the S3 signing credentials were the
   Shelby API key, and `sealbox doctor`'s balance query used a URL the
   fullnode answers with HTTP 400 — so `doctor` could never report a
   funded account. All four are fixed and covered by tests.

## What v0.3.0 does

* Real Ed25519 verification over a canonical, versioned, domain-separated
  signed record.
* Manifest v2 carries the public key, so any record can be verified
  independently — by SealBox or by anyone else.
* The signer address is derived from the stored public key and must match.
* Every v2 field is either signed or deterministically derived from signed
  fields.
* Verification is fail-closed and returns explicit statuses instead of a
  boolean.
* Schema v1 records are still readable and still integrity-checked, but
  are never presented as cryptographically verified.

## Status

| gate | result |
|---|---|
| typecheck / lint / build | PASS |
| tests | **174 passed / 8 suites**, real cryptography, not mocked |
| production audit | 0 vulnerabilities |
| clean-checkout reproduction | PASS |
| CI | green |
| **live Shelby round trip** | **NOT VERIFIED — BLOCKED on credentials and funding** |

## The one open item

The live round trip could not be executed. The hosted Shelby S3 gateway
rejected the signing credentials with **HTTP 401** (issued
`accessKeyId`/`secretAccessKey` are required and none is configured on this
host), and the account holds **0 ShelbyUSD**, so the on-chain commitment
registration an upload performs cannot be paid for. The exact continuation
command is one line:

```bash
npm run integration:shelby
```

See `07-live-shelby-evidence.md` and `docs/LIVE-SHELBY-BLOCKER.md`.

# 13 — Integration review request

**Project:** SealBox v0.3.0
**Code release SHA:** `89f657705864f3cf2d055f5c1fac5ccea56651c9`
**What we are asking for:** technical review of the **Shelby storage
integration semantics** and of the **reproducibility of the live
upload/retrieval verification path**.

## Scope of the request

SealBox v0.3.0 implements canonical signed artifact manifests with
Ed25519 verification, signer-derived identity checking, byte-integrity
verification, fail-closed legacy-v1 handling and adversarial tamper tests.
The cryptography is implemented on top of `@aptos-labs/ts-sdk` and
`@noble/curves` and is exercised by 174 local tests that execute the real
implementation.

We are **not** asking for a review of the cryptography — that is the part
we have the strongest evidence for. We are asking for review in two areas
where our evidence is weakest:

### 1. Shelby storage integration semantics

The v0.2.0 storage adapter made four assumptions that the official Shelby
documentation does not support. We corrected them against the official
docs and against live probes:

| area | what we changed | what we would like reviewed |
|---|---|---|
| SigV4 region | `us-east-1` → `shelbyland` (the gateway's `server.region` default) | whether `shelbyland` is correct for the hosted gateway, and whether a client should ever use `us-east-1` |
| bucket | literal `shelby` → the account address (legacy address-style bucket) | whether the address-style bucket is the right default, and how it interacts with the gateway's alias resolution and the "byte-sensitive address spelling" note in the compatibility page |
| signing credentials | the Shelby API key → separate `accessKeyId`/`secretAccessKey` | the correct credential model for the **hosted** gateway, which rejected the documented example values with HTTP 401 |
| per-blob expiry | not sent | whether the current gateway still requires `x-amz-meta-expiration-seconds` — an earlier revision of the docs said it did, the current page does not mention it |

We would also welcome review of the **path shape** `{endpoint}/{bucket}/{key}`
and `forcePathStyle: true` against the hosted gateway, and of the
`bucket = account address` choice at **seal** time versus the recorded
`signerAddress` at **verify** time, which we chose so that verification
never needs the private key.

### 2. Reproducibility of the live verification path

The live round trip is **currently blocked** and we have not claimed it
succeeds. We would like review of:

* the harness `src/integration/live-shelby-smoke.ts` — whether its
  sequence (fixture → local SHA-256 → seal → upload → download → hash
  comparison → verify → local tamper check) and its failure handling
  would actually convince a reviewer that a `PASS` means what it claims;
* the claim that a **local** tamper check is sufficient and that mutating
  the remote object to test tampering is unnecessary;
* the evidence in `docs/SHELBY-INTEGRATION.md` and
  `docs/LIVE-SHELBY-BLOCKER.md` — specifically whether the probes we ran
  are sufficient to establish the contract, or whether we have drawn a
  conclusion from a single observable that generalises poorly.

## What we already know we do not have

* A successful live Shelby round trip. The hosted gateway rejected the
  signing credentials with HTTP 401 and the account holds 0 ShelbyUSD.
* An external security audit.
* A settled copyright line — see `11-provenance.md`.

## Where to look

| file | contents |
|---|---|
| `src/storage.ts` | the S3 adapter: region, bucket, credentials, retry, timeout, status mapping |
| `src/cli.ts` | `makeStorageFromEnv`, the `doctor` balance check |
| `src/integration/live-shelby-smoke.ts` | the live harness |
| `src/integration/live-shelby-smoke.test.ts` | the harness's decision logic |
| `src/integration-config.test.ts` | the contract pinned by tests |
| `docs/SHELBY-INTEGRATION.md` | the contract, the probes, and the citations |
| `docs/LIVE-SHELBY-BLOCKER.md` | the blocker, the classification, the continuation command |
| `docs/release-v0.3-evidence.md` | the full session evidence |

## What would unblock the live half

```bash
npm run integration:shelby
```

with `SHELBY_S3_ENDPOINT`, `SHELBY_S3_ACCESS_KEY_ID`,
`SHELBY_S3_SECRET_ACCESS_KEY`, `SHELBY_API_KEY` and
`SIGNER_PRIVATE_KEY` set, and the account funded with ShelbyUSD. The
harness prints a non-secret evidence record and exits 0 only when every
stage succeeded.

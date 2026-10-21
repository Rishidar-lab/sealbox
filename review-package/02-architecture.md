# 02 — Architecture

```
                    ┌──────────────────────────────────────────┐
  sealbox seal ───▶ │ src/cli.ts        command surface        │
                    │ src/crypto.ts     Ed25519 + canonical   │
                    │                   signed payload          │
                    │ src/manifest.ts   local manifest v2/v1   │
                    │ src/storage.ts    Shelby S3 gateway      │
                    │ src/verification.ts  verification pipeline│
                    └───────────────┬──────────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────────┐
                    │ src/manifest.json  (atomic, fsync+rename)│
                    └──────────────────────────────────────────┘
```

## Module responsibilities

| module | responsibility | security-relevant property |
|---|---|---|
| `src/crypto.ts` | SHA-256, canonical signed payload, Ed25519 sign/verify, public-key validation, signer-address derivation | the only place a private key is touched; `clear()` is called afterwards |
| `src/verification.ts` | the verification pipeline and its status model | `PASS` requires every mandatory stage; every stage is evaluated independently and reported |
| `src/manifest.ts` | manifest schema v2, legacy v1 classification, atomic persistence, seal-ID collision handling | a corrupt manifest fails visibly; legacy records are never promoted |
| `src/storage.ts` | S3 client, bounded retry, request timeout, HTTP status mapping | retries only transient failures; 401/402/403/429 are surfaced immediately |
| `src/cli.ts` | `seal`, `verify`, `list`, `doctor`; environment injection | the private key never reaches stdout, stderr or `--json` |
| `src/errors.ts` | the typed error-code model | one code per failure class, so no failure collapses into "false" |
| `src/integration/live-shelby-smoke.ts` | opt-in live round trip | never prints a secret; never mutates the remote object; exits non-zero on failure |

## Data flow of a seal

1. read the artifact, compute SHA-256 and byte length;
2. derive the signer's public key and Aptos address;
3. build the canonical signed payload (domain-separated, length-prefixed);
4. sign it with Ed25519;
5. upload the bytes to the Shelby S3 gateway at the content-addressed key
   `sealbox/<sha256>`;
6. write a v2 manifest record atomically (temp file → `fsync` → `rename` →
   directory `fsync`).

## Data flow of a verify

1. load and classify the manifest (v2 or legacy);
2. retrieve the stored object;
3. rebuild the canonical signed payload from the recorded fields;
4. verify the Ed25519 signature over that payload with the stored key;
5. derive the signer address from the key and compare it with the stored
   address;
6. compare the retrieved bytes' size and SHA-256 with the record;
7. re-derive the seal ID and the explorer URL and compare them;
8. report the component results and a single status.

## Deliberate non-goals

* No distributed consensus, no multi-writer manifest, no lock file — the
  manifest is a single-user local file. The residual lost-update race
  between the re-read and the rename is documented rather than solved.
* No on-chain commitment registration inside SealBox. The Shelby S3
  gateway performs it, using the Aptos key it is configured with.
* No attempt to be a timestamping authority.

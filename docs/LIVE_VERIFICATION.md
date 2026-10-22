# Live Verification Record

A single, honest record of what was verified, how, and what remains blocked.
Every line is tiered: **TESTED** (automated test), **IMPLEMENTED** (code exists,
not independently proven here), **LIVE-VERIFIED** (proven against the real
network in this pass), **CITED** (proven in a prior documented run, not re-run
here), **BLOCKED** (cannot be shown without an external input), or **PLANNED**.

---

## Provenance

| field | value |
|---|---|
| recorded (UTC) | **2026-10-22T16:48:44Z** |
| base commit | `main` @ `14db93f2cb837169a8e1690e9e6d4bc1c2c44792` |
| changes this pass | source-hygiene fix to `src/crypto.test.ts`; README "validity vs. trust" section; `public/index.html` + `vercel.json`; this file + `COMPLETE.md` (committed as the child of the base commit) |
| verifier | automated gate run locally; live network **not** exercised this pass |

### Environment

| field | value |
|---|---|
| OS | Linux 7.0.0-38-generic x86_64 |
| Node.js | v22.23.3 (engines requires `>=22.12.0`) |
| npm | 10.9.9 |
| `@aptos-labs/ts-sdk` | 7.1.2 |
| `@noble/curves` | 2.2.0 (pinned; the curve impl the SDK uses) |
| `@aws-sdk/client-s3` | 3.1073.0 |
| `typescript` | 6.0.3 · `jest` 30.5.2 |

---

## 1. Local verification — performed fresh this pass

| check | command | result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** (TESTED) |
| lint | `npm run lint` | **PASS** (TESTED) |
| unit + regression tests | `npm test` | **174 passed / 8 suites, 0 failed** (TESTED) |
| production build | `npm run build` (`tsc`) | **PASS** (IMPLEMENTED/built) |
| CLI smoke | `node dist/index.js --version` / `--help` | **PASS** (prints `0.3.0`, usage) |
| GitHub CI on base commit | run `39640691478` | **success** (CITED — GitHub Actions) |
| GitHub CI on this pass's branch | runs on each commit | **all green** — Typecheck/Lint/Test/Build pass; **Vercel deployment pass** (LIVE-VERIFIED this pass). Live integration is now a separate `workflow_dispatch`-only workflow, so it is not a (skipped) PR check. |
| Vercel static deploy (`public/` + `vercel.json`) | PR #8 preview | **deployed green** — "public output directory not found" resolved; preview is behind Vercel access-protection (302 → SSO), so HTML not fetched anonymously |

### Core crypto invariants (all TESTED, real Ed25519, nothing mocked)

The cryptographic tests execute the real `@aptos-labs/ts-sdk` / `@noble/curves`
Ed25519 implementation against deterministic test-only keys.

| # | invariant | test(s) |
|---|---|---|
| 1 | valid Ed25519 signature → accept | `crypto.test.ts` "a signature made with the matching key verifies"; `verification.test.ts` "a well-formed record verifies with every component confirmed" |
| 2 | wrong public key → reject | `crypto.test.ts` "the same signature does NOT verify against a different public key"; `verification.test.ts` "swapping in another signer public key invalidates the signature" |
| 3 | altered digest → reject | `verification.test.ts` "editing the recorded digest invalidates the signature" + the `TAMPERED` content-integrity suite; `crypto.test.ts` "mutating the digest inside the signed record invalidates the signature" |
| 4 | altered signed metadata → reject | `crypto.test.ts` mutating timestamp / blobName / network / size; `verification.test.ts` editing blob name / timestamp / network |
| 5 | malformed signature → reject | `crypto.test.ts` "a malformed signature fails closed with a typed failure"; `verification.test.ts` "a malformed signature is rejected" |
| 6 | **untrusted signer → reject** | **out of scope by design — see §3.** The closest tested property is signer *consistency* (`SIGNER_MISMATCH`), not signer *trust*. |
| 7 | canonical serialization deterministic | `crypto.test.ts` "is deterministic for identical fields", "does not depend on JavaScript object property ordering", plus an independent reference parser pinning the length-prefixed framing |

Security regressions locked by tests (`security-regression.test.ts`):
the v0.2.0 shape-only "verification" defect (any non-empty signature accepted),
small-order / identity public keys, signer-identity swap, legacy-record
promotion, and corrupt-manifest masking.

---

## 2. Live Shelby round trip — NOT performed this pass

> **This pass did not run a live round trip: no Shelby credentials are present
> in this environment (`.env` absent, no `SHELBY_*` / `SIGNER_PRIVATE_KEY`).**
> The results below are **CITED** from the prior documented attempt recorded in
> [LIVE-SHELBY-BLOCKER.md](LIVE-SHELBY-BLOCKER.md) and
> [SHELBY-INTEGRATION.md](SHELBY-INTEGRATION.md). They are reproduced here, not
> re-measured, and are clearly marked as such.

| stage | status | reference |
|---|---|---|
| test object (sealId) | `c070d0733ba8ac8f` (CITED) | blob `sealbox/c070d0733ba8ac8f0d74c1e604f4aaa1422273e58ea221ab097da994fe06c915` |
| signing account | `0x2a58c57cf211474f902c67665b9708c0c1a621f04f4d8c5608a378db5ecc400b` (CITED) | |
| seal (canonical payload + real Ed25519) | **done** (CITED) | real SealBox v2 path |
| upload via official self-hosted S3 gateway | **HTTP 200 + on-chain ETag** (LIVE-VERIFIED, prior run) | account `sequence_number` advanced 0 → 4; four objects indexed |
| retrieval from Shelby | **HTTP 500 Internal Server Error** (BLOCKED) | anonymous tier stored the blob **un-encoded** (`stored_size == plaintext_size`) |
| downloaded digest verification | **not reached** (BLOCKED) | read failed before this stage |
| downloaded signature verification | **not reached** (BLOCKED) | read failed before this stage |
| remote-object tamper rejection | **never attempted** | by design the remote object is never mutated; the tamper check runs on a local copy of retrieved bytes |

### Root cause (CITED, independently reproduced)

The read fails because the bytes were stored without ClayCode erasure
encoding. **The official Shelby SDK's own upload path reproduces this with no
SealBox and no gateway in the loop** (`stored == plaintext`, read → 500), so it
is upstream behaviour of the anonymous tier, not a SealBox or gateway defect. A
correctly written blob stores more than the plaintext (the Shelby team's own
smoke blob: plaintext 40, stored 168) and reads 200.

### The one remaining input

A valid **Shelby API key** (from <https://geomi.dev>, network *Shelbynet*),
exercised through the self-hosted S3 gateway, is the only missing piece. The
account holds 1.0 APT and 0 ShelbyUSD; the prior registrations were free (gas
sponsored), so funding is not the observed blocker.

### How to finish it (owner-gated)

```bash
read -s SHELBY_GW_API_KEY        # never echoed, never logged
export SHELBY_GW_API_KEY
./scripts/live-shelby.sh         # starts the official gateway, runs the harness, tears it down
```

`scripts/live-shelby.sh` fails closed (exit 2) without the key, generates the
local S3 signing secrets, reads the Aptos key from `~/.shelby/config.yaml`, and
runs `npm run integration:shelby`. The harness
(`src/integration/live-shelby-smoke.ts`) exits non-zero unless **every** stage
succeeds — fixture, seal, upload, download, SHA-256 equality,
`signatureVerified`, signer-identity match, and a local tamper rejection. It
never reports "uploaded" as "verified" and prints no secret.

---

## 3. Cryptographic validity (A) vs. signer trust (B)

SealBox proves **(A) cryptographic validity** — the signature verifies over the
canonical, domain-separated record and the signer address is the one derived
from the stored key. It does **not** provide **(B) signer trust**: there is no
built-in allow-list of authorised signers, and a valid signature from an unknown
key is a valid signature, not a trusted one. Deciding which signer is
authoritative is the verifier's job (compare the reported `signerPublicKey` /
`signerAddress` against a key trusted out of band). This separation is
documented in the README and is intentional, not an omission to be patched
silently.

---

## 4. Known limitations

- **No successful Shelby read has ever been performed**, and none is claimed.
- **No live round trip was run in this pass** (no credentials in this
  environment). Live figures above are cited from the prior attempt.
- The cryptography is **not externally audited**; it is exercised by the
  project's own adversarial suite on top of `@aptos-labs/ts-sdk` /
  `@noble/curves`.
- `sealedAt` is a **signer-attested** timestamp, not independent / trusted
  timestamping.
- Storage **permanence and availability** are the Shelby provider's model, not a
  SealBox guarantee.
- No secret (private key, API key, S3 signing secret, Authorization header) was
  printed, logged, or committed at any point.

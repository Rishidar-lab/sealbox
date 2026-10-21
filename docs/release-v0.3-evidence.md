# SealBox v0.3.0 — Release Verification Evidence

This file is the chronological, machine-checkable record of the v0.3.0
finalization work. It is updated as evidence is produced; entries are never
edited to make a result look better than it was.

---

## E0 — Session start: frozen state

| item | value |
|---|---|
| recorded at | 2026-10-21T20:51:43+05:30 (Asia/Kolkata) |
| working tree | `/home/parzival/sealbox-work/sealbox` |
| branch | `fix/v0.3-cryptographic-verification` |
| HEAD | `cee5ac20bc0a37b633bf86250bbc5c675d70c51b` |
| `main` | `07def30dd409011c649dfac541ce3952bba16d2f` (untouched) |
| upstream | `origin/fix/v0.3-cryptographic-verification` (in sync) |
| working tree state | clean — 0 modified / 0 untracked entries |
| Node | v22.23.3 |
| npm | 10.9.9 |
| OS | Ubuntu 24.04.5 LTS, Linux 7.0.0-38-generic x86_64 |
| git / gh | git 2.43.0, gh 2.45.0 |
| PR #2 | OPEN, MERGEABLE, `mergeStateStatus: UNSTABLE`, head `cee5ac2` |
| CI (GitHub Actions) | `Typecheck / Lint / Test / Build` = **pass** (push + PR runs) |
| CI (Live Integration) | `skipped` (manual-dispatch only) |

### Divergence from the previous run's report

1. **Path.** The task named `/home/parzival/sealbox`. That path does not
   exist on this host. The repository containing the v0.3.0 branch, PR #2 and
   the pushed commits is at `/home/parzival/sealbox-work/sealbox` (a clone
   of `https://github.com/Rishidar-lab/sealbox.git`). All work continues
   there. No second clone was created and no history was rewritten.
2. **New failing status: `Vercel :: failure`.** This status was not present
   when PR #2 was created. Investigation (§E1 below) shows it is **pre-existing
   on `main`** and is not caused by this branch.
3. `mergeStateStatus` is `UNSTABLE` for the same reason (the Vercel status),
   even though the project's own GitHub Actions CI is green.

---

## E1 — Vercel status triage (pre-existing, not caused by this branch)

Evidence:

```
$ gh api repos/Rishidar-lab/sealbox/commits/07def30.../status --jq '.statuses[]'
Vercel :: failure :: Deployment has failed ... dpl_EKXvKZime7bUzrbysXxaT8wfausg   <-- main (v0.2.0)

$ gh api repos/Rishidar-lab/sealbox/commits/cee5ac2.../status --jq '.statuses[]'
Vercel :: failure :: Deployment has failed ... dpl_2TFNRLtRtwhN1qr7x4J7NwcS9BHx   <-- this branch
CodeRabbit :: success
```

* The identical status fails on `main` at `07def30`, the pre-existing
  v0.2.0 release commit. It is therefore an **inherited repository
  condition**, not a regression introduced by the v0.3.0 work.
* No deployment configuration is tracked in the repository:
  `git ls-files | grep -iE 'vercel|netlify|now\.json'` → no matches.
  There is no `vercel.json` and no `.vercel` directory.
* SealBox is a Node.js CLI / library with a `bin` entry point and a
  `dist/` build output; it has no serverless entry point, no framework and
  no build command that a Vercel deployment would use.
* The Vercel API requires an authentication token; none is configured on this
  host, so the deployment log could not be read. That is stated rather than
  worked around.

**Conclusion:** the Vercel status is a repository-level integration that is
misconfigured for a CLI project, and it is failing identically before and
after this branch. It is not a SealBox software gate. It was deliberately
**not** "fixed" by adding deployment configuration, because that would alter
the maintainer's external Vercel project — an irreversible external action
outside the scope of this work, and unrelated to the v0.3.0 security scope.

---

## E2 — Security baseline re-verification

See §E3 for the command-by-command results.

---

## E3 — Full verification matrix (2026-10-21, this session)

All commands run from the repository root on the branch at the time of
execution. "PASS" means a zero exit status.

| # | command | result |
|---|---|---|
| 1 | `npm ci` | **PASS** |
| 2 | `npm run typecheck` | **PASS** |
| 3 | `npm run lint` | **PASS** (ESLint 9, flat config, zero findings) |
| 4 | `npm test` | **PASS** — 174 tests / 8 suites |
| 5 | `npm run build` | **PASS** |
| 6 | `npm audit --omit=dev` | **PASS** — 0 vulnerabilities |
| 7 | `npm audit` (all) | 20 moderate, dev-toolchain only; single root cause `sprintf-js` (via `babel-plugin-istanbul` → `@istanbuljs/load-nyc-config` → `js-yaml` → `argparse`); **no upstream fix exists** (latest `sprintf-js` is 1.1.3, advisory range `<=1.1.3`). The pre-existing critical `handlebars` finding was resolved to 4.7.10. |
| 8 | `node dist/index.js --version` | `0.3.0` |
| 9 | `node dist/index.js --help` | renders all four commands |
| 10 | version consistency | `package.json`, `package-lock.json` (both `version` and `packages[""].version`), CLI `.version()` and the CHANGELOG heading all read `0.3.0` |
| 11 | each of the 5 v0.3.0 commits in isolation | `typecheck`, `lint`, `test` and `build` all PASS for every commit |

Test count grew from 145 to 174 across this session: 2 content-integrity
cases that were missing (appended data, prepended data), 9
integration-configuration cases, 2 request-timeout cases, 2 HTTP
status-mapping cases, 1 authentication-not-retried case, 2 doctor
balance cases and 11 live-harness cases.

---

## E4 — Security invariants, verified from source

Confirmed by reading the code, not by trusting test names.

### 1. Signature verification — `src/crypto.ts`

* `verifyEd25519Signature()` first calls `validateEd25519PublicKey()`,
  which requires a strictly decoded (RFC 8032, not ZIP-215) compressed
  Edwards point, rejects the identity element and rejects any point
  outside the prime-order subgroup. A public key of the right length
  that is not a usable key is reported as `MALFORMED_PUBLIC_KEY`.
* The signature is parsed by `new Ed25519Signature(...)`; a malformed
  signature is reported as `MALFORMED_SIGNATURE`.
* The check itself is `Ed25519PublicKey.verifyBytes()`, which also
  rejects non-canonical (malleable) `S` values.
* The function never throws: every failure path returns a typed
  `Ed25519Verification`.

### 2. Canonical signed payload — `src/crypto.ts`

`createSignedPayload()` emits, in this fixed order, each value
length-prefixed with its UTF-8 byte length:

```
SEALBOX-MANIFEST-V2
payloadVersion
sha256
sizeBytes
blobName
sealedAt
network
signerPublicKey
```

Field-by-field coverage of the v2 record:

| record field | covered how |
|---|---|
| `signedPayloadVersion` | must equal `SIGNED_PAYLOAD_VERSION` (`"2"`), which is the same constant written into the signed `payloadVersion` |
| `signatureScheme` | must equal `ed25519`; it selects the verification algorithm |
| `recordVersion` | must be `2`; the record shape is pinned by the manifest classifier |
| `sha256` | **signed** |
| `sizeBytes` | **signed** |
| `blobName` | **signed** |
| `sealedAt` | **signed** |
| `network` | **signed** |
| `signerPublicKey` | **signed** |
| `signature` | the signature over the fields above |
| `signerAddress` | **derived** from `signerPublicKey` and compared to the stored value |
| `sealId` | **derived**: must be a prefix of the signed `sha256` |
| `explorerUrl` | **derived**: recomputed from the signed `network` + `blobName` |

Every field is either signed or deterministically derived from signed
fields; none is presented as authenticated without being covered.

### 3. Signer identity — `src/crypto.ts`, `src/verification.ts`

`deriveSignerAddress()` uses `publicKey.authKey().derivedAddress()` — the
same SDK semantics as the sealing path — rendered in long AIP-40 form.
`addressesMatch()` compares the derived address with the stored
`signerAddress`; a mismatch is `SIGNER_MISMATCH`. `signerVerified` is
only true when the signature verified **and** the address matched.

### 4. Content integrity — `src/verification.ts`

Rejection confirmed for: one-byte modification, truncation, **appended
data** (added this session), **prepended data** (added this session),
same-size byte substitution, empty replacement, size mismatch, malformed
manifest and corrupt manifest.

### 5. Legacy v1 — `src/manifest.ts`, `src/verification.ts`

`classifyManifestEntry()` returns `legacy` for a record with no
`recordVersion` and no v2-only field, and `invalid` for a record that
carries v2-only fields without a version marker — so a v2 record cannot
be silently downgraded to legacy. The legacy verification path returns
`LEGACY_UNVERIFIABLE_SIGNATURE` with `integrityVerified: true`,
`signatureVerified: false`, `signerVerified: false` and `ok: false`.

### 6. Secret handling

* `git grep` over the entire history finds no PEM `PRIVATE KEY` block,
  no `xprv` and no mnemonic.
* The only 32-byte hex literals in the tree are the deliberately
  unfunded test fixtures and the corresponding **public** keys and
  addresses.
* The private key reaches exactly one place: `createSigner()`, which
  passes it to the SDK and calls `clear()` afterwards. It is never
  written to the manifest, never printed and never included in `--json`
  output. `doctor` reports only whether a key is configured.
* `.gitignore` covers `.env` and `.env.*` (keeping `.env.example`).

---

## E5 — Shelby contract investigation (2026-10-21)

Full detail in [SHELBY-INTEGRATION.md](SHELBY-INTEGRATION.md). Summary:

* The hosted endpoint `https://api.shelbynet.shelby.xyz/shelby` serves
  **both** the blob RPC (`/v1/blobs/{account}/{blob}`) **and** an
  S3-compatible gateway (`/{bucket}/{key}`). Proved by the SigV4 error
  the gateway returns at the S3 path.
* The inherited `{endpoint}/{bucket}/{key}` path shape is therefore
  **correct** and was left unchanged.
* The v0.2.0 adapter was nevertheless wrong in four documented ways
  (SigV4 region, bucket, signing credentials, and the `doctor` balance
  URL, which returned HTTP 400). All four were fixed — see commit
  `821dfee`.
* The account holds 1.0000 APT and **0 ShelbyUSD**.
* The maintainer's own `shelby_daily.log` shows the **official** Shelby
  CLI failing on every upload with
  `Cannot convert @<address>/… to a BigInt` — an upstream SDK failure,
  independent of SealBox.

---

## E6 — Live Shelby round trip

**NOT EXECUTED — BLOCKED.** Full detail in
[LIVE-SHELBY-BLOCKER.md](LIVE-SHELBY-BLOCKER.md).

The harness reached the real endpoint and was rejected:

```
BLOCKED: AUTHENTICATION
  Storage endpoint rejected the supplied credentials (HTTP 401).
```

Two independent blockers:

1. **Credentials.** The hosted gateway needs an issued
   `accessKeyId`/`secretAccessKey` (obtained with a Shelby API key from
   geomi.dev). No such key exists on this host — not in the
   environment, not in `~/.shelby/config.yaml`, and there is no `.env`
   for this project. Obtaining one requires a human sign-up.
2. **Funding.** The account holds 0 ShelbyUSD, so the on-chain
   commitment registration that an upload performs cannot be paid for.
   The official faucet can grant it (the maintainer's own automation
   calls it daily) but that is a wallet-affecting action reserved for the
   maintainer.

No successful live write is claimed. The remote object was never
mutated. No verification logic was weakened.

---

## E7 — Verification matrix after the integration fixes

| command | result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 0 findings |
| `npm test` | PASS — 174 tests / 8 suites |
| `npm run build` | PASS |
| `npm audit --omit=dev` | PASS — 0 vulnerabilities |
| `npm run integration:shelby` (no credentials) | exit 2 — `BLOCKED: MISSING_CONFIGURATION` |
| `npm run integration:shelby` (local identity, real endpoint) | exit 1 — `BLOCKED: AUTHENTICATION`, HTTP 401 |

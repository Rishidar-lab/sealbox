# SealBox v0.3.0 — Release Document

> ## ⚠ NETWORK INTEGRATION: NOT VERIFIED
>
> This release has **not** been proven against the live Shelby network.
> The live seal/upload/download/verify round trip is **BLOCKED** on
> credentials and funding (see [LIVE-SHELBY-BLOCKER.md](LIVE-SHELBY-BLOCKER.md)).
>
> Everything below the banner — the cryptography, the manifest format, the
> verification semantics, the adversarial tests and the storage contract —
> is verified. The one thing that is *not* verified is that a blob written
> through the real Shelby endpoint comes back byte-identical through the
> real Shelby endpoint.

| | |
|---|---|
| release | SealBox v0.3.0 |
| release SHA (merge) | `89f657705864f3cf2d055f5c1fac5ccea56651c9` |
| branch merged | `fix/v0.3-cryptographic-verification` (PR #2) |
| base | `07def30dd409011c649dfac541ce3952bba16d2f` (v0.2.0) |
| released | 2026-10-21 |
| licence | MIT (see `LICENSE`; provenance note in `docs/PROVENANCE.md`) |
| live Shelby round trip | **NOT VERIFIED — BLOCKED** |

---

## 1. What changed since v0.2.0

v0.2.0 advertised signature verification but did not perform any. Its
`verifySignature()` checked only that the digest was 64 characters long,
that the signature string was non-empty and that the signer address was
non-empty — then returned `true`. v0.3.0 replaces that with a real
Ed25519 verification over a canonical, domain-separated, versioned signed
record, and adds the public key to the manifest so the record can be
verified independently.

Full history: [`CHANGELOG.md`](../CHANGELOG.md).

### Cryptographic properties

| property | how it is established |
|---|---|
| **Content integrity** | SHA-256 of the retrieved bytes compared with the recorded digest, and the byte length compared with the recorded size |
| **Signature authenticity** | real Ed25519 verification (`Ed25519PublicKey.verifyBytes`) over the canonical signed payload |
| **Signer consistency** | the Aptos authentication-key address derived from the stored public key must equal the stored `signerAddress` |
| **Metadata coverage** | every v2 field is either signed or deterministically derived from signed fields (see §3) |
| **Public-key soundness** | the stored key must be a strictly decoded (RFC 8032), non-identity, prime-order-subgroup Ed25519 point |
| **Fail-closed** | malformed keys, signatures, digests, identities, manifests and payloads never produce `PASS` |

### Canonical signed payload

```
SEALBOX-MANIFEST-V2\n
payloadVersion:<len>:<value>\n
sha256:<len>:<value>\n
sizeBytes:<len>:<value>\n
blobName:<len>:<value>\n
sealedAt:<len>:<value>\n
network:<len>:<value>\n
signerPublicKey:<len>:<value>\n
```

`<len>` is the UTF-8 byte length of the value. Length prefixing makes the
encoding injective, so no field value can forge a field boundary. Field
order is fixed in code; sizes are plain decimal integers; line endings are
LF with no trailing whitespace; the domain separator is unique to SealBox.

### Manifest v2

```
recordVersion, sealId, blobName, sha256, sizeBytes, sealedAt, network,
signatureScheme, signerPublicKey, signerAddress, signature, explorerUrl,
signedPayloadVersion
```

Encodings: public key `0x`+64 hex, signature `0x`+128 hex, signer address
`0x`+64 hex (long AIP-40 form), digest 64 lowercase hex. No private key and
no API secret is ever stored.

### Legacy v1 compatibility

Schema v1 records are still parsed and their SHA-256 is still checked, but
they are reported as `LEGACY_UNVERIFIABLE_SIGNATURE` with
`signatureVerified: false` and a non-zero exit code. A legacy record is
never promoted to a cryptographically verifiable record, and a record
carrying v2 fields without a version marker is rejected rather than
downgraded. A legacy record cannot acquire a trustworthy historical
signature retroactively.

---

## 2. Test matrix

| command | result |
|---|---|
| `npm ci` | PASS |
| `npm run typecheck` (`tsc --noEmit`) | PASS |
| `npm run lint` (ESLint 9) | PASS — 0 findings |
| `npm test` | **PASS — 174 tests / 8 suites** |
| `npm run build` (`tsc`) | PASS |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm audit` (all) | 20 moderate, **dev toolchain only**, one root cause (`sprintf-js` via `babel-plugin-istanbul` → `@istanbuljs/load-nyc-config` → `js-yaml` → `argparse`); no upstream fix exists (latest `sprintf-js` 1.1.3, advisory range `<=1.1.3`). The pre-existing critical `handlebars` was resolved to 4.7.10. |
| `node dist/index.js --version` | `0.3.0` |
| `node dist/index.js --help` | renders all four commands |
| version consistency | `package.json`, `package-lock.json` (both fields), CLI `.version()`, CHANGELOG heading — all `0.3.0` |
| clean-checkout reproduction | fresh clone of `main` at `89f6577`: `npm ci`, typecheck, lint, **174 tests**, build, audit — all PASS |
| per-commit verification | every commit in the release range: typecheck, lint, test, build all PASS |
| CI | `Typecheck / Lint / Test / Build` green on both the push and the PR run |

### Adversarial coverage (real crypto, not mocked)

The cryptographic core is exercised against the real
`@aptos-labs/ts-sdk` / `@noble/curves` implementation using deterministic,
clearly-fake, unfunded test keys. Only the network and storage boundaries
are mocked.

* **SHA-256** — known vectors, empty input, binary input, distinctness.
* **Sign/verify** — matching key verifies; wrong key fails; mutated
  payload, digest, timestamp, blob name, network and size all fail;
  malformed signature and malformed public key fail with typed failures;
  hostile input never throws.
* **Public-key soundness** — the all-zero and identity-element keys are
  rejected, closing a real forgery path in the SDK's verifier.
* **Signer identity** — derived address matches; a valid signature with a
  swapped stored address is `SIGNER_MISMATCH`.
* **Content integrity** — one-byte edit, truncation, appended data,
  prepended data, same-size substitution, empty replacement and size
  mismatch are all `TAMPERED`.
* **Legacy v1** — parseable, identifiable, `signatureVerified: false`,
  `ok: false`, never promoted.
* **Manifest** — round trip, atomic write, dedupe, concurrent-write
  safety, corrupt JSON, unsupported schema, contradictory records,
  seal-ID collisions (both records preserved, ambiguous lookup reported).
* **Storage** — upload, download, 404 propagation, transient retry,
  permanent failure, 401/402/403/429 mapping, bounded retries, request
  timeout, endpoint validation, secret-free error messages.
* **CLI** — `seal`, `verify`, `list`, `doctor`, `--json`; a forged
  signature can never yield `signatureVerified: true`; the private key
  never reaches any output.
* **Regression** — `src/security-regression.test.ts` reproduces the exact
  v0.2.0 defect and asserts the current implementation rejects it.

---

## 3. Field coverage of the signed record

| field | coverage |
|---|---|
| `sha256`, `sizeBytes`, `blobName`, `sealedAt`, `network`, `signerPublicKey` | **signed** |
| `signedPayloadVersion` | must equal the `payloadVersion` inside the signed payload |
| `signatureScheme` | must be `ed25519`; selects the verification algorithm |
| `recordVersion` | must be `2`; pins the record shape |
| `signerAddress` | **derived** from `signerPublicKey`, compared to the stored value |
| `sealId` | **derived**: must be a prefix of the signed `sha256` |
| `explorerUrl` | **derived**: recomputed from the signed `network` + `blobName` |
| `signature` | the signature over the fields above |

---

## 4. Live Shelby evidence

**None. The round trip is blocked.**

| item | value |
|---|---|
| network | `shelbynet` (Aptos L1, chain id 119) |
| endpoint | `https://api.shelbynet.shelby.xyz/shelby` |
| public account | `0x2a58c57cf211474f902c67665b9708c0c1a621f04f4d8c5608a378db5ecc400b` |
| APT balance | 1.0000 APT |
| ShelbyUSD balance | **0** |
| attempt | `npm run integration:shelby` → exit 1 |
| result | `BLOCKED: AUTHENTICATION` — HTTP 401 from the real endpoint |

Two independent blockers: the hosted S3 gateway needs issued
`accessKeyId`/`secretAccessKey` (obtained with a Shelby API key from
geomi.dev; none is configured on this host), and the account holds no
ShelbyUSD, so the on-chain commitment registration an upload performs
cannot be paid for. Full detail and the exact continuation command:
[LIVE-SHELBY-BLOCKER.md](LIVE-SHELBY-BLOCKER.md).

What *was* established against the live endpoints (read-only probes, all
quoted with their HTTP results): the S3 gateway is served at the
`{endpoint}/{bucket}/{key}` path (a SigV4 error is returned there), the
blob RPC is served at `{rpcEndpoint}/v1/blobs/{account}/{blob}`, the RPC
requires a bearer API key for writes, and the fullnode's
`/accounts/{address}/balance/{coinType}` form works while the generic
`/resource/…CoinStore<…>` form returns HTTP 400. See
[SHELBY-INTEGRATION.md](SHELBY-INTEGRATION.md).

---

## 5. Known limitations

* **No live Shelby round trip.** See §4.
* **The `sealedAt` timestamp is signer-attested, not independently
  trusted.** The signature proves "the signer attested to this value".
* **No legal-identity claim.** The signer address is derived from the key;
  it says nothing about who holds the key.
* **No permanence guarantee.** Shelby's *immutable blob* is the storage
  provider's model, not a SealBox guarantee.
* **No third-party notarization, no malware safety, no copyright or
  ownership determination, and no provenance predating the seal.**
* **No external security audit.** The cryptography is implemented on top of
  `@aptos-labs/ts-sdk` and `@noble/curves` and exercised by this
  repository's own adversarial suite.
* **The LICENSE copyright line remains an open question for a human
  maintainer.** The repository history shows two author identities; the
  notice was deliberately left untouched. See
  [PROVENANCE.md](PROVENANCE.md).
* **A pre-existing Vercel deployment status fails on `main` as well.** It
  is a repository-level integration for a CLI project, not a SealBox gate.
* **The official Shelby CLI's own upload is broken upstream** (per the
  maintainer's own log: `Cannot convert @<address>/… to a BigInt`).

---

## 6. Reproducibility

```bash
git clone https://github.com/Rishidar-lab/sealbox.git
cd sealbox
git checkout 89f657705864f3cf2d055f5c1fac5ccea56651c9
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev
node dist/index.js --version
```

Live round trip (once the blocker is cleared):

```bash
SHELBY_S3_ENDPOINT="http://localhost:9000" \
SHELBY_S3_ACCESS_KEY_ID="<S3_ACCESS_KEY_ID>" \
SHELBY_S3_SECRET_ACCESS_KEY="<S3_SECRET_ACCESS_KEY>" \
SHELBY_API_KEY="<YOUR_API_KEY>" \
SIGNER_PRIVATE_KEY="<YOUR_APTOS_PRIVATE_KEY>" \
npm run integration:shelby
```

Supporting documents:
[`docs/release-v0.3-evidence.md`](release-v0.3-evidence.md) ·
[`docs/SHELBY-INTEGRATION.md`](SHELBY-INTEGRATION.md) ·
[`docs/LIVE-SHELBY-BLOCKER.md`](LIVE-SHELBY-BLOCKER.md) ·
[`docs/PROVENANCE.md`](PROVENANCE.md) ·
[`SECURITY.md`](../SECURITY.md)

# sealbox

A TypeScript / Node.js CLI that **seals** a file to [Shelby](https://shelbynet.shelby.xyz)
and records a signed, independently verifiable manifest entry for it.

**v0.3.0** — Security-hardening release. Real Ed25519 verification, signed
manifest schema v2, explicit verification statuses.

---

## What Sealbox proves

When `sealbox verify <sealId>` prints `PASS`, all of the following have been
checked by code (and are covered by the test suite):

1. **Content integrity** — the bytes retrieved from storage hash to the
   SHA-256 digest recorded in the manifest, and their length matches the
   recorded size.
2. **Signature authenticity** — the recorded Ed25519 signature verifies
   cryptographically against the stored public key, over the exact canonical
   signed record (see [Signed payload](#signed-payload)).
3. **Signer consistency** — the stored signer address is derived from the
   stored public key using the same Aptos authentication-key derivation used
   when sealing. A record whose address does not match its key is rejected.

In a schema v2 record, every field is either **signed** or **deterministically
derived from signed fields**:

| field                | covered by                                       |
|----------------------|--------------------------------------------------|
| `sha256`             | signed                                           |
| `sizeBytes`          | signed                                           |
| `blobName`           | signed                                           |
| `sealedAt`           | signed                                           |
| `network`            | signed                                           |
| `signerPublicKey`    | signed                                           |
| `signature`          | the signature over the fields above              |
| `signerAddress`      | derived from `signerPublicKey` and compared      |
| `sealId`             | derived: must be a prefix of `sha256`            |
| `explorerUrl`        | derived: recomputed from `network` + `blobName`  |
| `signatureScheme`    | must be `ed25519`                                |
| `signedPayloadVersion` | must be `2`                                    |

### Cryptographic validity vs. signer trust

A `PASS` establishes two things and deliberately stops short of a third:

- **(A) cryptographic validity** — the signature verifies over the canonical
  signed record, and the signer address is the one derived from the stored
  public key. This is what the test suite exercises.
- **(B) signer trust** — *not* provided. Sealbox does not decide whether a
  given key is one you should trust, and it has no built-in allow-list of
  authorised signers. Deciding which signer is authoritative is the verifier's
  responsibility: compare the reported `signerPublicKey` / `signerAddress`
  against a key you already trust out of band.

The two are kept separate on purpose — a valid signature from an unknown key
is still a valid signature, not a trusted one.

## What Sealbox does **not** prove

Please read this before relying on a `PASS`:

- **It does not prove the artifact was truthful.** Sealbox proves that the
  bytes you get back are the bytes that were signed. It says nothing about
  whether those bytes were true when they were sealed.
- **It does not prove the legal identity of the human or operator behind the
  key.** The signer address is derived from the public key. That is a
  cryptographic consistency check, not an identity claim: it says nothing
  about who holds the key, whether they were authorised to sign, or whether
  the key is the one you think it is.
- **`sealedAt` is a signer-attested timestamp, not an independently trusted
  timestamp.** It is the time the signing machine believed it was. It is
  covered by the signature — "the signer attested to this timestamp value" —
  but no independent authority proved the artifact existed at that instant.
  Use an external trusted-timestamping service if you need that.
- **It does not prove that the contents of a signed manifest are true.** A
  signed record faithfully carries what the signer put in it. Whether the
  statements inside are accurate is a different question.
- **It does not prove permanence of storage.** Sealbox writes to Shelby's
  object store. Shelby's product is described as providing *immutable blobs*;
  that is **the storage provider's model, not a guarantee Sealbox can make**.
  Availability, retention and the provider's operational integrity are outside
  this tool's control.
- **It does not prove continuous Shelby availability**, nor that the Shelby
  network, gateway or account remains reachable or solvent.
- **It is not third-party notarization.** Nothing in Sealbox involves an
  independent notary, timestamping authority or attestation service. The only
  parties are you and the key you control.
- **It does not prove the artifact is safe to run.** Sealbox checks bytes and
  signatures. It performs no malware scanning, no content inspection and no
  safety analysis of any kind.
- **It does not settle copyright or ownership questions.** A signature
  attests that a key signed a record. It says nothing about who owns the
  content, whether the signer had the right to sign it, or whether the
  content infringes anything.
- **It does not prove provenance that predates the seal.** Sealbox can only
  attest to a record from the moment it was signed. It cannot show that the
  artifact existed, or who created it, before that point.
- **It has not been externally audited.** The cryptography is implemented on
  top of `@aptos-labs/ts-sdk` and `@noble/curves` and is exercised by the
  project's own adversarial test suite, but no third party has reviewed it.
- **It does not provide non-repudiation against the signer.** A signer can
  always discard the key that produced a signature.

---

## Install

Requires **Node.js >= 22.12.0** (the Aptos SDK is ESM-only and is loaded with
Node's `require(esm)` support).

```bash
git clone https://github.com/Rishidar-lab/sealbox.git
cd sealbox
npm ci
npm run build
npm link          # optional: puts `sealbox` on your PATH
```

## Configure

```bash
cp .env.example .env
```

| variable              | required | purpose                                              |
|-----------------------|----------|------------------------------------------------------|
| `SHELBY_S3_ENDPOINT`  | yes      | S3-compatible gateway URL                            |
| `SHELBY_API_KEY`      | no       | avoids anonymous rate limits (get one at geomi.dev)  |
| `SHELBY_NETWORK`      | no       | defaults to `shelbynet`                              |
| `SHELBY_FULLNODE_URL` | no       | fullnode used by `doctor` for balance checks         |
| `SIGNER_PRIVATE_KEY`  | yes      | Ed25519 private key (plain hex or AIP-80)           |

> **Use a dedicated throwaway key.** Never your main funded wallet. See
> [SECURITY.md](SECURITY.md). Never paste a private key into a chat, an
> issue, or a log.

`.env` is gitignored. Sealbox never prints, logs or stores the private key.

## Usage

```bash
sealbox seal ./report.pdf          # hash, upload, sign, record
sealbox verify <sealId>            # re-fetch, re-hash, verify signature + signer
sealbox verify <sealId> --json     # machine-readable result
sealbox list                       # every record in the local manifest
sealbox doctor                     # preflight: local config and live network
sealbox doctor --json              # machine-readable preflight
```

### `sealbox verify` statuses

`PASS` is returned **only** when every mandatory stage succeeds. Every other
outcome has its own status:

| status                          | meaning                                                            |
|---------------------------------|--------------------------------------------------------------------|
| `PASS`                          | integrity, signature and signer identity all verified              |
| `NOT_FOUND`                     | no such seal ID, or the object is not in storage                   |
| `TAMPERED`                      | the retrieved bytes do not match the recorded digest or size       |
| `INVALID_SIGNATURE`             | the signature is malformed or does not verify                      |
| `SIGNER_MISMATCH`               | the signature verifies but the address does not match the key      |
| `INVALID_MANIFEST`              | the record is structurally invalid (or the manifest is corrupt)    |
| `UNSUPPORTED_SCHEMA`            | unknown record/payload/scheme version                              |
| `STORAGE_ERROR`                 | the stored object could not be retrieved                           |
| `LEGACY_UNVERIFIABLE_SIGNATURE` | a schema v1 record: integrity checked, authenticity not checkable  |
| `AMBIGUOUS_SEAL_ID`             | more than one record matches the requested short seal ID           |

The JSON form additionally reports each verification component separately:

```json
{
  "ok": false,
  "status": "INVALID_SIGNATURE",
  "sealId": "b94d27b9934d3e08",
  "legacyRecord": false,
  "integrityVerified": true,
  "signatureVerified": false,
  "signerVerified": false,
  "detail": "Ed25519 signature does not verify against the stored public key and the canonical signed payload."
}
```

## Manifest schema v2

A v2 record (`recordVersion: 2`):

```json
{
  "recordVersion": 2,
  "sealId": "b94d27b9934d3e08",
  "blobName": "sealbox/b94d27b9...",
  "sha256": "b94d27b9...",
  "sizeBytes": 11,
  "sealedAt": "2026-10-21T12:00:00.000Z",
  "network": "shelbynet",
  "signatureScheme": "ed25519",
  "signerPublicKey": "0xd04ab232...",
  "signerAddress": "0x147e4d3a...",
  "signature": "0xedbf4dd3...",
  "explorerUrl": "https://explorer.shelby.xyz/shelbynet/blob/sealbox%2Fb94d27b9...",
  "signedPayloadVersion": "2"
}
```

Stored encodings: public key `0x` + 64 hex chars, signature `0x` + 128 hex
chars, signer address `0x` + 64 hex chars (long AIP-40 form), SHA-256 as 64
lowercase hex chars without a prefix.

### Signed payload

The signature covers a canonical, domain-separated byte string. The same
function (`createSignedPayload`) produces it at seal time and at verify time.

```text
SEALBOX-MANIFEST-V2\n
payloadVersion:<len>:<value>\n
sha256:<len>:<value>\n
sizeBytes:<len>:<value>\n
blobName:<len>:<value>\n
sealedAt:<len>:<value>\n
network:<len>:<value>\n
signerPublicKey:<len>:<value>\n
```

* `<len>` is the UTF-8 **byte** length of the value that follows. Length
  prefixing makes the encoding injective: no field value can forge a field
  boundary, so no escaping scheme is needed.
* The field order is fixed by the code, so the bytes never depend on
  JavaScript object property ordering.
* Sizes are rendered as plain decimal integers — no locale-dependent
  formatting.
* Line endings are LF; there is no trailing whitespace.
* The domain separator `SEALBOX-MANIFEST-V2` prevents a signature over some
  other Sealbox record (or some other protocol entirely) from being replayed
  here.

## Legacy (schema v1) records

Records written by sealbox v0.1.0/v0.2.0 do not contain a public key, so
their signature **cannot** be verified cryptographically.

Sealbox still parses them, still checks their SHA-256, and reports them
honestly:

* status `LEGACY_UNVERIFIABLE_SIGNATURE`
* `integrityVerified: true`, `signatureVerified: false`, `signerVerified: false`
* `legacyRecord: true`
* a non-zero exit code — a legacy record is not a `PASS`

A legacy record is **never** silently promoted to a verifiable record: the
schema version marker is not rewritten, and a record that carries v2 fields
without a version marker is rejected as invalid rather than downgraded.

A legacy record cannot acquire a trustworthy historical signature
retroactively. Today's program knowing a new key says nothing about what was
signed in the past. To get a fully verifiable record, re-seal the artifact
with sealbox v0.3.0 or later.

## Storage

Uploads and downloads use the Shelby S3 gateway with bounded exponential
backoff and a bounded per-request timeout. Only transient failures are
retried; authentication errors (401), authorization errors (403),
insufficient funds (402) and rate limiting (429) are surfaced immediately and
never retried automatically. Uploads are a `PUT` of a fixed, content-addressed
key with a fixed body, so a retry cannot create a second object or a
different body.

The gateway contract — endpoint, SigV4 region, bucket resolution, signing
credentials — is recorded with the evidence used to establish it in
[docs/SHELBY-INTEGRATION.md](docs/SHELBY-INTEGRATION.md). The bucket is
resolved from the signing account's address so that `seal` and `verify`
address the same object and verification never needs the private key.

### Live integration status

**The upload half is proven against the live network; the round trip is
not yet complete.** Through the official self-hosted S3 gateway, a real
Ed25519-signed artifact was uploaded to Shelby: HTTP 200 with an on-chain
ETag, and the account's `sequence_number` advanced 0 → 4 with four
objects in Shelby's blob indexer. The **retrieval** then fails with
`HTTP 500`, because the bytes were stored without ClayCode erasure
encoding — and the official SDK's own upload path reproduces that with
neither SealBox nor the gateway in the loop, so it is upstream behaviour
rather than a SealBox defect. The remaining variable is a Shelby API key.

A reusable harness is included:

```bash
npm run integration:shelby
```

It performs a real round trip — disposable fixture, local SHA-256, seal
with a real Ed25519 signature, upload, download over the network, hash
comparison, SealBox verification, and a local tamper check — and exits
non-zero unless every stage succeeds. A secret-free example configuration
for the official gateway is at
[docs/shelby-gateway.config.example.js](docs/shelby-gateway.config.example.js).
The exact blocker and the single continuation command are recorded in
[docs/LIVE-SHELBY-BLOCKER.md](docs/LIVE-SHELBY-BLOCKER.md).

The local manifest is written atomically: a temporary file in the same
directory is `fsync`ed and then `rename`d over the target, so a reader sees
either the complete old file or the complete new file. A manifest that
cannot be parsed is reported as an error and is **never** silently replaced
with an empty one.

## Development

```bash
npm ci
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # jest
npm run build        # tsc
npm run integration:shelby   # opt-in live round trip (needs credentials)
```

The test suite runs the real Ed25519 implementation locally — the
cryptographic tests are not mocked. Only the network/storage boundary is
mocked. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

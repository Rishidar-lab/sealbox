# 05 — Cryptographic verification

Authoritative implementation: `src/crypto.ts`, `src/verification.ts`.
Tests: `src/crypto.test.ts`, `src/verification.test.ts`,
`src/security-regression.test.ts`.

## Scheme

* **Signature:** Ed25519, via `@aptos-labs/ts-sdk` v7.1.2
  (`Ed25519PrivateKey` / `Ed25519PublicKey` / `Ed25519Signature`), which
  delegates to `@noble/curves` 2.2.0.
* **Digest:** SHA-256, via Node's `crypto`.
* **Signer identity:** the Aptos "legacy Ed25519" authentication-key
  address, `publicKey.authKey().derivedAddress()`, always rendered in the
  long AIP-40 form.

## Canonical signed payload

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

* `<len>` — UTF-8 **byte** length of the value that follows.
* The framing is injective: a value cannot contain or forge a field
  boundary, so no escaping scheme is needed and no value can be
  reinterpreted as structure.
* Field order is fixed in the function body, so the bytes never depend on
  JavaScript object property ordering.
* Sizes are `String(integer)` — plain decimal, locale-independent.
* Line endings are LF; there is no trailing whitespace and no trailing
  blank line.
* The domain separator `SEALBOX-MANIFEST-V2` is unique to SealBox and
  prevents cross-protocol replay.
* `createSignedPayload()` is the single implementation, used at seal time
  and at verify time.

## Verification sequence and status model

| stage | failure status |
|---|---|
| record/schema validation | `INVALID_MANIFEST`, `UNSUPPORTED_SCHEMA` |
| retrieval | `NOT_FOUND`, `STORAGE_ERROR` |
| size + SHA-256 of the retrieved bytes | `TAMPERED` |
| canonical payload rebuild | `INVALID_MANIFEST` |
| public-key validation | `INVALID_MANIFEST` |
| Ed25519 signature verification | `INVALID_SIGNATURE` |
| signer-address derivation and comparison | `SIGNER_MISMATCH` |
| derived seal ID / explorer URL consistency | `INVALID_MANIFEST` |
| everything | `PASS` |

`PASS` is returned **only** when every stage succeeds. Each stage's
outcome is reported independently as `integrityVerified`,
`signatureVerified` and `signerVerified`; `signerVerified` is true only
when the signature verified *and* the address matched.

## Public-key validation (the small-order defence)

`validateEd25519PublicKey()` requires the stored key to be:

1. a strictly decoded (RFC 8032, **not** ZIP-215) compressed Edwards
   point — this rejects non-canonical `y` encodings;
2. **not** the identity element;
3. in the prime-order subgroup (`[L]P == identity`), which excludes every
   small-order/torsion point.

This is necessary because the SDK's constructor only checks the byte
length and the underlying verifier runs in ZIP-215 mode, which skips the
small-order rejection. Without it, `verifyBytes()` returns `true` for the
all-zero public key with the all-zero signature — demonstrated in
`src/security-regression.test.ts`, which also captures the SDK's own
`true` as documentation of the upstream behaviour.

## The v0.2.0 defect, reproduced

`src/security-regression.test.ts` keeps a verbatim copy of the v0.2.0
`verifySignature()` and asserts that it returns `true` for a valid digest
plus any non-empty signature — documenting the defect — and then asserts
that the current implementation rejects the same inputs, and that a
manifest carrying a forged signature never yields `PASS` or
`signatureVerified: true`.

## Reproducing

```bash
npx jest src/crypto.test.ts src/verification.test.ts src/security-regression.test.ts
```

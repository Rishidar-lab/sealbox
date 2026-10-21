# 04 — Manifest v2 specification

Authoritative implementation: `src/manifest.ts` and `src/crypto.ts`.
Documented format: `README.md`.

## File shape

```json
{
  "schemaVersion": 2,
  "entries": [ /* ManifestEntryV2 */ ]
}
```

| file `schemaVersion` | meaning |
|---|---|
| 1 | legacy manifest (pre-v0.3.0); records carry no `recordVersion` |
| 2 | current manifest |
| other | `UNSUPPORTED_SCHEMA` — the file is refused, never guessed at |

## Record shape

```json
{
  "recordVersion": 2,
  "sealId": "b94d27b9934d3e08",
  "blobName": "sealbox/b94d27b9…",
  "sha256": "b94d27b9…",
  "sizeBytes": 11,
  "sealedAt": "2026-10-21T12:00:00.000Z",
  "network": "shelbynet",
  "signatureScheme": "ed25519",
  "signerPublicKey": "0xd04ab232…",
  "signerAddress": "0x147e4d3a…",
  "signature": "0xedbf4dd3…",
  "explorerUrl": "https://explorer.shelby.xyz/shelbynet/blob/sealbox%2Fb94d27b9…",
  "signedPayloadVersion": "2"
}
```

Encodings: public key `0x`+64 hex, signature `0x`+128 hex, signer address
`0x`+64 hex (long AIP-40 form), digest 64 lowercase hex without a prefix.
No private key and no API secret is ever written.

## Record classification (`classifyManifestEntry`)

| `recordVersion` | v2-only fields present | classification |
|---|---|---|
| `2` | all | `v2` |
| `2` | some missing | `invalid` — refused |
| `1` | any | `invalid` — refused |
| `1` | none | `legacy` |
| absent | any | `invalid` — refused (no silent downgrade) |
| absent | none | `legacy` |
| anything else | — | `unsupported` — refused |

## Durability

* write to `.manifest.json.<pid>.<ms>.tmp` in the same directory;
* `fsync` the file, `rename()` it over the target (atomic on POSIX);
* `fsync` the directory so the rename survives a crash;
* remove the temporary file if anything fails;
* re-read the file from disk before a write so a concurrent write is not
  clobbered (a residual race remains between that read and the rename —
  documented, not solved);
* file mode `0600`.

## Seal IDs

* `sealId` is a prefix of `sha256`; the full SHA-256 is the authoritative
  content identifier and the lookup key.
* A record whose `sealId` is not a prefix of its digest is
  `INVALID_MANIFEST`.
* On write, a record that would collide with an existing seal ID gets the
  shortest longer unique prefix of its digest. Both records are preserved.
* A hand-written manifest with duplicate seal IDs is reported as
  `AMBIGUOUS_SEAL_ID`; lookup never picks one arbitrarily.

# 09 — Legacy (schema v1) behaviour

## The problem

A schema v1 record has no public key. Its `signature` field is a string
that v0.2.0 never verified cryptographically, so there is nothing in the
record that can authenticate it. v0.3.0 cannot retroactively make a v1
record verifiable: "today's program knows a new key" says nothing about
what was signed in the past.

## The policy

| property | v1 record | v2 record |
|---|---|---|
| parsed | yes | yes |
| SHA-256 of the retrieved bytes checked | yes | yes |
| `integrityVerified` | `true` when the bytes match | `true` when the bytes match |
| `signatureVerified` | **always `false`** | `true` only on a real verification |
| `signerVerified` | **always `false`** | `true` only when the address is derived and matches |
| `ok` | **`false`** | `true` only when everything passes |
| status | `LEGACY_UNVERIFIABLE_SIGNATURE` | `PASS` |
| exit code | non-zero | 0 |

## Human-readable output

```
LEGACY — NOT FULLY VERIFIED
  SHA-256:    b94d27b9…
  Integrity:  verified (retrieved bytes match the recorded SHA-256)
  Signature:  NOT verified — this is a schema v1 record.
              Schema v1 records contain no public key, so the stored
              signature cannot be cryptographically verified. A legacy
              record cannot acquire a trustworthy historical signature
              retroactively.
  Signer id:  NOT verified — no public key is stored.
```

## JSON output

```json
{
  "ok": false,
  "status": "LEGACY_UNVERIFIABLE_SIGNATURE",
  "legacyRecord": true,
  "integrityVerified": true,
  "signatureVerified": false,
  "signerVerified": false
}
```

## No silent promotion, no silent downgrade

* A v1 record is never rewritten with `recordVersion: 2` — that would
  assert cryptographic properties it does not have.
* A record that carries v2-only fields but **no** `recordVersion` is
  rejected as `invalid`, not treated as legacy. A v2 record therefore
  cannot be quietly downgraded into "merely legacy".
* A record that declares `recordVersion: 1` while carrying v2-only fields
  is also `invalid`.
* Legacy records are copied verbatim when a v2 record is added to the
  same manifest file.

## Getting a verifiable record

Re-seal the artifact with v0.3.0 or later. That is the only
cryptographically sound path; there is no migration that can authenticate
a signature that was never made by a key we hold.

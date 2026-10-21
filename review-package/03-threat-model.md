# 03 — Threat model

## Assets

| asset | protection | notes |
|---|---|---|
| artifact bytes | SHA-256 in the signed record | integrity relative to the signed digest |
| manifest record | Ed25519 signature over the canonical payload | authenticity of the record's contents |
| signer identity | derived from the public key and compared | consistency, **not** legal identity |
| private signing key | never stored, never printed, `clear()` after use | best-effort in-memory hygiene only |
| S3 signing secret | never printed, never in the manifest | shared client/gateway secret |

## Adversaries considered

| # | adversary | capability | mitigation | residual |
|---|---|---|---|---|
| 1 | **storage tamper** | modify the stored object | SHA-256 + size compared to the signed record | none — the whole point |
| 2 | **manifest tamper** | edit a signed field | the field is inside the signed payload → `INVALID_SIGNATURE` | none |
| 3 | **forged signature** | write any non-empty signature string | real Ed25519 verification; malformed input typed as failure | none |
| 4 | **key substitution** | swap the public key for one the attacker controls | the signature no longer verifies → `INVALID_SIGNATURE` | none |
| 5 | **identity swap** | keep a valid key/signature, change the address | the address is derived from the key and compared → `SIGNER_MISMATCH` | none |
| 6 | **small-order key** | use a torsion public key that validates forged signatures | the public key is validated as a strict, non-identity, prime-order point | none |
| 7 | **payload confusion** | reuse a signature from another protocol/record | domain separator `SEALBOX-MANIFEST-V2` + version + length-prefixed framing | none |
| 8 | **field-boundary injection** | put `\nsha256:…` inside a field value | length prefixing makes the encoding injective | none |
| 9 | **manifest downgrade** | strip v2 fields to make a record look legacy | a record with v2 fields but no version marker is `invalid`, not `legacy` | a record with *no* v2 fields is indistinguishable from a genuine v1 record — it can only be downgraded to "not verified", never to "verified" |
| 10 | **corrupt manifest** | truncate/garble `manifest.json` | explicit failure, never silently an empty manifest; never overwritten | none |
| 11 | **seal-ID collision** | craft two artifacts sharing a 16-hex prefix | both records preserved; the colliding one gets a longer unique prefix; an ambiguous lookup is reported | 64-bit prefix space is convenience-only; the full SHA-256 is the authoritative identifier |
| 12 | **credential theft** | read the private key from disk/memory | `.env` gitignored; never printed; `clear()` afterwards; the private key is not stored in the manifest | JavaScript cannot guarantee erasure — immutable strings, GC copies and `BigInt` intermediates survive |
| 13 | **endpoint misconfiguration** | point the client at the wrong service | endpoint validated (scheme, credentials-in-URL); the region, bucket and signing secrets are explicit and documented | a wrong-but-valid endpoint still fails loudly at the HTTP layer |
| 14 | **network attacker** | intercept/modify traffic | HTTPS to the endpoint; SigV4 request signing | TLS trust, as always |
| 15 | **downgrade of the verification contract** | make `verify` return PASS on weaker evidence | `PASS` is reachable only through the full pipeline; each stage is separately reported and separately tested | none |

## Explicitly out of scope

* A signer who is malicious or compromised — the signature faithfully
  records what they signed.
* Legal identity of the key holder.
* Anything about the truthfulness of the artifact's contents.
* Availability of the Shelby network.
* A malicious or buggy Shelby gateway (it is the verifier's counterparty
  for the transport, but the signed record remains checkable offline).

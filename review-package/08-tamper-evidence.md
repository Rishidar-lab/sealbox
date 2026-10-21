# 08 — Tamper evidence

Tamper behaviour is established in two ways: locally, exhaustively, by the
test suite; and, once the live blocker is cleared, by the harness's
local-tamper stage.

## Local tamper matrix (all against the real implementation)

| mutation | result | test |
|---|---|---|
| one byte flipped | `TAMPERED` | `verification.test.ts` |
| truncated | `TAMPERED` | `verification.test.ts` |
| **data appended** | `TAMPERED` | `verification.test.ts` |
| **data prepended** | `TAMPERED` | `verification.test.ts` |
| same size, different bytes | `TAMPERED` | `verification.test.ts` |
| replaced with empty | `TAMPERED` | `verification.test.ts` |
| recorded size changed | `TAMPERED` | `verification.test.ts` |
| recorded digest changed | `INVALID_SIGNATURE` | `verification.test.ts` |
| recorded timestamp changed | `INVALID_SIGNATURE` | `verification.test.ts` |
| recorded blob name changed | `INVALID_SIGNATURE` | `verification.test.ts` |
| recorded network changed | `INVALID_SIGNATURE` | `verification.test.ts` |
| recorded size changed | `INVALID_SIGNATURE` | `verification.test.ts` |
| public key replaced | `INVALID_SIGNATURE` | `verification.test.ts` |
| signature replaced with a forged one | `INVALID_SIGNATURE` | `verification.test.ts`, `security-regression.test.ts`, `cli.test.ts` |
| signer address replaced | `SIGNER_MISMATCH` | `verification.test.ts`, `security-regression.test.ts` |
| payload field boundary forged | rejected by the length-prefixed framing | `crypto.test.ts` |
| all-zero public key + all-zero signature | rejected | `security-regression.test.ts` |
| identity-element public key | rejected | `security-regression.test.ts` |
| manifest JSON corrupted | `INVALID_MANIFEST`, file left untouched | `manifest.test.ts`, `security-regression.test.ts` |
| manifest record made contradictory | `INVALID_RECORD` | `manifest.test.ts` |
| manifest schema version unknown | `UNSUPPORTED_SCHEMA` | `manifest.test.ts` |

## The live harness's tamper stage

`src/integration/live-shelby-smoke.ts` performs it against the **downloaded**
bytes:

```ts
const tampered = Buffer.from(retrieved);
tampered[0] = tampered[0]! ^ 0x01;          // one bit, same length
const result = await verifyEntry({ entry, retrieve: async () => tampered });
// the harness fails unless result.ok === false
```

Two properties matter and are both enforced by the harness:

* the modification is applied to **local bytes only** — the remote object
  is never mutated, so the canonical evidence stays canonical;
* the harness exits non-zero unless the modified copy is rejected, so
  "uploaded" can never be reported as "verified".

`src/integration/live-shelby-smoke.test.ts` proves the tamper stage is
meaningful by also asserting that the **unmodified** bytes still verify —
otherwise a harness that rejected everything would pass vacuously.

## Why a hash is not enough on its own

The digest is inside the signed payload, so the signature binds the
content *and* the metadata that describes it. A verifier that only
compared hashes would accept a record whose timestamp, network or object
name had been edited; v0.3.0 rejects all of those with
`INVALID_SIGNATURE`.

# 06 — Test report

**Code release SHA:** `89f657705864f3cf2d055f5c1fac5ccea56651c9`
**Suite:** 8 files, **174 tests**, all passing.

## Result

| command | result |
|---|---|
| `npm ci` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 0 findings |
| `npm test` | PASS — 174 / 174, 8 suites |
| `npm run build` | PASS |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (all) | 20 moderate, dev-toolchain only — see below |
| clean clone of `main` | all of the above PASS again |

## Dependency findings, honestly classified

* **Runtime:** 0 vulnerabilities (`npm audit --omit=dev`).
* **Dev-only:** 20 moderate, all one root cause — `sprintf-js` (advisory
  `GHSA-hp3w-g68c-fv3c`, range `<=1.1.3`) reached through
  `ts-jest` → `@jest/transform` → `babel-plugin-istanbul` →
  `@istanbuljs/load-nyc-config` → `js-yaml@3` → `argparse`. The latest
  published `sprintf-js` is 1.1.3, so **no upstream fix exists**; the
  only "fix" npm offers is a downgrade to `ts-jest@29.1.2` / `jest@25`,
  which is a regression. Not applied.
* The pre-existing **critical** `handlebars` finding was resolved to
  4.7.10 by `npm audit fix` (a dev-only transitive of the coverage
  tooling).
* The advisory's exploitability here requires an attacker to control a
  format string passed to `sprintf` inside the nyc coverage-config
  loader — a local, developer-controlled input, not a runtime surface.

## Coverage by area

| area | file | notable cases |
|---|---|---|
| SHA-256 | `crypto.test.ts` | known vectors, empty, binary, distinctness |
| payload canonicalisation | `crypto.test.ts` | determinism, property-order independence, whitespace, boundary injection via an independent length-aware parser |
| Ed25519 | `crypto.test.ts` | real sign/verify, wrong key, mutated payload/digest/timestamp/blobName/network/size, malformed key and signature, hostile input |
| public-key soundness | `crypto.test.ts`, `security-regression.test.ts` | all-zero key, identity element, non-curve point |
| signer identity | `crypto.test.ts`, `verification.test.ts` | derivation, case handling, swapped address |
| content integrity | `verification.test.ts` | one-byte edit, truncation, **append**, **prepend**, same-size substitution, empty replacement, size mismatch |
| legacy v1 | `verification.test.ts`, `manifest.test.ts` | parse, classify, integrity-only, no promotion, no downgrade |
| manifest | `manifest.test.ts` | round trip, atomic write, dedupe, concurrency, corrupt JSON, unsupported schema, contradictory records, seal-ID collisions |
| storage | `storage.test.ts` | upload, download, 404 propagation, transient retry, permanent failure, 401/402/403/429, bounded retries, request timeout, endpoint validation, secret-free errors |
| integration config | `integration-config.test.ts` | SigV4 region, bucket resolution, credentials, timeout, no secret in the resolved view |
| CLI | `cli.test.ts` | seal, verify, list, doctor, `--json`, no private key in output, doctor local/live split |
| live harness | `integration/live-shelby-smoke.test.ts` | blocker classification, CLI error rehydration, evidence shaping, local tamper check |
| **regression** | `security-regression.test.ts` | the exact v0.2.0 defect, the small-order forgery, the identity swap, legacy non-promotion, corrupt-manifest failure |

## Mocking policy observed

* The **cryptographic core is never mocked.** The real SDK executes
  against deterministic, clearly-labelled, unfunded test keys in
  `src/__fixtures__/keys.ts`.
* Mocks are used only for the network and storage boundaries (S3,
  fullnode balances, reachability) — the legitimate boundary.
* The final real-network requirement is **not** mocked away: it is the
  separate, opt-in `npm run integration:shelby` command, and the harness
  fails closed when it cannot run.

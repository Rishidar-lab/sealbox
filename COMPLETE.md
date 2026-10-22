# SealBox — Completion Report

**Verdict: `PARTIAL`.**

The core deliverable — real Ed25519 verification with an independently
verifiable, canonically-signed manifest — is implemented, tested, built, and
green in CI. The **live Shelby round trip is not demonstrated**: it is blocked
on a Shelby API key (an owner-gated external input), and the read-side failure
is an upstream anonymous-tier limitation reproduced by the official SDK itself.
Per the brief, `COMPLETE` is not claimed while the live round trip is not
demonstrated.

Recorded 2026-10-22T16:48:44Z, against `main` @ `14db93f` plus this pass's
changes. Full evidence in [docs/LIVE_VERIFICATION.md](docs/LIVE_VERIFICATION.md).

Legend: `[x]` met · `[~]` partial / proven in a prior run but not re-run here ·
`[ ]` blocked.

## Completion gates

- [x] **local tests pass** — 174 passed / 8 suites / 0 failed (`npm test`)
- [x] **CI passes** — PR CI is **all green**: Typecheck / Lint / Test / Build pass and the Vercel deployment passes, with no skipped checks. The manual live-integration job was moved to its own `workflow_dispatch`-only workflow (`.github/workflows/live-integration.yml`), so it no longer surfaces as a skipped check on PRs; it runs only when dispatched with live secrets. (Base `14db93f` CI was run `39640691478`, success.)
- [x] **Ed25519 positive test passes** — `crypto.test.ts` / `verification.test.ts` (real curve, not mocked)
- [x] **wrong-key rejection passes** — valid signature rejected under a different public key
- [x] **digest tamper rejection passes** — edited digest and modified bytes both → `INVALID_SIGNATURE` / `TAMPERED`
- [x] **metadata tamper rejection passes** — editing blobName / sealedAt / network / size invalidates the signature
- [~] **live upload passes** — proven in the prior documented run (HTTP 200 + on-chain ETag, `sequence_number` 0→4); **not re-run this pass** (no credentials in this environment)
- [ ] **live retrieval passes** — **BLOCKED**: HTTP 500; the anonymous tier stored the blob un-encoded (reproduced by the official SDK with no SealBox in the loop)
- [ ] **retrieved object verifies** — **BLOCKED**: never reached (retrieval failed first)
- [~] **tampered object rejects** — tamper-rejection logic is TESTED (unit suite + the live harness's local-copy tamper check); a *live-retrieved* object was never reached because retrieval is blocked, and the remote object is never mutated by design
- [x] **production build succeeds** — `npm run build` (`tsc`) clean; CLI `--version`/`--help` smoke OK
- [x] **Vercel configuration matches actual output** — SealBox is a CLI, not a web app; `vercel.json` (`framework: null`, `buildCommand: null`, `outputDirectory: "public"`) serves a committed static `public/index.html` landing page, and both are excluded from the npm package. No fake empty `public/` was created. The **Vercel deployment check ran green on PR #8** (commit `78390b8`) — the "public output directory not found" error is resolved. The preview URL sits behind Vercel's deployment access-protection (anonymous requests 302-redirect to SSO), so the rendered HTML was not fetched anonymously; the green deployment check confirms the output directory was found and served.
- [x] **README claims match evidence** — README already disclaims trusted timestamping, indefinite storage, and production Shelby; a "cryptographic validity vs. signer trust" section was added; the live-status section matches the evidence above

## Changes made this pass (smallest-fix principle)

1. **`src/crypto.test.ts`** — replaced raw control bytes (`\x00`, `\x01`) in one
   hostile-input test with the byte-identical escapes `\u0000` / `\u0001`. The
   runtime string values are unchanged (174/174 still pass), but the file now
   classifies as UTF-8 text instead of `data`, so `grep`/review tools no longer
   treat it as binary and silently skip it.
2. **`README.md`** — added an explicit *Cryptographic validity (A) vs. signer
   trust (B)* section (document-only resolution of the A/B separation).
3. **`public/index.html` + `vercel.json`** — a minimal, honest static landing
   page and the matching no-build Vercel config.
4. **`docs/LIVE_VERIFICATION.md`, `COMPLETE.md`** — this evidence pair.

No verification logic was weakened, no feature was redesigned, and no live claim
was manufactured.

## What would move this to `COMPLETE`

One owner-gated step: obtain a Shelby API key (<https://geomi.dev>, *Shelbynet*)
and run `./scripts/live-shelby.sh`. If the harness exits 0 (upload, download,
hash equality, `signatureVerified`, signer match, local tamper rejection), the
three blocked gates clear and the verdict becomes `COMPLETE`.

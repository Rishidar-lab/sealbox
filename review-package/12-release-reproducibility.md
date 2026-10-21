# 12 — Release reproducibility

## Release identity

| item | value |
|---|---|
| release | SealBox v0.3.0 |
| code release SHA | `89f657705864f3cf2d055f5c1fac5ccea56651c9` (PR #2 merge) |
| release document | PR #3 (`docs/RELEASE-v0.3.0.md`) |
| release document | added by PR #3 (`docs/RELEASE-v0.3.0.md`) |
| base | `07def30dd409011c649dfac541ce3952bba16d2f` (v0.2.0) |
| tag | `v0.3.0` on `main` |
| licence | MIT (`LICENSE`; provenance note in `docs/PROVENANCE.md`) |
| live Shelby round trip | **NOT VERIFIED — the upload is proven, the read is blocked on an API key** |

## Reproduce the software gates

```bash
git clone https://github.com/Rishidar-lab/sealbox.git
cd sealbox
git checkout 89f657705864f3cf2d055f5c1fac5ccea56651c9
npm ci
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # 174 tests / 8 suites
npm run build         # tsc
npm audit --omit=dev  # 0 vulnerabilities
node dist/index.js --version   # 0.3.0
```

Expected: every command exits 0, and `npm test` reports
`Tests: 174 passed, 174 total`.

This was executed from a **fresh clone** of `main` at the merge SHA, with
no pre-existing `node_modules` or `dist`, and every gate passed.

## Reproduce the live round trip (once the blocker is cleared)

The **upload** half is already proven against the real network; the
**retrieval** half is blocked on a Shelby API key. The full sequence:

```bash
# 1. a Shelby API key (human sign-up): https://geomi.dev
# 2. a running S3 gateway, configured without any secret on disk:
#      docs/shelby-gateway.config.example.js reads every credential from
#      the environment
export SHELBY_GW_ACCESS_KEY_ID="<local S3 access key id — your choice>"
export SHELBY_GW_SECRET_ACCESS_KEY="<local S3 secret — your choice>"
export SHELBY_GW_APTOS_PRIVATE_KEY="$(python3 -c "import yaml;print(yaml.safe_load(open('$HOME/.shelby/config.yaml'))['accounts']['parzi']['private_key'])")"
export SHELBY_GW_API_KEY="<YOUR_SHELBY_API_KEY>"
# the config imports @shelby-protocol/s3-gateway, so it must sit next to
# the installed package
mkdir -p ~/shelby-gw && cd ~/shelby-gw
npm init -y >/dev/null && npm i @shelby-protocol/s3-gateway
cp /path/to/sealbox/docs/shelby-gateway.config.example.js ./shelby.config.js
node node_modules/@shelby-protocol/s3-gateway/bin/entry.js --config ./shelby.config.js &

# 3. optionally fund the account with ShelbyUSD (the registrations were
#    free, but a paid read may need a channel):
#      POST https://faucet.shelbynet.shelby.xyz/fund?asset=shelbyusd
#         {"address":"<account>","amount":100000000}

# 4. the run (or simply: ./scripts/live-shelby.sh)
SHELBY_S3_ENDPOINT="http://localhost:9000" \
SHELBY_S3_REGION="shelbyland" \
SHELBY_S3_ACCESS_KEY_ID="$SHELBY_GW_ACCESS_KEY_ID" \
SHELBY_S3_SECRET_ACCESS_KEY="$SHELBY_GW_SECRET_ACCESS_KEY" \
SHELBY_API_KEY="$SHELBY_GW_API_KEY" \
SIGNER_PRIVATE_KEY="$SHELBY_GW_APTOS_PRIVATE_KEY" \
npm run integration:shelby
```

The harness prints a non-secret evidence record and exits 0 only when
every stage succeeded; it exits 1 (BLOCKED) or 2 (MISSING_CONFIGURATION)
otherwise.

## Per-commit verification

Every commit in the release range was checked out in isolation and passed
`npm run typecheck`, `npm run lint`, `npm test` and `npm run build`.

## CI

`Typecheck / Lint / Test / Build` — green on the push run and the pull
request run, on Node 22. The optional `Live Integration (manual only)`
job stays manual-dispatch-only, is gated on the presence of the required
secrets, and never blocks contributor CI.

## Environment

| item | value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, Linux 7.0.0-38-generic x86_64 |
| Node | v22.23.3 |
| npm | 10.9.9 |
| TypeScript | 6.0.3 (from `package-lock.json`) |

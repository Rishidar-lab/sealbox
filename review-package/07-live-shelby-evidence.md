# 07 — Live Shelby evidence

## Result: NOT VERIFIED — BLOCKED

No successful live Shelby seal/upload/download/verify round trip has been
performed. Nothing in this document claims otherwise.

Full detail: `docs/LIVE-SHELBY-BLOCKER.md`.

## What the attempt produced

Command (from a clean checkout of `main`):

```bash
SHELBY_S3_ENDPOINT="https://api.shelbynet.shelby.xyz/shelby" \
SHELBY_NETWORK="shelbynet" \
SIGNER_PRIVATE_KEY="<from ~/.shelby/config.yaml — never printed>" \
npm run integration:shelby
```

Output (address truncated; no secret appears anywhere):

```
sealbox live Shelby smoke test
  network        : shelbynet
  endpoint host  : api.shelbynet.shelby.xyz
  endpoint path  : /shelby
  bucket         : 0x2a58c57cf211474f902c67665b9708c0c1a621f0…
  account        : 0x2a58c57cf211474f902c67665b9708c0c1a621f0…
  fixture        : 63 bytes, sha256=12dd3faebbff267caeb3e8972ed6b02662193b6203694110b6f3ae0df3744a62

BLOCKED: AUTHENTICATION
  Storage endpoint rejected the supplied credentials (HTTP 401). …
  Next: Set SHELBY_S3_ACCESS_KEY_ID and SHELBY_S3_SECRET_ACCESS_KEY …
```

Exit code `1`. With no configuration at all the harness exits `2` with
`BLOCKED: MISSING_CONFIGURATION`.

## Read-only probes that did succeed

These are the facts the integration fixes rest on. All against
`api.shelbynet.shelby.xyz`, 2026-10-21.

| probe | observed result |
|---|---|
| `GET /v1` | 200 — Aptos fullnode, chain id 119 |
| `GET /shelby/shelby/probe` with an S3 `Authorization` header | **400 `Bad Request: Missing x-amz-content-sha256 header required for SigV4`** — an S3 gateway is served at `{endpoint}/{bucket}/{key}` |
| `GET /shelby/shelby/probe` with no auth | 404 `text/plain` |
| `GET /shelby/v1/blobs/{account}/probe` | 404 JSON `{"error":"Blob not found", …}` — the RPC path shape |
| `PUT /shelby/v1/blobs/{account}/{blob}` with `Authorization: Bearer <not-a-key>` | **401 `Unauthorized: API key not found`** — the RPC requires a bearer API key for writes |
| `PUT /shelby/v1/blobs/{account}/{blob}` with no `Authorization` | 404 — anonymous writes are not routed |
| `GET /shelby/v1/blobs/{account}/{blob}` anonymous | 404 JSON — anonymous reads are served |
| `GET /shelby/shelby/{bucket}` with SigV4, region `shelbyland`, documented example credentials | **401** |
| `GET /v1/accounts/{addr}/balance/0x1::aptos_coin::AptosCoin` | 200 `100000000` (1 APT) |
| `GET /v1/accounts/{addr}/balance/<ShelbyUSD type>` | 200 `0` |
| `GET /v1/accounts/{addr}/resource/0x1%3A%3Acoin%3ACoinStore%3C…%3E` | **400 `invalid struct tag`** — the form v0.2.0's `doctor` used |
| `GET /v1/accounts/{addr}/balance/0x1%3A%3Aaptos_coin%3A%3AAptosCoin` | 200 `100000000` — the `/balance/` form works encoded or literal |

## Account state

| item | value |
|---|---|
| network | `shelbynet` (Aptos L1, chain id 119) |
| endpoint | `https://api.shelbynet.shelby.xyz/shelby` |
| public account | `0x2a58c57cf211474f902c67665b9708c0c1a621f04f4d8c5608a378db5ecc400b` |
| APT | 1.0000 APT |
| ShelbyUSD | **0** |
| existing blobs | none — every probe returns `Blob not found` |

## The two independent blockers

1. **Credentials.** The hosted gateway rejects every signing identity
   available here with HTTP 401. The gateway's `accessKeyId` /
   `secretAccessKey` are issued alongside a Shelby API key
   (<https://geomi.dev>); the values in the official documentation are for
   a **locally**-run gateway and are rejected by the hosted one. No such
   key exists on this host: not in the environment, not in
   `~/.shelby/config.yaml` (which has no `apiKey` field), and there is no
   `.env` for this project. Obtaining one requires a human sign-up.
2. **Funding.** 0 ShelbyUSD. The on-chain commitment registration that an
   upload performs charges ShelbyUSD. The official faucet can grant it
   (`POST https://faucet.shelbynet.shelby.xyz/fund?asset=shelbyusd`) and
   the maintainer's own automation calls it daily — but that is a
   wallet-affecting action reserved for the maintainer, so it was not
   performed here.

## Also observed, independently of SealBox

The maintainer's own `shelby_daily.log` shows the **official** Shelby CLI
failing on every upload attempt on 2026-09-26 and 2026-09-28 with
`Cannot convert @<address>/daily/… to a BigInt`. That is an upstream SDK
failure, independent of SealBox, and it means the official tool path was
already broken before this review.

## What was NOT done

* No private key, API key or signing secret printed, logged or committed.
* No successful live write claimed.
* The remote object was never mutated; there was no object to mutate.
* No verification logic weakened to make a network test pass.

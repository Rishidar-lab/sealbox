# 07 — Live Shelby evidence

## Result: NOT VERIFIED — the write succeeds, the read fails

**No successful live Shelby seal → upload → retrieve → verify → tamper-reject
cycle has been completed.** The upload half is proven against the real
network; the retrieval half is not. Nothing here claims otherwise.

Full account: `docs/LIVE-SHELBY-BLOCKER.md`. Raw session evidence:
`docs/release-v0.3-evidence.md` §E8.

---

## The route that was used

The **official self-hosted S3 gateway** — the route every official
integration uses (`http://localhost:9000`):

```bash
npx @shelby-protocol/s3-gateway --config <config>
```

* `@shelby-protocol/s3-gateway@1.12.1`, `server.region: shelbyland`,
  `locationHint: shelbynet-1`, `buckets: [<account address>]` (legacy
  address-style), an Aptos signer so writes are enabled.
* The configuration was **secret-free** — every credential came from the
  environment; the Aptos key was read from `~/.shelby/config.yaml` at
  start-up. A reusable, secret-free example is at
  `docs/shelby-gateway.config.example.js`.
* The gateway is a *client↔gateway* secret boundary: the S3
  `accessKeyId`/`secretAccessKey` are operator-chosen, never issued by
  Shelby.

## What was observed

| stage | result |
|---|---|
| fixture | 63 bytes, `sha256=c070d0733ba8ac8f…` |
| seal — canonical payload, real Ed25519 | ✅ `sealId=c070d0733ba8ac8f` |
| **upload through the gateway** | ✅ **HTTP 200**, on-chain ETag `0x4e77e466…` |
| **on-chain registration** | ✅ account `sequence_number` 0 → **4**; four objects in the Shelby blob indexer with `blob_uid`, `location_name: shelbynet-1`, `plaintext_size`, `etag` |
| **retrieve from Shelby-backed storage** | ❌ **HTTP 500 `Internal Server Error`** |
| hash equality / `signatureVerified` / signer identity / tamper reject | ⛔ never reached |

## Why the read fails: the write lands unencoded

| blob | plaintext | stored | readable |
|---|---|---|---|
| Shelby team's own smoke blob (`@0x4c8a…/smoke/hello2.txt`) | 40 | **168** | ✅ 200 |
| my 40-byte probe | 40 | **40** | ❌ 500 |
| my 63-byte seal | 63 | **63** | ❌ 500 |
| my 32-byte probe | 32 | **32** | ❌ 500 |
| my 34-byte probe via the **SDK's own** upload (no SealBox, no gateway) | 34 | **34** | ❌ 500 |

`stored == plaintext` means the bytes were stored **without ClayCode
erasure encoding**; the RPC cannot serve a blob it has no encoded form for,
so every read — by name *and* by uid — answers `500`.

That last row matters most: the **official SDK's own upload path, with
neither SealBox nor the S3 gateway in the loop, reproduces it exactly**. The
defect is upstream of SealBox.

## The corrected cause of the original 401

The `api.shelbynet.shelby.xyz` front door **rejects any request that
carries an `Authorization: Bearer <key>` it does not recognise** (401
`Unauthorized: API key not found`) while serving requests that carry no key
at all. The earlier 401 was therefore caused by sending a *placeholder* key —
supplying no key is strictly better than supplying a wrong one.

The SDK's canonical RPC host for shelbynet,
`https://shelby.shelbynet.shelby.xyz/shelby`, requires a valid API key for
**every** request:

```
GET .../v1/blobs_by_uid/{account}/{uid}
  → 401 Unauthorized: Rejected because anonymous requests are not allowed,
            you must provide a key, i.e. Authorization: Bearer <key>
```

## Two front doors, measured

| host | anonymous read | anonymous write | API key |
|---|---|---|---|
| `api.shelbynet.shelby.xyz` | ✅ 200 | ⚠️ accepted, stored **unencoded** | for a valid key |
| `shelby.shelbynet.shelby.xyz` | ❌ 401 | ❌ 401 | ✅ always |
| `api.shelbynet.aptoslabs.com` (indexer) | ✅ 200 (metadata) | n/a | no |
| `faucet.shelbynet.shelby.xyz` | n/a | n/a | optional |

## Funding

| item | value |
|---|---|
| public address | `0x2a58c57cf211474f902c67665b9708c0c1a621f04f4d8c5608a378db5ecc400b` |
| network | `shelbynet` (Aptos L1, chain id 119) |
| APT | `100000000` base units = **1.0000 APT** |
| ShelbyUSD | **0** |
| registration cost observed | **none** — the APT balance is unchanged across four registrations, so gas was sponsored |
| minimum funding per official tooling | `100000000` (100 ShelbyUSD at 6 decimals) — the SDK's own `fundAccountWithShelbyUSD` example, and the same amount the maintainer's `shelby_daily.sh` requests |

Funding is **not** the cause of the failure: another account's blob reads
fine from the same host. It is reported because it is the remaining
account-level prerequisite for a paid read, if one is required.

## The one command that finishes it

```bash
export SHELBY_GW_ACCESS_KEY_ID="<local S3 access key id — your choice>"
export SHELBY_GW_SECRET_ACCESS_KEY="<local S3 secret — your choice>"
export SHELBY_GW_APTOS_PRIVATE_KEY="$(python3 -c "import yaml;print(yaml.safe_load(open('$HOME/.shelby/config.yaml'))['accounts']['parzi']['private_key'])")"
export SHELBY_GW_API_KEY="<your Shelby API key from geomi.dev>"

npx @shelby-protocol/s3-gateway --config docs/shelby-gateway.config.example.js &

SHELBY_S3_ENDPOINT="http://localhost:9000" \
SHELBY_S3_REGION="shelbyland" \
SHELBY_S3_ACCESS_KEY_ID="$SHELBY_GW_ACCESS_KEY_ID" \
SHELBY_S3_SECRET_ACCESS_KEY="$SHELBY_GW_SECRET_ACCESS_KEY" \
SHELBY_API_KEY="$SHELBY_GW_API_KEY" \
SIGNER_PRIVATE_KEY="$SHELBY_GW_APTOS_PRIVATE_KEY" \
npm run integration:shelby
```

The harness exits 0 only when every stage succeeds.

## What was NOT done

* No private key, API key or signing secret printed, logged or committed.
* No successful read performed, and none claimed.
* The remote object was never mutated to test tampering — the tamper check
  runs against a local copy of the retrieved bytes.
* No verification logic weakened, and no mocked storage used as evidence of
  live interoperability.
* The faucet was not called; funding is a wallet-affecting action reserved
  for the maintainer.

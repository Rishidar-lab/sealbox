# Shelby Integration — Contract, Evidence and Configuration

This document records the actual Shelby storage contract, the evidence used to
establish it, and how SealBox v0.3.0 is configured against it.

Everything here was established from **official Shelby documentation** plus
**direct probes of the live endpoints** on 2026-10-21. Where a probe was
run, the observed HTTP result is quoted. Nothing in this document is a
guess, and no successful write is claimed.

---

## 1. The two distinct Shelby surfaces

Shelby exposes two different things, and confusing them is the root of the
inherited integration problems:

| surface | what it is | path shape |
|---|---|---|
| **Shelby blob RPC** | the protocol API. JSON over HTTP, bearer-token authenticated. | `{rpcEndpoint}/v1/blobs/{account_address}/{blob_name}` |
| **Shelby S3 gateway** | an S3-compatible proxy in front of the RPC. Speaks AWS SigV4. | `{s3Endpoint}/{bucket}/{key}` |

Official sources:

* RPC API surface — <https://docs.shelby.xyz/apis/rpc/shelbynet>
* Blob upload / retrieval (RPC) — <https://docs.shelby.xyz/apis/rpc/shelbynet/storage/uploadBlob>
* S3 gateway — <https://docs.shelby.xyz/tools/s3-gateway>
* S3 gateway configuration — <https://docs.shelby.xyz/tools/s3-gateway/configuration>
* S3 gateway uploads — <https://docs.shelby.xyz/tools/s3-gateway/uploads>
* S3 compatibility — <https://docs.shelby.xyz/tools/s3-gateway/compatibility>
* CLI (uploads, contexts) — <https://docs.shelby.xyz/tools/cli/commands/uploads>

### Network endpoints

From the official Shelby CLI configuration
(`https://docs.shelby.xyz/tools/cli`) and the local `~/.shelby/config.yaml`:

| network | RPC / S3 endpoint | Aptos fullnode | faucet |
|---|---|---|---|
| `shelbynet` | `https://api.shelbynet.shelby.xyz/shelby` | `https://api.shelbynet.shelby.xyz/v1` | `https://faucet.shelbynet.shelby.xyz` |
| `testnet` | `https://api.testnet.shelby.xyz/shelby` | `https://api.testnet.aptoslabs.com/v1` | — |

The hosted endpoint at `https://api.shelbynet.shelby.xyz/shelby` is **both**
the RPC root **and** the S3 gateway path: probing
`GET /shelby/shelby/<key>` with an S3 `Authorization` header returns the
gateway's SigV4 error (`Missing x-amz-content-sha256 header required for
SigV4`), which is an S3-layer response, not an RPC response. Probing
`GET /shelby/v1/blobs/{account}/{blob}` returns RPC JSON
(`{"error":"Blob not found", ...}`).

---

## 2. What the S3 gateway requires

From the official configuration reference:

| requirement | value | SealBox v0.2.0 | SealBox v0.3.0 |
|---|---|---|---|
| SigV4 signing region | gateway's `server.region`, default `shelbyland` | hard-coded `us-east-1` — **wrong** | `SHELBY_S3_REGION`, default `shelbyland` |
| bucket | must resolve to the Aptos account that owns the objects; legacy address-style bucket names are supported | hard-coded `shelby` — **cannot resolve** | `SHELBY_S3_BUCKET`, else the signer/account address |
| S3 `accessKeyId` / `secretAccessKey` | shared signing secrets between the client and the gateway; **not** the Shelby API key | both set to `SHELBY_API_KEY` — **wrong** | `SHELBY_S3_ACCESS_KEY_ID` / `SHELBY_S3_SECRET_ACCESS_KEY`, falling back to `SHELBY_API_KEY` |
| write operations | require an Aptos signer (the gateway registers the on-chain commitment) | n/a | provided by the gateway |
| object overwrite | not supported; re-uploading identical content is idempotent, different content is `409 ObjectAlreadyExists` | n/a | compatible — SealBox's key is content-addressed (`sealbox/<sha256>`) |
| ETag | on-chain merkle-root prefix, SHA2-256 based, `-1` suffixed — **not** MD5 | n/a | SealBox never trusts the ETag; it recomputes SHA-256 itself |

### The path shape is correct

SealBox addresses objects as `{endpoint}/{bucket}/{key}`. The S3 gateway
routes exactly that shape (`{bucket}` → account, `{key}` → blob name), and
`forcePathStyle: true` is what the official gateway documentation
recommends for rclone/boto3/AWS SDK. **This path shape was left unchanged**
— it was validated, not assumed.

### Per-blob expiration

An earlier revision of the official uploads page stated that Shelby
requires an explicit expiry (`x-amz-meta-expiration-seconds`). The
current uploads and compatibility pages no longer mention it. SealBox
therefore does **not** send expiration metadata, and this is recorded as an
open question rather than silently resolved.

---

## 3. Live probes actually performed (2026-10-21)

Read-only unless stated. All against the public `shelbynet` network.

| probe | result |
|---|---|
| `GET https://api.shelbynet.shelby.xyz/v1` | 200 — Aptos fullnode, chain id 119 |
| `GET .../shelby` | 404, empty body |
| `GET .../shelby/shelby/probe` (no auth) | 404 `text/plain` |
| `GET .../shelby/shelby/probe` (S3 `Authorization` header) | **400 `Bad Request: Missing x-amz-content-sha256 header required for SigV4`** — proves an S3 gateway is served at that path |
| `GET .../shelby/v1/blobs/{account}/probe` | 404 JSON `{"error":"Blob not found", ...}` — proves the RPC path shape |
| `PUT .../shelby/v1/blobs/{account}/{blob}` with `Authorization: Bearer <not-a-key>` | **401 `Unauthorized: API key not found`** |
| `PUT .../shelby/v1/blobs/{account}/{blob}` without an `Authorization` header | 404 (the route is only registered for authenticated requests) |
| `GET .../shelby/v1/blobs/{account}/{blob}` (anonymous read) | 404 JSON — anonymous reads are served |
| `GET .../shelby/shelby/{bucket}` with SigV4, region `shelbyland`, documented example credentials | **401** |
| same, region `us-east-1` | **401** (region is not the discriminator at this stage) |
| `GET .../v1/accounts/{addr}/balance/0x1::aptos_coin::AptosCoin` | 200 `100000000` |
| `GET .../v1/accounts/{addr}/balance/<ShelbyUSD type>` | 200 `0` |
| `GET .../v1/accounts/{addr}/resource/0x1%3A%3Acoin%3ACoinStore%3C...%3E` | **400 `invalid struct tag`** — the form SealBox v0.2.0 `doctor` used |
| `GET .../v1/accounts/{addr}/balance/0x1%3A%3Aaptos_coin%3A%3AAptosCoin` | 200 `100000000` — the `/balance/` form works encoded or literal |

### The `doctor` balance defect

SealBox v0.2.0 (and v0.3.0 up to this pass) queried

```
{v1}/accounts/{address}/resource/0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>
```

percent-encoded, which the fullnode rejects with **HTTP 400**. The check
therefore reported "could not query" for every account and `doctor` could
never report READY. v0.3.0 now queries
`{v1}/accounts/{address}/balance/{coinType}`, which returns the balance
directly.

---

## 4. What is still unproven

* **No successful Shelby write has been performed.** The hosted gateway
  rejected the documented example signing credentials with HTTP 401, and no
  issued `accessKeyId` / `secretAccessKey` is configured on this host. See
  [LIVE-SHELBY-BLOCKER.md](LIVE-SHELBY-BLOCKER.md).
* The account holds **0 ShelbyUSD**, so even a correctly authenticated write
  would be refused by the on-chain commitment registration that charges
  ShelbyUSD.
* The **official Shelby CLI's own upload is currently broken** upstream: the
  maintainer's own `shelby_daily.log` shows
  `Cannot convert @<address>/daily/… to a BigInt` for every upload attempt
  on 2026-09-26 and 2026-09-28. That failure is in the Shelby SDK, not in
  SealBox.

---

## 5. SealBox configuration

| variable | default | purpose |
|---|---|---|
| `SHELBY_S3_ENDPOINT` | *(required)* | S3 gateway endpoint |
| `SHELBY_S3_REGION` | `shelbyland` | SigV4 signing region; must match the gateway |
| `SHELBY_S3_BUCKET` | the signer/account address | bucket that must resolve to the owning account |
| `SHELBY_S3_ACCESS_KEY_ID` | `SHELBY_API_KEY` | S3 signing identity |
| `SHELBY_S3_SECRET_ACCESS_KEY` | `SHELBY_API_KEY` | S3 signing secret |
| `SHELBY_S3_TIMEOUT_MS` | `30000` | per-request timeout (the AWS SDK has no default) |
| `SHELBY_API_KEY` | — | Shelby API key (bearer) for the RPC surface |
| `SIGNER_PRIVATE_KEY` | *(required)* | Ed25519 key used to sign the record |

`seal` and `verify` resolve the bucket from the **same** address — the
signing key's address at seal time, the recorded `signerAddress` at verify
time — so verification never needs the private key and both address the
same object.

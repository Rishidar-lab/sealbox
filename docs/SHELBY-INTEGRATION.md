# Shelby Integration — Contract, Evidence and Configuration

This document records the actual Shelby storage contract, the evidence used to
establish it, and how SealBox v0.3.0 is configured against it.

Everything here was established from **official Shelby documentation** plus
**direct probes of the live endpoints** on 2026-10-21. Where a probe was
run, the observed HTTP result is quoted. Nothing in this document is a
guess, and no successful write is claimed.

---

## 1. The Shelby surfaces, and the two front doors

Shelby exposes three different things, and conflating them is the root of
the inherited integration problems.

| surface | what it is | path shape |
|---|---|---|
| **Shelby blob RPC** | the protocol API. JSON over HTTP. | `{rpcEndpoint}/v1/blobs/{account_address}/{blob_name}` |
| **Shelby S3 gateway** | an S3-compatible proxy in front of the RPC. Speaks AWS SigV4. Self-hosted. | `{s3Endpoint}/{bucket}/{key}` |
| **Shelby blob indexer** | GraphQL metadata index. Read-only. | `https://api.shelbynet.aptoslabs.com/v1/graphql` |

Official sources:

* RPC API surface — <https://docs.shelby.xyz/apis/rpc/shelbynet>
* Blob upload / retrieval (RPC) — <https://docs.shelby.xyz/apis/rpc/shelbynet/storage/uploadBlob>
* S3 gateway — <https://docs.shelby.xyz/tools/s3-gateway>
* S3 gateway configuration — <https://docs.shelby.xyz/tools/s3-gateway/configuration>
* S3 gateway uploads — <https://docs.shelby.xyz/tools/s3-gateway/uploads>
* S3 compatibility — <https://docs.shelby.xyz/tools/s3-gateway/compatibility>
* CLI (uploads, contexts) — <https://docs.shelby.xyz/tools/cli/commands/uploads>
* API keys — <https://docs.shelby.xyz/sdks/typescript/acquire-api-keys>

### The two RPC front doors are not interchangeable

| host | role | anonymous read | anonymous write | API key |
|---|---|---|---|---|
| `api.shelbynet.shelby.xyz` | front door: fullnode `/v1`, faucet, blob RPC | ✅ 200 | ⚠️ accepted, but stored **unencoded** (see §4) | for a valid key |
| `shelby.shelbynet.shelby.xyz` | the SDK's canonical RPC host for shelbynet | ❌ 401 | ❌ 401 | **required for every request** |
| `api.shelbynet.aptoslabs.com` | the Shelby blob indexer (GraphQL) | ✅ 200 (metadata only) | n/a | no |
| `faucet.shelbynet.shelby.xyz` | the official faucet | n/a | n/a | optional `authToken` |

Measured behaviour of the `api.` front door:

| request | observed |
|---|---|
| no `Authorization` header | routed — 404 for an unknown path, 400 for a malformed SigV4 header, 200 for a readable blob |
| `Authorization: Bearer <any value>` | **401 `Unauthorized: API key not found`** |
| `Authorization: AWS4-HMAC-SHA256 …` (partial) | 400 `Missing x-amz-content-sha256 header required for SigV4` |
| full SigV4 from the AWS SDK | 401 |

**Consequence:** supplying a *wrong* bearer key is worse than supplying
none. This is the mechanism behind the original 401 in the earlier revision
of this document — the request carried a placeholder key, and the front
door rejected it. The S3 `accessKeyId`/`secretAccessKey` pair in the S3
gateway is a **local client↔gateway** secret that the operator chooses; it
is never issued by Shelby and is never validated by the hosted service.

### The S3 gateway is self-hosted

Every official integration uses `http://localhost:9000` — a gateway you run
yourself. The SDK's canonical RPC host (`shelby.shelbynet.shelby.xyz`) is
the upstream the gateway talks to, and it requires an API key.

```bash
npx @shelby-protocol/s3-gateway --config <config>
```

A secret-free example configuration that reads every credential from the
environment is provided at
[`docs/shelby-gateway.config.example.js`](shelby-gateway.config.example.js).

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

All against the public `shelbynet` network. Probes are read-only except
where a **write** is marked — those created real, on-chain-registered blobs
under the maintainer's dedicated Shelby account (see
[LIVE-SHELBY-BLOCKER.md](LIVE-SHELBY-BLOCKER.md) for the full account).

| probe | result |
|---|---|
| `GET https://api.shelbynet.shelby.xyz/v1` | 200 — Aptos fullnode, chain id 119 |
| `GET .../shelby` | 404, empty body |
| `GET .../shelby/shelby/probe` (no auth) | 404 `text/plain` |
| `GET .../shelby/shelby/probe` (S3 `Authorization` header) | **400 `Bad Request: Missing x-amz-content-sha256 header required for SigV4`** — proves an S3 gateway is served at that path |
| `GET .../shelby/v1/blobs/{account}/probe` | 404 JSON `{"error":"Blob not found", ...}` — proves the RPC path shape |
| `PUT .../shelby/v1/blobs/{account}/{blob}` with `Authorization: Bearer <not-a-key>` | **401 `Unauthorized: API key not found`** |
| `PUT .../shelby/v1/blobs/{account}/{blob}` without an `Authorization` header | 404 (the route is only registered for authenticated requests) |
| `GET .../shelby/v1/blobs/{account}/{blob}` (anonymous read, blob absent) | 404 JSON `{"error":"Blob not found"}` — the route is served anonymously |
| `GET .../shelby/shelby/{bucket}` with SigV4, region `shelbyland`, documented example credentials | **401** |
| same, region `us-east-1` | **401** (region is not the discriminator at this stage) |
| **WRITE** `PUT` via the local S3 gateway, 40-byte body | **200 + on-chain ETag**; indexer shows the object; the stored bytes are unencoded |
| **WRITE** `PUT` via the SDK's own `ShelbyNodeClient.upload()` (no gateway) | same raw-storage result — the defect is upstream of SealBox |
| `GET .../v1/accounts/{addr}/balance/0x1::aptos_coin::AptosCoin` | 200 `100000000` |
| `GET .../v1/accounts/{addr}/balance/<ShelbyUSD type>` | 200 `0` |
| `GET .../v1/accounts/{addr}/resource/0x1%3A%3Acoin%3ACoinStore%3C...%3E` | **400 `invalid struct tag`** — the form SealBox v0.2.0 `doctor` used |
| `GET .../v1/accounts/{addr}/balance/0x1%3A%3Aaptos_coin%3A%3AAptosCoin` | 200 `100000000` — the `/balance/` form works encoded or literal |
| `GET .../shelby/v1/auth/challenge` (no key) | **200** — a real challenge is issued anonymously |
| `POST .../shelby/v1/auth/challenge` (bogus bearer) | **401 `Unauthorized: API key not found`** |
| `PUT .../shelby/v2/chunksets/{acct}/0/{uid}` (no key) | **400 `Missing required header: X-Shelby-Inclusion-Proof`** — the anonymous write route is reachable |
| `PUT .../shelby/v2/chunksets/{acct}/0/{uid}` (bogus bearer) | **401 `Unauthorized: API key not found`** |
| `GET .../shelby/v1/blobs/{acct}/{name}` for **another account's** blob | **200** — anonymous reads work |
| `GET .../shelby/v1/blobs/{acct}/{name}` for **my** blob | **500 `Internal Server Error`** — stored unencoded |
| `GET .../shelby/v1/blobs_by_uid/{acct}/{uid}` for my blob | **500** — same failure by uid |
| `GET https://shelby.shelbynet.shelby.xyz/shelby/v1/blobs_by_uid/{acct}/{uid}` | **401 `Rejected because anonymous requests are not allowed, you must provide a key`** |
| indexer `shelby_objects` for my account | 4 objects, `blob_uid` + `etag` + `location_name: shelbynet-1`, but `stored_size == plaintext_size` |
| indexer `shelby_objects` for the team's smoke account | `plaintext_size: 40`, `stored_size: 168` (encoded), reads 200 |
| account `sequence_number` before / after the writes | `0` → **`4`** (four real on-chain registrations) |

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

## 4. What the probes established, and what is still unproven

### Proven

* The S3 gateway is served at `{endpoint}/{bucket}/{key}` (a SigV4 error is
  returned there) — so the inherited **path shape is correct** and was not
  changed.
* The blob RPC is served at `{rpcEndpoint}/v1/blobs/{account}/{blob}`, and
  its write route at `{rpcEndpoint}/v2/chunksets/{account}/{index}/{uid}`.
* The **write path works end to end against the real network**: the local
  gateway returned HTTP 200 with an on-chain ETag, the account's
  `sequence_number` advanced 0 → 4, and the blob indexer holds four
  objects for the account with `blob_uid`, `location_name: shelbynet-1`,
  `plaintext_size` and `etag`.
* The S3 gateway's `accessKeyId`/`secretAccessKey` are operator-chosen
  local secrets (the official defaults work) — they are not Shelby-issued
  and are not what the hosted 401 was about.
* The fullnode's `/accounts/{address}/balance/{coinType}` form works
  (encoded or literal); the generic `/resource/0x1::coin::CoinStore<…>`
  form returns **HTTP 400 `invalid struct tag`** — which is why v0.2.0's
  `doctor` could never report a funded account.

### Not proven

* **No blob has been read back successfully.** Blobs written through the
  anonymous `api.` path are stored **unencoded**
  (`stored_size == plaintext_size`), and the RPC then answers every read
  with `500 Internal Server Error`. A correctly written blob stores more
  than the plaintext (the team's own smoke blob: plaintext 40, stored 168)
  and reads 200.
* The **SDK's own upload path reproduces the defect with no SealBox and no
  gateway in the loop**, so this is an upstream behaviour of the
  anonymous tier rather than a SealBox or gateway defect.
* The remaining untested variable is the **API key**: the SDK's canonical
  RPC host requires one for every request, and the authenticated write
  path is the only route not observed to store raw bytes.
* The account holds **0 ShelbyUSD**; the registrations were nevertheless
  free (the APT balance is unchanged), so funding is not the cause of the
  observed failure.

See [LIVE-SHELBY-BLOCKER.md](LIVE-SHELBY-BLOCKER.md) for the full account
of the attempt and the exact continuation command.

## 5. SealBox configuration

| variable | default | purpose |
|---|---|---|
| `SHELBY_S3_ENDPOINT` | *(required)* | S3 gateway endpoint |
| `SHELBY_S3_REGION` | `shelbyland` | SigV4 signing region; must match the gateway |
| `SHELBY_S3_BUCKET` | the signer/account address | bucket that must resolve to the owning account |
| `SHELBY_S3_ACCESS_KEY_ID` | `SHELBY_API_KEY` | S3 signing identity |
| `SHELBY_S3_SECRET_ACCESS_KEY` | `SHELBY_API_KEY` | S3 signing secret |
| `SHELBY_S3_TIMEOUT_MS` | `30000` | per-request timeout (the AWS SDK has no default) |
| `SHELBY_API_KEY` | — | Shelby API key (bearer) for the upstream RPC |
| `SIGNER_PRIVATE_KEY` | *(required)* | Ed25519 key used to sign the record |

Gateway-side variables (see
[`docs/shelby-gateway.config.example.js`](shelby-gateway.config.example.js)):
`SHELBY_GW_ACCESS_KEY_ID`, `SHELBY_GW_SECRET_ACCESS_KEY`,
`SHELBY_GW_APTOS_PRIVATE_KEY`, `SHELBY_GW_API_KEY`,
`SHELBY_GW_RPC_ENDPOINT`, `SHELBY_GW_BUCKET_ALIAS`, `SHELBY_GW_PORT`,
`SHELBY_GW_LOCATION_HINT`.

`seal` and `verify` resolve the bucket from the **same** address — the
signing key's address at seal time, the recorded `signerAddress` at verify
time — so verification never needs the private key and both address the
same object.

# Live Shelby Integration — Blocker

**Status: BLOCKED — the round trip completes the WRITE and fails the READ.**

Superseded diagnosis: the earlier revision of this document blamed the
hosted gateway for rejecting the S3 signing identity. That was **wrong** and
is corrected below. The write path is now proven to work against the real
Shelby network; the read path fails for a different, precisely identified
reason.

Recorded: 2026-10-21 (Asia/Kolkata), SealBox `main` at
`58e4e6914e2f47eae9f5c42f3f8c2d364f792935` (v0.3.0).

---

## 1. What was proven, and what still fails

| stage | result |
|---|---|
| fixture created (63 bytes) | ✅ |
| sealed by the real SealBox v2 path (canonical payload + real Ed25519 signature) | ✅ |
| **uploaded through the official Shelby S3 gateway** | ✅ **HTTP 200 + on-chain ETag** |
| on-chain registration committed | ✅ `sequence_number` 0 → **4**; four objects indexed with blob_uids |
| retrieved again from Shelby-backed storage | ❌ **HTTP 500 `Internal Server Error`** |
| hash comparison / signatureVerified / signerVerified / tamper reject | ⛔ never reached |

The harness output, verbatim (address truncated, no secret printed):

```
sealbox live Shelby smoke test
  network        : shelbynet
  endpoint host  : localhost:9000
  endpoint path  : /
  bucket         : 0x2a58c57cf211474f902c67665b9708c0c1a621f04f4d8c5608a378db5ecc400b
  account        : 0x2a58c57cf211474f902c67665b9708c0c1a621f04f4d8c5608a378db5ecc400b
  fixture        : 63 bytes, sha256=c070d0733ba8ac8f0d74c1e604f4aaa1422273e58ea221ab097da994fe06c915
  sealed         : sealId=c070d0733ba8ac8f blob=sealbox/c070d0733ba8ac8f0d74c1e604f4aaa1422273e58ea221ab097da994fe06c915

BLOCKED: SERVER_ERROR
  Storage endpoint returned HTTP 500: Failed to retrieve blob content
```

---

## 2. The corrected root cause: the write lands unencoded

The Shelby blob indexer records both the plaintext size and the *stored*
size. A correctly written blob stores **more** than the plaintext, because
the data is ClayCode erasure-encoded (`ClayCode_16Total_10Data_13Helper`).

| blob | plaintext | stored | readable? |
|---|---|---|---|
| Shelby team's own smoke blob (`@0x4c8a…/smoke/hello2.txt`) | 40 | **168** | ✅ 200 |
| my 40-byte probe | 40 | **40** | ❌ 500 |
| my 63-byte seal | 63 | **63** | ❌ 500 |
| my 32-byte probe | 32 | **32** | ❌ 500 |
| my 34-byte SDK-native probe | 34 | **34** | ❌ 500 |

`stored == plaintext` means the bytes were stored **raw, without ClayCode
encoding**, and the RPC cannot serve a blob it has no encoded form for —
hence `500 Internal Server Error` on every read (by name *and* by uid).

**This is not a SealBox defect and not a gateway defect.** The official
SDK's own upload path, with no SealBox and no S3 gateway in the loop, does
the same thing:

```
$ node sdk-upload.mjs      # ShelbyNodeClient.upload(), no gateway
  SDK upload -> returned: undefined
  indexer:  plain=34  stored=34   <-- raw, exactly like the gateway path
```

The SDK sends **raw** blob slices to the RPC (`readInChunks(blobData,
chunksetSize)` in `putBlobChunksets`); the RPC is expected to encode them
server-side. On the anonymous tier it evidently does not.

---

## 3. Why the original 401 was not an S3-identity problem

The hosted prefix `https://api.shelbynet.shelby.xyz/shelby` is a
multi-tenant front door with two different behaviours depending on whether an
`Authorization` header is present:

| request | observed |
|---|---|
| no `Authorization` header | **routed** — 404 for unknown paths, 400 for a malformed SigV4 header, 200 for a readable blob |
| `Authorization: Bearer <anything>` | **401 `Unauthorized: API key not found`** |
| `Authorization: AWS4-HMAC-SHA256 …` (partial) | 400 `Missing x-amz-content-sha256 header required for SigV4` |
| full SigV4 (AWS SDK) | 401 |

So the original 401 was produced by **supplying a bearer key that does not
exist** — supplying *no* key is strictly better than supplying a *wrong*
one. The S3 access-key/secret-key pair in the S3 gateway is a **local
client↔gateway** secret that I choose; it is never issued by Shelby and is
never validated by the hosted service. That is why the local gateway accepts
any value (the official defaults work) while the hosted prefix rejects
unknown identities.

The SDK's canonical RPC host for shelbynet is a **different host**,
`https://shelby.shelbynet.shelby.xyz/shelby`, and that host requires a
valid API key for *every* request:

```
GET .../v1/blobs_by_uid/{account}/{uid}
  → 401 Unauthorized: Rejected because anonymous requests are not allowed,
            you must provide a key, i.e. Authorization: Bearer <key>
```

**Conclusion: an API key is required to exercise Shelby's authenticated
write path, which is the path that stores blobs correctly.**

---

## 4. Two hosts, two behaviours (measured)

| host | role | anonymous read | anonymous write | needs API key |
|---|---|---|---|---|
| `api.shelbynet.shelby.xyz` | front door: fullnode `/v1`, faucet, blob RPC | ✅ 200 | ⚠️ accepted but stored **raw** | for a valid key |
| `shelby.shelbynet.shelby.xyz` | the SDK's canonical RPC for shelbynet | ❌ 401 | ❌ 401 | ✅ always |
| `api.shelbynet.aptoslabs.com` | the Shelby **blob indexer** (GraphQL) | ✅ 200 (metadata) | n/a | no |
| `faucet.shelbynet.shelby.xyz` | the official faucet | n/a | n/a | no (optional `authToken`) |

---

## 5. What is required to finish

### 5.0 The failure classified, on the canonical RPC host

With the gateway pointed at the SDK's canonical host
(`shelby.shelbynet.shelby.xyz`, the example config's default), the
failure is unambiguous and comes from the SDK itself:

```
Failed to upload blob to RPC: Failed to get challenge: status 401,
  body: Unauthorized: Rejected because anonymous requests are not allowed,
  you must provide a key, i.e. Authorization: Bearer <key>, to use this upstream
```

Classification: **auth**. Not funding, not protocol, not endpoint, not the
SDK, not SealBox. The only missing input is a valid Shelby API key.

### 5.1 API key — the blocker

Obtain a Shelby API key: <https://geomi.dev> → *API Resource* → network
**Shelbynet**. The key is issued for a server-side context. It is used in
two places:

| consumer | field | env var used by SealBox |
|---|---|---|
| local S3 gateway | `network.apiKey` | `SHELBY_GW_API_KEY` |
| SealBox → S3 gateway (SigV4) | `credentials[].accessKeyId` / `secretAccessKey` | `SHELBY_S3_ACCESS_KEY_ID` / `SHELBY_S3_SECRET_ACCESS_KEY` |

**Never paste the key into chat, a commit, or a log.** Put it in the
environment of the two processes.

### 5.2 Funding — reported, not blocking

| item | value |
|---|---|
| public address | `0x2a58c57cf211474f902c67665b9708c0c1a621f04f4d8c5608a378db5ecc400b` |
| network | `shelbynet` (Aptos L1, chain id 119) |
| APT balance | `100000000` base units = **1.0000 APT** |
| ShelbyUSD balance | **0** |
| registration fee observed | **none charged** — the APT balance is unchanged across four registrations, so gas was sponsored |
| minimum funding, per official tooling | `fundAccountWithShelbyUSD({ address, amount: 100000000 })` — the SDK's own example, and the same amount the maintainer's `shelby_daily.sh` requests (100 ShelbyUSD at 6 decimals) |

Funding is **not** the cause of the observed failure — a read of *another
account's* blob succeeds anonymously from the same host — but if reads turn
out to be paid for once the write is authenticated, this is the command:

```bash
curl -s -X POST "https://faucet.shelbynet.shelby.xyz/fund?asset=shelbyusd" \
  -H 'Content-Type: application/json' \
  -d '{"address":"0x2a58c57cf211474f902c67665b9708c0c1a621f04f4d8c5608a378db5ecc400b","amount":100000000}'
```

### 5.3 The local S3 gateway — prepared, safe, and running

The **supported** route is the self-hosted S3 gateway (all official
integrations use `http://localhost:9000`). It has been started and is
configured **without any secret on disk**:

* `docs/shelby-gateway.config.example.js` — a secret-free example config
  that reads every credential from the environment.
* The real Aptos key is read from `~/.shelby/config.yaml` at start-up and
  passed in the environment; it is never written to a file in this
  repository.
* The config imports `@shelby-protocol/s3-gateway`, so it must sit in a
  directory where that package is installed. Copy it next to the
  installation:

```bash
mkdir -p ~/shelby-gw && cd ~/shelby-gw
npm init -y >/dev/null && npm i @shelby-protocol/s3-gateway
cp /path/to/sealbox/docs/shelby-gateway.config.example.js ./shelby.config.js
node node_modules/@shelby-protocol/s3-gateway/bin/entry.js --config ./shelby.config.js
```

**The key must be set at the top level of the `shelby` config object** —
exactly where the YAML form `network.apiKey` maps to. The gateway spreads
`config.shelby` into the SDK client configs, and the SDK then uses the
top-level `apiKey` for all three consumers: the Aptos client
(`clientConfig.API_KEY`, for transaction submission), the indexer client
(`Authorization: Bearer`, for metadata) and the RPC client
(`Authorization: Bearer`, for blob data). Setting only `rpc.apiKey` would
leave the Aptos and indexer calls unauthenticated.

---

## 6. The single continuation command

```bash
# 1. the Shelby API key — the only missing input. `read -s` keeps it out of
#    the shell history and off the terminal.
read -s SHELBY_GW_API_KEY
export SHELBY_GW_API_KEY

# 2. the round trip: starts the official S3 gateway in a throwaway
#    workspace, runs the harness, tears the gateway down
./scripts/live-shelby.sh
```

`scripts/live-shelby.sh` fails closed with `SHELBY API KEY REQUIRED` (exit
2) when the key is absent, generates the gateway's own local S3 signing
secrets if they are not set, reads the Aptos key from
`~/.shelby/config.yaml`, and then runs `npm run integration:shelby` against
`http://localhost:9000`. It prints no secret and leaves no gateway running.

For manual control, the equivalent explicit sequence is:

```bash
export SHELBY_GW_ACCESS_KEY_ID="sealbox-local-gateway"
export SHELBY_GW_SECRET_ACCESS_KEY="$(head -c 40 /dev/urandom | base64 | tr -d '\n=+/' | head -c 40)"
export SHELBY_GW_APTOS_PRIVATE_KEY="$(python3 -c "import yaml;print(yaml.safe_load(open('$HOME/.shelby/config.yaml'))['accounts']['parzi']['private_key'])")"

mkdir -p ~/shelby-gw && cd ~/shelby-gw
npm init -y >/dev/null && npm i @shelby-protocol/s3-gateway
cp /path/to/sealbox/docs/shelby-gateway.config.example.js ./shelby.config.js
node node_modules/@shelby-protocol/s3-gateway/bin/entry.js --config ./shelby.config.js &

cd /path/to/sealbox
SHELBY_S3_ENDPOINT="http://localhost:9000" \
SHELBY_S3_REGION="shelbyland" \
SHELBY_S3_ACCESS_KEY_ID="$SHELBY_GW_ACCESS_KEY_ID" \
SHELBY_S3_SECRET_ACCESS_KEY="$SHELBY_GW_SECRET_ACCESS_KEY" \
SHELBY_API_KEY="$SHELBY_GW_API_KEY" \
SIGNER_PRIVATE_KEY="$SHELBY_GW_APTOS_PRIVATE_KEY" \
npm run integration:shelby
```

The harness exits 0 only when every stage succeeds — fixture, seal,
upload over the network, download over the network, hash equality,
`signatureVerified: true`, signer identity match, and a local tamper
rejection. It never reports "uploaded" as "verified".

---

## 7. What was NOT done

* No private key, API key or signing secret was printed, logged or
  committed. The local S3 secret was generated locally, stored only in a
  `0600` file outside the repository, and is irrelevant to Shelby.
* No successful Shelby read was performed, and none is claimed.
* The remote object was never mutated to test tampering; the tamper check
  runs against a local copy of the retrieved bytes.
* No verification logic was weakened, and no mocked storage was used as
  evidence of live interoperability.
* The faucet was not called: funding is a wallet-affecting action reserved
  for the maintainer, and it is not the cause of the failure.

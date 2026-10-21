# Live Shelby Integration — Blocker

**Status: BLOCKED — NOT EXECUTED AGAINST A LIVE WRITE.**

No successful Shelby seal/upload/download/verify round trip has been
performed. This document records exactly how far the attempt got, what the
blocker is, and the one command that finishes it once the blocker is
cleared.

Recorded: 2026-10-21 (Asia/Kolkata), SealBox commit
`cee5ac20bc0a37b633bf86250bbc5c675d70c51b` plus the integration fixes in
this branch.

---

## 1. The blocker

```
BLOCKED: AUTHENTICATION
  Storage endpoint rejected the supplied credentials (HTTP 401).
  The Shelby S3 gateway uses its own accessKeyId/secretAccessKey for SigV4
  signing; set SHELBY_S3_ACCESS_KEY_ID and SHELBY_S3_SECRET_ACCESS_KEY.
  Next: Set SHELBY_S3_ACCESS_KEY_ID and SHELBY_S3_SECRET_ACCESS_KEY to the
        signing secrets issued for the S3 gateway, then re-run:
        npm run integration:shelby
```

The harness reached the real endpoint, built a real request, and the
endpoint rejected it. This is a real HTTP 401 from
`api.shelbynet.shelby.xyz` — not a local failure, not a mock, and not a
network error.

## 2. Public account and network

| item | value |
|---|---|
| network | `shelbynet` (Aptos L1, chain id 119) |
| S3 endpoint | `https://api.shelbynet.shelby.xyz/shelby` |
| public account | `0x2a58c57cf211474f902c67665b9708c0c1a621f04f4d8c5608a378db5ecc400b` |
| bucket resolved by SealBox | the account address above (legacy address-style bucket) |
| APT balance | `100000000` base units = **1.0000 APT** |
| ShelbyUSD balance | **0** |

The account address is public (it is the on-chain account). The signing key
lives in `~/.shelby/config.yaml` and was never printed, logged or committed.

## 3. Exact commands attempted

```bash
# 1. the harness, with the local identity and the real endpoint
export SHELBY_S3_ENDPOINT="https://api.shelbynet.shelby.xyz/shelby"
export SHELBY_NETWORK="shelbynet"
export SIGNER_PRIVATE_KEY="<from ~/.shelby/config.yaml — not reproduced here>"
unset SHELBY_API_KEY
npm run integration:shelby
# → exit code 1, "BLOCKED: AUTHENTICATION", HTTP 401

# 2. independent read-only probe of the same endpoint
curl -s -o /dev/null -w '%{http_code}\n' -I \
  "https://api.shelbynet.shelby.xyz/shelby/shelby/0x2a58c57c…"
# → 401
```

## 4. Classification of the failures observed

| status | where | meaning |
|---|---|---|
| **401** | `PUT`/`HEAD` on the S3 path | the gateway does not recognise the SigV4 signing identity. The **issued** `accessKeyId`/`secretAccessKey` are required; the example values in the official documentation are for a **locally**-run gateway and are rejected by the hosted one. |
| **401 `Unauthorized: API key not found`** | `PUT` on the RPC path | the Shelby blob RPC requires a bearer API key; a request with an `Authorization` header but an unknown key is rejected. |
| **404 (route miss)** | `PUT` on the RPC path with no `Authorization` header | anonymous writes are not routed. |
| **400 `Missing x-amz-content-sha256`** | S3 path with a partial `Authorization` header | confirms an S3 gateway is served at that path. |
| **0 ShelbyUSD** | fullnode balance | the account cannot pay for the on-chain commitment registration that an upload performs. |

## 5. There are two independent blockers

1. **Credentials (primary).** The hosted S3 gateway needs an issued
   `accessKeyId` / `secretAccessKey`, obtained with a Shelby API key
   (<https://geomi.dev>). No such key exists on this host: there is no
   `SHELBY_API_KEY` in the environment, no `apiKey` field in
   `~/.shelby/config.yaml`, and no `.env` for this project. A Shelby API key
   is obtained by a human sign-up and cannot be provisioned automatically.
2. **Funding (secondary).** The account holds 0 ShelbyUSD. The official
   faucet can grant it —
   `POST https://faucet.shelbynet.shelby.xyz/fund?asset=shelbyusd` with
   `{"address":"<account>","amount":100000000}` — and the maintainer's own
   `shelby_daily.sh` already calls it daily. This step was **not** performed
   here, because funding is a wallet-affecting action reserved for the
   maintainer.

## 6. Exact minimal human action required

1. Obtain a Shelby API key at <https://geomi.dev>.
2. Run the official S3 gateway locally with that key and the local Aptos
   key, per <https://docs.shelby.xyz/tools/s3-gateway>, for example:

   ```yaml
   # shelby.config.yaml
   network:
     name: shelbynet
     rpcEndpoint: https://api.shelbynet.shelby.xyz/shelby
     aptosFullnode: https://api.shelbynet.shelby.xyz/v1
     aptosIndexer: https://api.shelbynet.shelby.xyz/v1/graphql
     apiKey: <YOUR_API_KEY>
   server:
     port: 9000
     region: shelbyland
   credentials:
     - accessKeyId: <S3_ACCESS_KEY_ID>
       secretAccessKey: <S3_SECRET_ACCESS_KEY>
       aptosPrivateKey: <YOUR_APTOS_PRIVATE_KEY>
   buckets:
     - "0x2a58c57cf211474f902c67665b9708c0c1a621f04f4d8c5608a378db5ecc400b"
   ```

   ```bash
   npx @shelby-protocol/s3-gateway --config shelby.config.yaml
   ```

   *(Alternatively, point `SHELBY_S3_ENDPOINT` at the hosted gateway with
   the signing secrets that deployment issues.)*

3. Fund the account with ShelbyUSD (and confirm APT) via the official
   faucet.
4. Run the one command:

   ```bash
   SHELBY_S3_ENDPOINT="http://localhost:9000" \
   SHELBY_S3_ACCESS_KEY_ID="<S3_ACCESS_KEY_ID>" \
   SHELBY_S3_SECRET_ACCESS_KEY="<S3_SECRET_ACCESS_KEY>" \
   SHELBY_API_KEY="<YOUR_API_KEY>" \
   SIGNER_PRIVATE_KEY="<YOUR_APTOS_PRIVATE_KEY>" \
   npm run integration:shelby
   ```

The harness performs the whole sequence — disposable fixture, local
SHA-256, seal with a real Ed25519 signature, upload, download over the
network, hash comparison, SealBox verification, and a local tamper check —
and exits non-zero unless every stage succeeds.

## 7. What was NOT done

* No private key, API key or signing secret was printed, logged or
  committed.
* No successful Shelby write is claimed.
* The remote object was never mutated to test tampering; the tamper check
  runs against a local copy of the downloaded bytes.
* No verification logic was weakened to make a network test pass.

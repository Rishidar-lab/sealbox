// Secret-free example configuration for the official Shelby S3 gateway.
//
//   npx @shelby-protocol/s3-gateway --config docs/shelby-gateway.config.example.js
//
// Every credential is read from the environment at start-up, so no key
// material is ever written to disk. Copy this file, keep it outside the
// repository if you like, and export the variables before starting the
// gateway.
//
// Required environment:
//   SHELBY_GW_ACCESS_KEY_ID       S3 access key id (client <-> gateway).
//                                 This is a LOCAL shared secret between
//                                 your S3 client and your own gateway — it
//                                 is not an AWS credential and it is never
//                                 issued by Shelby.
//   SHELBY_GW_SECRET_ACCESS_KEY   S3 secret access key (same scope).
//   SHELBY_GW_APTOS_PRIVATE_KEY   Aptos Ed25519 key that signs the
//                                 on-chain blob-commitment registration.
//                                 Enables write operations. If omitted, the
//                                 credential is read-only and PutObject
//                                 returns AccessDenied.
//
// Optional:
//   SHELBY_GW_API_KEY             Shelby API key (bearer) used for the
//                                 upstream RPC. The SDK's canonical
//                                 shelbynet RPC host
//                                 (shelby.shelbynet.shelby.xyz) requires
//                                 it for every request, including reads.
//   SHELBY_GW_BUCKET_ALIAS        S3 bucket alias. Defaults to the
//                                 account address (legacy address-style
//                                 bucket), which is what SealBox resolves
//                                 by default. An alias must satisfy the S3
//                                 bucket naming rules (3-63 characters).
//   SHELBY_GW_RPC_ENDPOINT         Upstream Shelby RPC base URL. Default:
//                                 https://shelby.shelbynet.shelby.xyz/shelby
//                                 (the SDK's canonical host for shelbynet,
//                                 which requires an API key for every
//                                 request). The alternative front door,
//                                 https://api.shelbynet.shelby.xyz/shelby,
//                                 serves anonymous reads but is NOT
//                                 interchangeable with the canonical host.
//   SHELBY_GW_PORT                Listen port (default 9000).
//   SHELBY_GW_LOCATION_HINT       Shelby write location (default
//                                 shelbynet-1). Required: without it the
//                                 gateway cannot resolve a write location.
import { Account, Ed25519PrivateKey, Network } from '@aptos-labs/ts-sdk';
import {
  defineConfig,
  StaticBucketResolver,
  StaticCredentialProvider,
} from '@shelby-protocol/s3-gateway';

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set for the Shelby S3 gateway to start.`);
  }
  return value;
};

const privateKey = new Ed25519PrivateKey(required('SHELBY_GW_APTOS_PRIVATE_KEY'));
const signer = Account.fromPrivateKey({ privateKey });
const accountAddress = signer.accountAddress.toString();

// The Shelby API key must be set at the TOP LEVEL of the `shelby` config
// object, exactly as the YAML form `network.apiKey` maps to it. The gateway
// spreads `config.shelby` into the SDK client configs, and the SDK then
// uses the top-level `apiKey` for all three consumers:
//   * the Aptos client   -> clientConfig.API_KEY  (transaction submission)
//   * the indexer client -> Authorization: Bearer   (metadata queries)
//   * the RPC client     -> Authorization: Bearer   (blob data)
// Setting only `rpc.apiKey` would leave the Aptos and indexer calls
// unauthenticated.
const apiKey = process.env.SHELBY_GW_API_KEY;

const rpc = {
  baseUrl:
    process.env.SHELBY_GW_RPC_ENDPOINT ||
    'https://shelby.shelbynet.shelby.xyz/shelby',
};
if (apiKey) {
  rpc.apiKey = apiKey;
}

const bucketResolver = new StaticBucketResolver({
  buckets: [process.env.SHELBY_GW_BUCKET_ALIAS || accountAddress],
});

export default defineConfig({
  shelby: {
    network: Network.SHELBYNET,
    rpc,
    // Top-level: reaches the Aptos client, the indexer client and the RPC
    // client. See the note above.
    ...(apiKey ? { apiKey } : {}),
    locationHint: process.env.SHELBY_GW_LOCATION_HINT || 'shelbynet-1',
  },
  server: {
    port: Number(process.env.SHELBY_GW_PORT || 9000),
    region: 'shelbyland',
  },
  credentialProvider: new StaticCredentialProvider({
    credentials: {
      [required('SHELBY_GW_ACCESS_KEY_ID')]: {
        secretKey: required('SHELBY_GW_SECRET_ACCESS_KEY'),
        aptosSigner: signer,
      },
    },
  }),
  bucketProvider: bucketResolver,
  bucketResolver,
});

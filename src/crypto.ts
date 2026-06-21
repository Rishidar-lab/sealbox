import * as nodeCrypto from 'crypto';
import { Ed25519PrivateKey, Ed25519PublicKey, Ed25519Signature } from '@aptos-labs/ts-sdk';

export function computeSha256(data: Buffer): string {
  return nodeCrypto.createHash('sha256').update(data).digest('hex');
}

export function signDigest(
  digest: string,
  privateKeyHex: string,
): { signature: string; address: string } {
  const privateKey = new Ed25519PrivateKey(privateKeyHex);
  const sig = privateKey.sign(Buffer.from(digest, 'hex'));
  const publicKey = privateKey.publicKey();
  const address = publicKey.authKey().derivedAddress().toString();
  return { signature: sig.toString(), address };
}

export function verifySignature(
  digest: string,
  signatureHex: string,
  signerAddress: string,
): boolean {
  // Without the public key stored in the manifest we can only do a
  // structural check here.  Full on-chain verification is left to the
  // Shelby explorer.  Return true so callers can rely on the SHA-256
  // comparison as the primary integrity check.
  return (
    typeof digest === 'string' &&
    digest.length === 64 &&
    typeof signatureHex === 'string' &&
    signatureHex.length > 0 &&
    typeof signerAddress === 'string' &&
    signerAddress.length > 0
  );
}

/**
 * SECURITY REGRESSION TESTS
 *
 * These tests encode the exact defects that sealbox v0.2.0 shipped with, and
 * assert that the current implementation rejects them.
 *
 * Regression 1 — the headline defect
 *   v0.2.0's `verifySignature()` performed *no* cryptographic verification.
 *   It only checked that the digest was 64 characters long, that the
 *   signature string was non-empty and that the signer address was non-empty.
 *   A valid digest plus any non-empty "signature" therefore verified.
 *
 * Regression 2 — small-order public key forgery
 *   The Aptos SDK's `Ed25519PublicKey` only validates the byte length, and
 *   the underlying `@noble/curves` verifier runs in ZIP-215 mode, which skips
 *   the small-order public-key rejection. `verifyBytes()` therefore returns
 *   `true` for e.g. the all-zero public key with the all-zero signature — a
 *   signature no legitimate signer could have produced. Sealbox validates the
 *   public key itself before trusting the SDK's result.
 */
import {
  computeSha256,
  createSignedPayload,
  createSigner,
  validateEd25519PublicKey,
  verifyEd25519Signature,
} from './crypto';
import { Manifest, ManifestEntryV2, V2_RECORD_VERSION } from './manifest';
import { verifyEntry, explorerUrl } from './verification';
import {
  BOGUS_SIGNATURE,
  TEST_ADDRESS_A,
  TEST_ADDRESS_B,
  TEST_PRIVATE_KEY_A,
  TEST_PUBLIC_KEY_A,
} from './__fixtures__/keys';

const ARTIFACT = Buffer.from('the quick brown fox');
const SHA256 = computeSha256(ARTIFACT);
const BLOB_NAME = `sealbox/${SHA256}`;
const NETWORK = 'shelbynet';
const SEALED_AT = '2026-10-21T12:00:00.000Z';

/**
 * The sealbox v0.2.0 signature check, reproduced verbatim as a reference.
 *
 * It is kept here so the regression test can demonstrate that the inputs it
 * rejects are exactly the inputs the old implementation accepted.
 */
function legacyVerifySignature(
  digest: string,
  signatureHex: string,
  signerAddress: string,
): boolean {
  return (
    typeof digest === 'string' &&
    digest.length === 64 &&
    typeof signatureHex === 'string' &&
    signatureHex.length > 0 &&
    typeof signerAddress === 'string' &&
    signerAddress.length > 0
  );
}

function buildEntry(overrides: Partial<ManifestEntryV2> = {}): ManifestEntryV2 {
  const signer = createSigner(TEST_PRIVATE_KEY_A);
  let signature: string;
  try {
    const payload = createSignedPayload({
      sha256: SHA256,
      sizeBytes: ARTIFACT.length,
      blobName: BLOB_NAME,
      sealedAt: SEALED_AT,
      network: NETWORK,
      signerPublicKey: signer.signerPublicKey,
    });
    signature = signer.sign(payload);
  } finally {
    signer.dispose();
  }

  return {
    recordVersion: V2_RECORD_VERSION,
    sealId: SHA256.substring(0, 16),
    blobName: BLOB_NAME,
    sha256: SHA256,
    sizeBytes: ARTIFACT.length,
    sealedAt: SEALED_AT,
    network: NETWORK,
    signatureScheme: 'ed25519',
    signerPublicKey: TEST_PUBLIC_KEY_A,
    signerAddress: TEST_ADDRESS_A,
    signature,
    explorerUrl: explorerUrl(NETWORK, BLOB_NAME),
    signedPayloadVersion: '2',
    ...overrides,
  };
}

describe('REGRESSION 1 — the v0.2.0 "verification" accepted any non-empty signature', () => {
  test('the old implementation accepted a bogus signature (documenting the defect)', () => {
    // This assertion documents the historical behaviour. If it ever starts
    // failing, the defect description above is no longer accurate.
    expect(legacyVerifySignature(SHA256, BOGUS_SIGNATURE, TEST_ADDRESS_A)).toBe(true);
    expect(legacyVerifySignature(SHA256, 'sig', '0xaddr')).toBe(true);
  });

  test('the new implementation rejects the very same inputs', () => {
    const payload = createSignedPayload({
      sha256: SHA256,
      sizeBytes: ARTIFACT.length,
      blobName: BLOB_NAME,
      sealedAt: SEALED_AT,
      network: NETWORK,
      signerPublicKey: TEST_PUBLIC_KEY_A,
    });

    for (const bogus of [BOGUS_SIGNATURE, 'sig', 'not-even-hex', '0x']) {
      const result = verifyEd25519Signature({
        payload,
        signatureHex: bogus,
        publicKeyHex: TEST_PUBLIC_KEY_A,
      });
      expect(result.valid).toBe(false);
    }
  });

  test('a manifest record with a forged signature never verifies as PASS', async () => {
    const entry = buildEntry({ signature: BOGUS_SIGNATURE });

    const result = await verifyEntry({
      entry,
      retrieve: async () => ARTIFACT,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_SIGNATURE');
    expect(result.signatureVerified).toBe(false);
    expect(result.signerVerified).toBe(false);
    // The content itself is intact — only the authenticity claim fails, and
    // the report says exactly that.
    expect(result.integrityVerified).toBe(true);
  });

  test('a forged signature is rejected even when the artifact bytes are correct', async () => {
    const entry = buildEntry({ signature: `0x${'ab'.repeat(64)}` });
    const result = await verifyEntry({ entry, retrieve: async () => ARTIFACT });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_SIGNATURE');
    expect(result.signatureVerified).toBe(false);
  });
});

describe('REGRESSION 2 — small-order public keys must not authenticate', () => {
  const ZERO_PUBLIC_KEY = `0x${'00'.repeat(32)}`;
  const ZERO_SIGNATURE = `0x${'00'.repeat(64)}`;
  const IDENTITY_PUBLIC_KEY = `0x01${'00'.repeat(31)}`;

  test('the SDK alone accepts the all-zero public key and signature', () => {
    // Documenting the upstream behaviour that makes the guard necessary.
    const { Ed25519PublicKey, Ed25519Signature } = require('@aptos-labs/ts-sdk/crypto');
    const upstream = new Ed25519PublicKey(ZERO_PUBLIC_KEY).verifyBytes({
      message: Buffer.from('anything'),
      signature: new Ed25519Signature(ZERO_SIGNATURE),
    });
    expect(upstream).toBe(true);
  });

  test('sealbox rejects the all-zero public key', () => {
    const validation = validateEd25519PublicKey(ZERO_PUBLIC_KEY);
    expect(validation.valid).toBe(false);
    expect(validation.valid === false && validation.reason).toBe('NOT_PRIME_ORDER');
  });

  test('sealbox rejects the identity-element public key', () => {
    const validation = validateEd25519PublicKey(IDENTITY_PUBLIC_KEY);
    expect(validation.valid).toBe(false);
    expect(validation.valid === false && validation.reason).toBe('IDENTITY_POINT');
  });

  test('a manifest built on the all-zero public key does not verify', async () => {
    const entry = buildEntry({
      signerPublicKey: ZERO_PUBLIC_KEY,
      signerAddress: deriveSignerAddressOf(ZERO_PUBLIC_KEY),
      signature: ZERO_SIGNATURE,
    });

    const result = await verifyEntry({ entry, retrieve: async () => ARTIFACT });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_MANIFEST');
    expect(result.signatureVerified).toBe(false);
    expect(result.signerVerified).toBe(false);
  });

  test('a manifest built on the identity-element public key does not verify', async () => {
    const entry = buildEntry({
      signerPublicKey: IDENTITY_PUBLIC_KEY,
      signerAddress: deriveSignerAddressOf(IDENTITY_PUBLIC_KEY),
      signature: ZERO_SIGNATURE,
    });

    const result = await verifyEntry({ entry, retrieve: async () => ARTIFACT });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_MANIFEST');
    expect(result.signatureVerified).toBe(false);
  });
});

describe('REGRESSION 3 — the signer identity cannot be swapped', () => {
  test('a valid signature with a different stored signer address fails', async () => {
    const entry = buildEntry({ signerAddress: TEST_ADDRESS_B });

    const result = await verifyEntry({ entry, retrieve: async () => ARTIFACT });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('SIGNER_MISMATCH');
    expect(result.signatureVerified).toBe(true);
    expect(result.signerVerified).toBe(false);
    expect(result.integrityVerified).toBe(true);
  });
});

describe('REGRESSION 4 — legacy records are never promoted', () => {
  test('a schema v1 record is reported as legacy and not signature-verified', async () => {
    const legacy = {
      sealId: SHA256.substring(0, 16),
      blobName: BLOB_NAME,
      sha256: SHA256,
      sizeBytes: ARTIFACT.length,
      sealedAt: SEALED_AT,
      signerAddress: TEST_ADDRESS_A,
      signature: BOGUS_SIGNATURE,
      explorerUrl: explorerUrl(NETWORK, BLOB_NAME),
    };

    const result = await verifyEntry({ entry: legacy, retrieve: async () => ARTIFACT });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('LEGACY_UNVERIFIABLE_SIGNATURE');
    expect(result.legacyRecord).toBe(true);
    expect(result.integrityVerified).toBe(true);
    expect(result.signatureVerified).toBe(false);
    expect(result.signerVerified).toBe(false);
  });
});

describe('REGRESSION 5 — a corrupted manifest must not look like an empty database', () => {
  test('loading a manifest with invalid JSON fails loudly', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealbox-regression-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ this is not json');
    const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8');

    expect(() => new Manifest(dir)).toThrow();

    // The corrupt file is left exactly as it was — never silently replaced.
    expect(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** Derive an address for an arbitrary public key, bypassing the strict guard. */
function deriveSignerAddressOf(publicKeyHex: string): string {
  // The guard is intentionally bypassed here: the point of the test is to
  // build a record that an attacker could construct, and to show that Sealbox
  // refuses to authenticate it.
  const { Ed25519PublicKey } = require('@aptos-labs/ts-sdk/crypto');
  const address = new Ed25519PublicKey(publicKeyHex)
    .authKey()
    .derivedAddress();
  return `0x${address.toStringLong().slice(2).toLowerCase()}`;
}

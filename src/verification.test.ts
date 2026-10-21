import {
  computeSha256,
  createSignedPayload,
  createSigner,
} from './crypto';
import { LegacyManifestEntry, ManifestEntryV2, V2_RECORD_VERSION } from './manifest';
import { SealboxError } from './errors';
import { VerificationResult, explorerUrl, verifyEntry } from './verification';
import {
  TEST_ADDRESS_A,
  TEST_ADDRESS_B,
  TEST_PRIVATE_KEY_A,
  TEST_PUBLIC_KEY_A,
} from './__fixtures__/keys';

const ARTIFACT = Buffer.from('sealbox verification fixture');
const SHA256 = computeSha256(ARTIFACT);
const BLOB_NAME = `sealbox/${SHA256}`;
const NETWORK = 'shelbynet';
const SEALED_AT = '2026-10-21T12:00:00.000Z';

function baseRecord(overrides: Partial<ManifestEntryV2> = {}): ManifestEntryV2 {
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
    signature: '',
    explorerUrl: explorerUrl(NETWORK, BLOB_NAME),
    signedPayloadVersion: '2',
    ...overrides,
  };
}

/** A record whose signature covers exactly the fields it carries. */
function signedEntry(overrides: Partial<ManifestEntryV2> = {}): ManifestEntryV2 {
  const record = baseRecord(overrides);
  const signer = createSigner(TEST_PRIVATE_KEY_A);
  try {
    let payload;
    try {
      payload = createSignedPayload({
        sha256: record.sha256,
        sizeBytes: record.sizeBytes,
        blobName: record.blobName,
        sealedAt: record.sealedAt,
        network: record.network,
        signerPublicKey: record.signerPublicKey,
      });
    } catch {
      // The record carries a field that cannot be signed at all (used by the
      // structural-validation tests). Sign the pristine base record instead.
      payload = createSignedPayload({
        sha256: SHA256,
        sizeBytes: ARTIFACT.length,
        blobName: BLOB_NAME,
        sealedAt: SEALED_AT,
        network: NETWORK,
        signerPublicKey: TEST_PUBLIC_KEY_A,
      });
    }
    record.signature = signer.sign(payload);
  } finally {
    signer.dispose();
  }
  return record;
}

/**
 * A record whose signed fields were edited *after* signing — i.e. exactly
 * what an attacker editing the local manifest would produce.
 */
function tamperedEntry(overrides: Partial<ManifestEntryV2> = {}): ManifestEntryV2 {
  const record = signedEntry();
  return { ...record, ...overrides };
}

function legacyEntry(overrides: Partial<LegacyManifestEntry> = {}): LegacyManifestEntry {
  return {
    sealId: SHA256.substring(0, 16),
    blobName: BLOB_NAME,
    sha256: SHA256,
    sizeBytes: ARTIFACT.length,
    sealedAt: SEALED_AT,
    signerAddress: TEST_ADDRESS_A,
    signature: 'legacy-signature-value',
    explorerUrl: explorerUrl(NETWORK, BLOB_NAME),
    ...overrides,
  };
}

const retrieveOk = async () => ARTIFACT;

describe('verification — happy path', () => {
  test('a well-formed record verifies with every component confirmed', async () => {
    const result: VerificationResult = await verifyEntry({
      entry: signedEntry(),
      retrieve: retrieveOk,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('PASS');
    expect(result.integrityVerified).toBe(true);
    expect(result.signatureVerified).toBe(true);
    expect(result.signerVerified).toBe(true);
    expect(result.legacyRecord).toBe(false);
    expect(result.sha256).toBe(SHA256);
    expect(result.signerPublicKey).toBe(TEST_PUBLIC_KEY_A);
  });
});

describe('verification — content integrity', () => {
  test('a one-byte modification is reported as TAMPERED', async () => {
    const tampered = Buffer.from(ARTIFACT);
    tampered[0] = tampered[0]! ^ 0x01;
    const result = await verifyEntry({ entry: signedEntry(), retrieve: async () => tampered });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('TAMPERED');
    expect(result.integrityVerified).toBe(false);
    expect(result.actualSha256).not.toBe(SHA256);
  });

  test('a truncated object is reported as TAMPERED', async () => {
    const result = await verifyEntry({
      entry: signedEntry(),
      retrieve: async () => ARTIFACT.subarray(0, ARTIFACT.length - 5),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('TAMPERED');
  });

  test('an empty replacement is reported as TAMPERED', async () => {
    const result = await verifyEntry({
      entry: signedEntry(),
      retrieve: async () => Buffer.alloc(0),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('TAMPERED');
  });

  test('a size mismatch is reported as TAMPERED', async () => {
    const result = await verifyEntry({
      entry: signedEntry({ sizeBytes: ARTIFACT.length + 1 }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('TAMPERED');
  });

  test('the same size but different content is reported as TAMPERED', async () => {
    const swapped = Buffer.alloc(ARTIFACT.length, 0x41);
    const result = await verifyEntry({ entry: signedEntry(), retrieve: async () => swapped });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('TAMPERED');
  });

  test('appended data is reported as TAMPERED', async () => {
    const appended = Buffer.concat([ARTIFACT, Buffer.from('APPENDED')]);
    const result = await verifyEntry({ entry: signedEntry(), retrieve: async () => appended });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('TAMPERED');
    expect(result.integrityVerified).toBe(false);
    expect(result.actualSha256).not.toBe(SHA256);
  });

  test('prepended data is reported as TAMPERED', async () => {
    const prepended = Buffer.concat([Buffer.from('PREPENDED'), ARTIFACT]);
    const result = await verifyEntry({ entry: signedEntry(), retrieve: async () => prepended });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('TAMPERED');
  });
});

describe('verification — signature authenticity', () => {
  test('a forged signature is rejected', async () => {
    const result = await verifyEntry({
      entry: tamperedEntry({ signature: `0x${'de'.repeat(64)}` }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_SIGNATURE');
    expect(result.signatureVerified).toBe(false);
  });

  test('a malformed signature is rejected', async () => {
    for (const signature of ['', 'sig', `0x${'de'.repeat(63)}`]) {
      const result = await verifyEntry({
        entry: tamperedEntry({ signature }),
        retrieve: retrieveOk,
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('INVALID_SIGNATURE');
      expect(result.signatureVerified).toBe(false);
    }
  });

  test('editing the recorded digest invalidates the signature', async () => {
    const result = await verifyEntry({
      entry: tamperedEntry({ sha256: '9'.repeat(64) }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_SIGNATURE');
  });

  test('editing the recorded blob name invalidates the signature', async () => {
    const result = await verifyEntry({
      entry: tamperedEntry({ blobName: 'sealbox/somewhere-else' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_SIGNATURE');
  });

  test('editing the recorded timestamp invalidates the signature', async () => {
    const result = await verifyEntry({
      entry: tamperedEntry({ sealedAt: '2020-01-01T00:00:00.000Z' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_SIGNATURE');
  });

  test('editing the recorded network invalidates the signature', async () => {
    const result = await verifyEntry({
      entry: tamperedEntry({ network: 'testnet' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_SIGNATURE');
  });

  test('swapping in another signer public key invalidates the signature', async () => {
    const other = createSigner('0x' + '22'.repeat(32));
    try {
      const result = await verifyEntry({
        entry: tamperedEntry({ signerPublicKey: other.signerPublicKey }),
        retrieve: retrieveOk,
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('INVALID_SIGNATURE');
    } finally {
      other.dispose();
    }
  });
});

describe('verification — signer consistency', () => {
  test('a valid signature with a different stored address is a SIGNER_MISMATCH', async () => {
    const result = await verifyEntry({
      entry: tamperedEntry({ signerAddress: TEST_ADDRESS_B }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('SIGNER_MISMATCH');
    expect(result.signatureVerified).toBe(true);
    expect(result.signerVerified).toBe(false);
  });

  test('a malformed stored signer address is an invalid manifest', async () => {
    const result = await verifyEntry({
      entry: tamperedEntry({ signerAddress: '0xnope' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_MANIFEST');
  });
});

describe('verification — record validation', () => {
  test('an unsupported signed payload version is reported as such', async () => {
    const result = await verifyEntry({
      entry: signedEntry({ signedPayloadVersion: '3' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('UNSUPPORTED_SCHEMA');
  });

  test('an unsupported signature scheme is reported as such', async () => {
    const result = await verifyEntry({
      entry: signedEntry({ signatureScheme: 'secp256k1' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('UNSUPPORTED_SCHEMA');
  });

  test('a malformed public key is an invalid manifest', async () => {
    const result = await verifyEntry({
      entry: signedEntry({ signerPublicKey: '0xnothex' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_MANIFEST');
  });

  test('a seal ID that is not a prefix of the digest is an invalid manifest', async () => {
    const result = await verifyEntry({
      entry: signedEntry({ sealId: 'deadbeefdeadbeef' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_MANIFEST');
  });

  test('an explorer URL that does not match the record is an invalid manifest', async () => {
    const result = await verifyEntry({
      entry: signedEntry({ explorerUrl: 'https://explorer.shelby.xyz/evil/blob/x' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_MANIFEST');
  });

  test('a malformed digest is an invalid manifest', async () => {
    const result = await verifyEntry({
      entry: signedEntry({ sha256: 'not-a-digest' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_MANIFEST');
  });

  test('a malformed blob name is an invalid manifest', async () => {
    const result = await verifyEntry({
      entry: signedEntry({ blobName: '' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_MANIFEST');
  });
});

describe('verification — storage failures', () => {
  test('a missing object is reported as NOT_FOUND', async () => {
    const result = await verifyEntry({
      entry: signedEntry(),
      retrieve: async () => {
        throw new SealboxError('Blob not found on Shelby: x', 'NOT_FOUND');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('NOT_FOUND');
    expect(result.integrityVerified).toBe(false);
  });

  test('any other retrieval failure is reported as STORAGE_ERROR', async () => {
    const result = await verifyEntry({
      entry: signedEntry(),
      retrieve: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('STORAGE_ERROR');
  });
});

describe('verification — legacy records', () => {
  test('a legacy record with intact content is integrity-verified but not signature-verified', async () => {
    const result = await verifyEntry({ entry: legacyEntry(), retrieve: retrieveOk });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('LEGACY_UNVERIFIABLE_SIGNATURE');
    expect(result.legacyRecord).toBe(true);
    expect(result.integrityVerified).toBe(true);
    expect(result.signatureVerified).toBe(false);
    expect(result.signerVerified).toBe(false);
  });

  test('a legacy record with tampered content is reported as TAMPERED', async () => {
    const result = await verifyEntry({
      entry: legacyEntry(),
      retrieve: async () => Buffer.from('different'),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('TAMPERED');
    expect(result.legacyRecord).toBe(true);
  });

  test('a legacy record with a malformed digest is an invalid manifest', async () => {
    const result = await verifyEntry({
      entry: legacyEntry({ sha256: 'nope' }),
      retrieve: retrieveOk,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_MANIFEST');
  });
});

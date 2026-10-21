/**
 * Tests for the live-integration harness logic.
 *
 * The harness's own network behaviour is deliberately NOT mocked away here:
 * the final real-network round trip is a separate, opt-in command
 * (`npm run integration:shelby`). What is tested below is the harness's
 * decision logic — blocker classification, evidence shaping and the local
 * tamper check — so that a blocked run cannot be misreported as a success
 * and a successful run cannot be misreported as verified.
 */
import { SealboxError } from '../errors';
import {
  buildEvidence,
  classifyBlocker,
  rehydrateCliError,
  safeHost,
  safePath,
  verifyTamperedLocalCopy,
} from './live-shelby-smoke';
import { computeSha256, createSignedPayload, createSigner } from '../crypto';
import { ManifestEntryV2, V2_RECORD_VERSION } from '../manifest';
import { explorerUrl, verifyEntry } from '../verification';
import { TEST_ADDRESS_A, TEST_PRIVATE_KEY_A, TEST_PUBLIC_KEY_A } from '../__fixtures__/keys';

const ARTIFACT = Buffer.from('live harness fixture');

function signedEntry(): ManifestEntryV2 {
  const sha256 = computeSha256(ARTIFACT);
  const blobName = `sealbox/${sha256}`;
  const signer = createSigner(TEST_PRIVATE_KEY_A);
  try {
    const payload = createSignedPayload({
      sha256,
      sizeBytes: ARTIFACT.length,
      blobName,
      sealedAt: '2026-10-21T12:00:00.000Z',
      network: 'shelbynet',
      signerPublicKey: signer.signerPublicKey,
    });
    return {
      recordVersion: V2_RECORD_VERSION,
      sealId: sha256.substring(0, 16),
      blobName,
      sha256,
      sizeBytes: ARTIFACT.length,
      sealedAt: '2026-10-21T12:00:00.000Z',
      network: 'shelbynet',
      signatureScheme: 'ed25519',
      signerPublicKey: TEST_PUBLIC_KEY_A,
      signerAddress: TEST_ADDRESS_A,
      signature: signer.sign(payload),
      explorerUrl: explorerUrl('shelbynet', blobName),
      signedPayloadVersion: '2',
    };
  } finally {
    signer.dispose();
  }
}

describe('live harness — blocker classification', () => {
  test('a missing configuration is classified as MISSING_CONFIGURATION', () => {
    const blocker = classifyBlocker(
      new SealboxError('SHELBY_S3_ENDPOINT is not set.', 'CONFIG'),
    );
    expect(blocker.kind).toBe('MISSING_CONFIGURATION');
    expect(blocker.nextAction).toContain('npm run integration:shelby');
  });

  test('a rejected credential is classified as AUTHENTICATION', () => {
    const blocker = classifyBlocker(
      new SealboxError('rejected the supplied credentials (HTTP 401)', 'AUTHENTICATION'),
    );
    expect(blocker.kind).toBe('AUTHENTICATION');
    expect(blocker.nextAction).toContain('SHELBY_S3_ACCESS_KEY_ID');
  });

  test('a denied bucket is classified as AUTHORIZATION', () => {
    const blocker = classifyBlocker(
      new SealboxError('denied the request (HTTP 403)', 'AUTHORIZATION'),
    );
    expect(blocker.kind).toBe('AUTHORIZATION');
    expect(blocker.nextAction).toContain('SHELBY_S3_BUCKET');
  });

  test('insufficient funds, rate limiting, 404, 5xx and network are distinct', () => {
    expect(
      classifyBlocker(new SealboxError('no funds', 'INSUFFICIENT_FUNDS')).kind,
    ).toBe('INSUFFICIENT_FUNDS');
    expect(classifyBlocker(new SealboxError('slow down', 'RATE_LIMITED')).kind).toBe(
      'RATE_LIMITED',
    );
    expect(classifyBlocker(new SealboxError('gone', 'NOT_FOUND')).kind).toBe('NOT_FOUND');
    expect(classifyBlocker(new SealboxError('down', 'NETWORK')).kind).toBe('NETWORK');
  });

  test('raw HTTP statuses are classified from the response metadata', () => {
    const withStatus = (status: number, message: string) =>
      Object.assign(new Error(message), { $metadata: { httpStatusCode: status } });
    expect(classifyBlocker(withStatus(401, 'nope')).kind).toBe('AUTHENTICATION');
    expect(classifyBlocker(withStatus(403, 'nope')).kind).toBe('AUTHORIZATION');
    expect(classifyBlocker(withStatus(402, 'nope')).kind).toBe('INSUFFICIENT_FUNDS');
    expect(classifyBlocker(withStatus(404, 'nope')).kind).toBe('NOT_FOUND');
    expect(classifyBlocker(withStatus(429, 'nope')).kind).toBe('RATE_LIMITED');
    expect(classifyBlocker(withStatus(503, 'nope')).kind).toBe('SERVER_ERROR');
  });

  test('an unknown failure is not silently reported as a known blocker', () => {
    expect(classifyBlocker(new Error('who knows')).kind).toBe('UNKNOWN');
  });
});

describe('live harness — CLI error rehydration', () => {
  test('the CLI JSON error contract keeps its typed code', () => {
    const err = rehydrateCliError(
      JSON.stringify({ ok: false, error: 'rejected', code: 'AUTHENTICATION' }),
      '',
    );
    expect(err).toBeInstanceOf(SealboxError);
    expect((err as SealboxError).code).toBe('AUTHENTICATION');
    expect(classifyBlocker(err).kind).toBe('AUTHENTICATION');
  });

  test('non-JSON output still produces a failure, not a success', () => {
    const err = rehydrateCliError('boom', '');
    expect(err).toBeInstanceOf(Error);
    expect(classifyBlocker(err).kind).toBe('UNKNOWN');
  });
});

describe('live harness — evidence shaping', () => {
  test('the evidence record never contains a secret', () => {
    const entry = signedEntry();
    const evidence = buildEvidence({
      startedAt: '2026-10-21T12:00:00.000Z',
      finishedAt: '2026-10-21T12:00:01.000Z',
      network: 'shelbynet',
      endpoint: 'https://user:pass@api.shelbynet.shelby.xyz/shelby?token=abc',
      bucket: entry.sealId,
      blobName: entry.blobName,
      sealId: entry.sealId,
      fixtureBytes: ARTIFACT.length,
      localSha256: entry.sha256,
      downloadedSha256: entry.sha256,
      downloadBytes: ARTIFACT.length,
      verification: {
        ok: true,
        status: 'PASS',
        sealId: entry.sealId,
        legacyRecord: false,
        integrityVerified: true,
        signatureVerified: true,
        signerVerified: true,
        detail: '',
      },
      localTamperStatus: 'TAMPERED',
      durationMs: 1234,
      attempts: 1,
    });

    const serialised = JSON.stringify(evidence);
    expect(serialised).not.toContain('user:pass');
    expect(serialised).not.toContain('token=abc');
    expect(evidence.endpointHost).toBe('api.shelbynet.shelby.xyz');
    expect(evidence.endpointPath).toBe('/shelby');
    expect(evidence.hashesEqual).toBe(true);
    expect(evidence.localTamperRejected).toBe(true);
  });

  test('safeHost and safePath tolerate a malformed endpoint', () => {
    expect(safeHost('not a url')).toBe('(invalid endpoint)');
    expect(safePath('not a url')).toBe('');
  });
});

describe('live harness — local tamper check', () => {
  test('a locally modified copy of the retrieved bytes fails verification', async () => {
    const entry = signedEntry();
    const result = await verifyTamperedLocalCopy(entry, ARTIFACT);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('TAMPERED');
    expect(result.integrityVerified).toBe(false);
  });

  test('the unmodified bytes still verify, so the tamper check is meaningful', async () => {
    const entry = signedEntry();
    const result = await verifyEntry({ entry, retrieve: async () => ARTIFACT });
    expect(result.ok).toBe(true);
    expect(result.signatureVerified).toBe(true);
  });
});

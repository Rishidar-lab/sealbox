/**
 * Live Shelby integration smoke test.
 *
 * Run with:
 *
 *     npm run integration:shelby
 *
 * It performs a real, end-to-end round trip against the configured Shelby
 * storage endpoint:
 *
 *   1. write a small disposable plaintext fixture;
 *   2. compute its local SHA-256;
 *   3. seal it with the real SealBox v2 implementation (Ed25519 signature
 *      over the canonical signed record);
 *   4. upload the artifact to the real endpoint;
 *   5. retrieve the exact uploaded bytes from the network;
 *   6. compare the local and downloaded SHA-256;
 *   7. run SealBox verification over the retrieved bytes;
 *   8. confirm `signatureVerified` and `signerVerified`;
 *   9. build a LOCAL modified copy of the downloaded bytes and confirm that
 *      verification of it fails.
 *
 * The remote object is never mutated to test tampering — the tamper check
 * runs entirely against local bytes.
 *
 * The harness never prints a private key, an API key, a signing secret or an
 * Authorization header. It exits non-zero on any real failure, and it never
 * reports "uploaded" as "verified".
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeSha256, createSigner } from '../crypto';
import { runCli, makeStorageFromEnv } from '../cli';
import { SealboxError } from '../errors';
import { ShelbyStorage } from '../storage';
import { VerificationResult, verifyEntry } from '../verification';
import { Manifest } from '../manifest';

/** Classification of a live failure, used to report a precise blocker. */
export type BlockerKind =
  | 'MISSING_CONFIGURATION'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'INSUFFICIENT_FUNDS'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK'
  | 'VERIFICATION_FAILED'
  | 'UNKNOWN';

/** A failure classification that names the exact next action. */
export interface Blocker {
  kind: BlockerKind;
  message: string;
  /** The minimal human action that would unblock the run, if any. */
  nextAction?: string;
}

/** Non-secret evidence captured for one live run. */
export interface LiveRunEvidence {
  startedAt: string;
  finishedAt: string;
  network: string;
  endpointHost: string;
  endpointPath: string;
  bucket: string;
  blobName: string;
  sealId: string;
  fixtureBytes: number;
  localSha256: string;
  downloadedSha256: string;
  hashesEqual: boolean;
  downloadBytes: number;
  uploadOk: boolean;
  downloadOk: boolean;
  verificationStatus: string;
  signatureVerified: boolean;
  signerVerified: boolean;
  integrityVerified: boolean;
  localTamperStatus: string;
  localTamperRejected: boolean;
  durationMs: number;
  attempts: number;
}

/**
 * Classify an error raised by a live Shelby call.
 *
 * The mapping is explicit so that a blocked run names the exact blocker
 * instead of collapsing every failure into "something went wrong".
 */
export function classifyBlocker(err: unknown): Blocker {
  if (err instanceof SealboxError) {
    switch (err.code) {
      case 'INSUFFICIENT_FUNDS':
        return {
          kind: 'INSUFFICIENT_FUNDS',
          message: err.message,
          nextAction:
            'Fund the Shelby account with ShelbyUSD (the account also needs APT for gas), then re-run: npm run integration:shelby',
        };
      case 'RATE_LIMITED':
        return {
          kind: 'RATE_LIMITED',
          message: err.message,
          nextAction:
            'Wait for the rate limit to clear, or configure a Shelby API key, then re-run: npm run integration:shelby',
        };
      case 'NOT_FOUND':
        return {
          kind: 'NOT_FOUND',
          message: err.message,
          nextAction:
            'Confirm the bucket resolves to the signing account and that the object was written.',
        };
      case 'CONFIG':
        return {
          kind: 'MISSING_CONFIGURATION',
          message: err.message,
          nextAction:
            'Set SHELBY_S3_ENDPOINT, SHELBY_API_KEY and SIGNER_PRIVATE_KEY (see .env.example), then re-run: npm run integration:shelby',
        };
      case 'NETWORK':
        return {
          kind: 'NETWORK',
          message: err.message,
          nextAction: 'Check network reachability to the Shelby endpoint, then re-run.',
        };
      case 'AUTHENTICATION':
        return {
          kind: 'AUTHENTICATION',
          message: err.message,
          nextAction:
            'Set SHELBY_S3_ACCESS_KEY_ID and SHELBY_S3_SECRET_ACCESS_KEY to the signing secrets issued for the S3 gateway, then re-run: npm run integration:shelby',
        };
      case 'AUTHORIZATION':
        return {
          kind: 'AUTHORIZATION',
          message: err.message,
          nextAction:
            'Set SHELBY_S3_BUCKET to the signing account address, then re-run: npm run integration:shelby',
        };
      default:
        return { kind: 'UNKNOWN', message: err.message };
    }
  }

  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  const name = (err as { name?: string })?.name ?? '';
  const message = err instanceof Error ? err.message : String(err);

  if (status === 401 || /Unauthorized|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(message)) {
    return {
      kind: 'AUTHENTICATION',
      message: `Storage endpoint rejected the supplied credentials (HTTP ${status ?? 'unknown'}): ${message}`,
      nextAction:
        'The Shelby S3 gateway needs its own accessKeyId/secretAccessKey. Set SHELBY_S3_ACCESS_KEY_ID and SHELBY_S3_SECRET_ACCESS_KEY, then re-run: npm run integration:shelby',
    };
  }
  if (status === 403) {
    return {
      kind: 'AUTHORIZATION',
      message: `Storage endpoint denied the request (HTTP 403): ${message}`,
      nextAction:
        'The bucket must resolve to the signing account address. Set SHELBY_S3_BUCKET to the account address, then re-run: npm run integration:shelby',
    };
  }
  if (status === 402) {
    return {
      kind: 'INSUFFICIENT_FUNDS',
      message: `Storage endpoint reported insufficient funds (HTTP 402): ${message}`,
      nextAction:
        'Fund the Shelby account with ShelbyUSD (and APT for gas), then re-run: npm run integration:shelby',
    };
  }
  if (status === 404) {
    return {
      kind: 'NOT_FOUND',
      message: `Storage endpoint returned 404: ${message}`,
      nextAction: 'Confirm the bucket and blob name.',
    };
  }
  if (status === 429) {
    return {
      kind: 'RATE_LIMITED',
      message: `Storage endpoint rate limited the request (HTTP 429): ${message}`,
      nextAction: 'Wait, or configure a Shelby API key, then re-run.',
    };
  }
  if (typeof status === 'number' && status >= 500) {
    return {
      kind: 'SERVER_ERROR',
      message: `Storage endpoint returned HTTP ${status}: ${message}`,
      nextAction: 'Retry later; the endpoint may be temporarily unavailable.',
    };
  }
  if (name === 'TimeoutError' || name === 'AbortError') {
    return {
      kind: 'NETWORK',
      message: `Storage request did not complete: ${message}`,
      nextAction: 'Check network reachability, then re-run.',
    };
  }
  return { kind: 'UNKNOWN', message };
}

/** Build the non-secret evidence record for a completed run. */
export function buildEvidence(input: {
  startedAt: string;
  finishedAt: string;
  network: string;
  endpoint: string;
  bucket: string;
  blobName: string;
  sealId: string;
  fixtureBytes: number;
  localSha256: string;
  downloadedSha256: string;
  downloadBytes: number;
  verification: VerificationResult;
  localTamperStatus: string;
  durationMs: number;
  attempts: number;
}): LiveRunEvidence {
  return {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    network: input.network,
    endpointHost: safeHost(input.endpoint),
    endpointPath: safePath(input.endpoint),
    bucket: input.bucket,
    blobName: input.blobName,
    sealId: input.sealId,
    fixtureBytes: input.fixtureBytes,
    localSha256: input.localSha256,
    downloadedSha256: input.downloadedSha256,
    hashesEqual: input.localSha256 === input.downloadedSha256,
    downloadBytes: input.downloadBytes,
    uploadOk: true,
    downloadOk: true,
    verificationStatus: input.verification.status,
    signatureVerified: input.verification.signatureVerified,
    signerVerified: input.verification.signerVerified,
    integrityVerified: input.verification.integrityVerified,
    localTamperStatus: input.localTamperStatus,
    localTamperRejected: input.localTamperStatus !== 'PASS',
    durationMs: input.durationMs,
    attempts: input.attempts,
  };
}

/** Host of an endpoint, with any userinfo removed. */
export function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '(invalid endpoint)';
  }
}

/** Path of an endpoint, with any query string removed. */
export function safePath(endpoint: string): string {
  try {
    return new URL(endpoint).pathname;
  } catch {
    return '';
  }
}

/**
 * Compare a locally modified copy of the retrieved bytes against the record.
 *
 * The modification is applied to local bytes only; the remote object is
 * never touched.
 */
export function verifyTamperedLocalCopy(
  entry: Parameters<typeof verifyEntry>[0]['entry'],
  retrieved: Buffer,
): Promise<VerificationResult> {
  const tampered = Buffer.from(retrieved);
  if (tampered.length === 0) {
    tampered.write('tampered');
  } else {
    tampered[0] = tampered[0]! ^ 0x01;
  }
  return verifyEntry({ entry, retrieve: async () => tampered });
}

/**
 * Turn the CLI's JSON error output back into a typed error so that the
 * blocker classification keeps the original code.
 */
export function rehydrateCliError(stderrText: string, stdoutText: string): unknown {
  const trimmed = stderrText.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { ok?: boolean; error?: string; code?: string };
      if (parsed.code) {
        return new SealboxError(parsed.error ?? 'CLI reported an error', parsed.code as never);
      }
      return new Error(parsed.error ?? 'CLI reported an error');
    } catch {
      /* fall through to the plain-text handling below */
    }
  }
  return new Error(
    `seal failed: ${trimmed || stdoutText.trim() || 'no diagnostic output'}`,
  );
}

async function main(): Promise<number> {
  const env = process.env;
  const startedAt = new Date();
  const started = Date.now();

  const required = ['SHELBY_S3_ENDPOINT', 'SIGNER_PRIVATE_KEY'] as const;
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    const blocker = classifyBlocker(
      new SealboxError(
        `Missing required configuration: ${missing.join(', ')}`,
        'CONFIG',
      ),
    );
    printBlocker(blocker);
    return 2;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealbox-live-'));
  let attempts = 0;
  let storage: ShelbyStorage | undefined;

  try {
    const fixture = path.join(workDir, 'live-smoke-fixture.txt');
    const fixtureText = `sealbox v0.3.0 live smoke fixture\nrun=${startedAt.toISOString()}\n`;
    fs.writeFileSync(fixture, fixtureText);
    const fixtureBytes = fs.readFileSync(fixture);
    const localSha256 = computeSha256(fixtureBytes);

    const network = env.SHELBY_NETWORK ?? 'shelbynet';
    const signer = createSigner(env.SIGNER_PRIVATE_KEY!);
    const signerAddress: string = signer.signerAddress;
    signer.dispose();

    storage = makeStorageFromEnv(env, signerAddress);
    const bucket = storage.resolved.bucket;

    console.log('sealbox live Shelby smoke test');
    console.log(`  network        : ${network}`);
    console.log(`  endpoint host  : ${safeHost(env.SHELBY_S3_ENDPOINT!)}`);
    console.log(`  endpoint path  : ${safePath(env.SHELBY_S3_ENDPOINT!)}`);
    console.log(`  bucket         : ${bucket}`);
    console.log(`  account        : ${signerAddress}`);
    console.log(`  fixture        : ${fixtureBytes.length} bytes, sha256=${localSha256}`);

    // ── seal through the real CLI path ────────────────────────────────────
    const sealOut: string[] = [];
    const sealErr: string[] = [];
    const sealCode = await runCli(['node', 'sealbox', 'seal', fixture, '--json'], {
      env,
      cwd: workDir,
      stdout: (t) => sealOut.push(t),
      stderr: (t) => sealErr.push(t),
      makeStorage: () => storage!,
    });
    if (sealCode !== 0) {
      printBlocker(classifyBlocker(rehydrateCliError(sealErr.join(''), sealOut.join(''))));
      return 1;
    }
    const sealed = JSON.parse(sealOut.join('')) as Record<string, string>;
    const sealId = sealed.sealId!;
    const blobName = sealed.blobName!;
    console.log(`  sealed         : sealId=${sealId} blob=${blobName}`);

    // ── retrieve the exact uploaded bytes from the network ─────────────────
    attempts += 1;
    const downloaded = await storage.download(blobName);
    const downloadedSha256 = computeSha256(downloaded);
    console.log(`  downloaded     : ${downloaded.length} bytes, sha256=${downloadedSha256}`);
    if (downloadedSha256 !== localSha256) {
      console.error('  FAIL: downloaded bytes do not match the local fixture');
      return 1;
    }

    // ── verification over the retrieved bytes ─────────────────────────────
    const manifest = new Manifest(workDir);
    const entry = manifest.getEntry(sealId)!;
    const verification = await verifyEntry({
      entry,
      retrieve: async () => downloaded,
    });
    console.log(
      `  verification   : status=${verification.status} integrity=${verification.integrityVerified} signature=${verification.signatureVerified} signer=${verification.signerVerified}`,
    );
    if (!verification.ok || !verification.signatureVerified || !verification.signerVerified) {
      console.error('  FAIL: SealBox verification did not pass over the retrieved bytes');
      return 1;
    }

    // ── local tamper check (never mutates the remote object) ──────────────
    const tampered = await verifyTamperedLocalCopy(entry, downloaded);
    console.log(`  local tamper   : status=${tampered.status}`);
    if (tampered.ok || tampered.status === 'PASS') {
      console.error('  FAIL: a locally modified copy was accepted');
      return 1;
    }

    const evidence = buildEvidence({
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      network,
      endpoint: env.SHELBY_S3_ENDPOINT!,
      bucket,
      blobName,
      sealId,
      fixtureBytes: fixtureBytes.length,
      localSha256,
      downloadedSha256,
      downloadBytes: downloaded.length,
      verification,
      localTamperStatus: tampered.status,
      durationMs: Date.now() - started,
      attempts,
    });

    console.log('\nLIVE SHELBY ROUND TRIP: PASS');
    console.log(JSON.stringify(evidence, null, 2));
    return 0;
  } catch (err) {
    const blocker = classifyBlocker(err);
    printBlocker(blocker);
    return 1;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function printBlocker(blocker: Blocker): void {
  console.error('');
  console.error(`BLOCKED: ${blocker.kind}`);
  console.error(`  ${blocker.message}`);
  if (blocker.nextAction) {
    console.error(`  Next: ${blocker.nextAction}`);
  }
  console.error('');
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import {
  ED25519_SIGNATURE_SCHEME,
  SIGNED_PAYLOAD_VERSION,
  computeSha256,
  createSignedPayload,
  createSigner,
} from './crypto';
import { SealboxError } from './errors';
import {
  LEGACY_RECORD_VERSION,
  Manifest,
  ManifestEntry,
  V2_RECORD_VERSION,
} from './manifest';
import { ShelbyStorage } from './storage';
import {
  VerificationResult,
  VerificationStatus,
  explorerUrl,
  verifyEntry,
} from './verification';

/** State of a single preflight check. */
export type CheckState = 'pass' | 'fail' | 'unknown' | 'skipped';

export interface DoctorCheck {
  name: string;
  state: CheckState;
  note: string;
}

export interface DoctorReport {
  ok: boolean;
  ready: boolean;
  localChecks: DoctorCheck[];
  liveChecks: DoctorCheck[];
  summary: {
    localPassed: number;
    localTotal: number;
    livePassed: number;
    liveTotal: number;
  };
}

/** Injectable environment for the CLI, so behaviour is testable. */
export interface CliEnvironment {
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => Date;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * Build the storage client.
   *
   * @param signerAddress the Aptos account address the bucket must resolve
   *   to. `seal` passes the signing key's address; `verify` passes the
   *   address recorded in the manifest, so both address the same bucket
   *   without verification ever needing the private key.
   */
  makeStorage: (env: NodeJS.ProcessEnv, signerAddress?: string) => ShelbyStorage;
  fetchJson: (url: string, timeoutMs: number) => Promise<{ status: number; body: unknown }>;
}

const DEFAULT_FULLNODES: Record<string, string> = {
  shelbynet: 'https://api.shelbynet.shelby.xyz/v1',
  testnet: 'https://fullnode.testnet.aptoslabs.com/v1',
};

const APT_COIN_TYPE = '0x1::aptos_coin::AptosCoin';
const SHELBYUSD_COIN_TYPE =
  '0x1b18363a9f1fe5e6ebf247daba5cc1c18052bb232efdc4c50f556053922d98e1::shelby_usd::ShelbyUSD';

function defaultFetchJson(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        clearTimeout(timer);
        const text = await res.text();
        let body: unknown = null;
        try {
          body = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        resolve({ status: res.status, body });
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function defaultEnvironment(): CliEnvironment {
  return {
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    makeStorage: (env, signerAddress) => makeStorageFromEnv(env, signerAddress),
    fetchJson: defaultFetchJson,
  };
}

/**
 * Default S3 signing region for the Shelby S3 gateway.
 *
 * The gateway's own `server.region` defaults to `shelbyland` and the region
 * used to sign a request must match the gateway's, so `us-east-1` (which
 * v0.2.0 hard-coded) would produce a signature the gateway rejects.
 */
export const DEFAULT_S3_REGION = 'shelbyland';

/** Fallback bucket name when no account address is known. */
export const FALLBACK_S3_BUCKET = 'shelby';

/**
 * Build the storage client from configuration.
 *
 * The Shelby S3 gateway is an S3-compatible proxy in front of the Shelby
 * blob network. Its contract (see docs/SHELBY-INTEGRATION.md):
 *
 * * the S3 signing region must match the gateway's `server.region`,
 *   default `shelbyland`;
 * * the bucket must resolve to the Aptos account that owns the objects, so
 *   the account address is used as the bucket name unless one is configured;
 * * the S3 `accessKeyId` / `secretAccessKey` are shared signing secrets
 *   between the client and the gateway, distinct from the Shelby API key.
 *
 * @param signerAddress the signer's Aptos address, used to resolve the
 *   bucket when `SHELBY_S3_BUCKET` is not set.
 */
export function makeStorageFromEnv(
  env: NodeJS.ProcessEnv,
  signerAddress?: string,
): ShelbyStorage {
  const endpoint = env.SHELBY_S3_ENDPOINT;
  if (!endpoint) {
    throw new SealboxError(
      'SHELBY_S3_ENDPOINT is not set. Copy .env.example to .env and fill in the values.',
      'CONFIG',
    );
  }
  const apiKey = env.SHELBY_API_KEY;
  const accessKeyId = env.SHELBY_S3_ACCESS_KEY_ID ?? apiKey ?? 'anonymous';
  const secretAccessKey =
    env.SHELBY_S3_SECRET_ACCESS_KEY ?? apiKey ?? 'anonymous';
  const bucket =
    env.SHELBY_S3_BUCKET ?? signerAddress ?? FALLBACK_S3_BUCKET;
  const timeoutRaw = env.SHELBY_S3_TIMEOUT_MS;
  const requestTimeoutMs =
    timeoutRaw !== undefined && timeoutRaw.trim().length > 0
      ? Number(timeoutRaw)
      : undefined;
  if (requestTimeoutMs !== undefined && !Number.isFinite(requestTimeoutMs)) {
    throw new SealboxError(
      `SHELBY_S3_TIMEOUT_MS is not a number: ${timeoutRaw}`,
      'CONFIG',
    );
  }

  return new ShelbyStorage({
    endpoint,
    region: env.SHELBY_S3_REGION ?? DEFAULT_S3_REGION,
    accessKeyId,
    secretAccessKey,
    bucket,
    requestTimeoutMs,
  });
}

/** Map a manifest error onto a verification status. */
function manifestErrorStatus(err: SealboxError): VerificationStatus {
  switch (err.code) {
    case 'UNSUPPORTED_SCHEMA':
      return 'UNSUPPORTED_SCHEMA';
    default:
      return 'INVALID_MANIFEST';
  }
}

function iconFor(state: CheckState): string {
  switch (state) {
    case 'pass':
      return '✓';
    case 'fail':
      return '✗';
    case 'unknown':
      return '?';
    default:
      return '-';
  }
}

function printVerificationHuman(
  result: VerificationResult,
  stdout: (text: string) => void,
): void {
  const lines: string[] = [];
  switch (result.status) {
    case 'PASS':
      lines.push('PASS ✓');
      lines.push(`  SHA-256:    ${result.sha256}`);
      lines.push(`  Size:       ${result.sizeBytes} bytes`);
      lines.push(`  Sealed at:  ${result.sealedAt}`);
      lines.push(`  Signer:     ${result.signerAddress}`);
      lines.push(`  Public key: ${result.signerPublicKey}`);
      lines.push('  Integrity:  verified (retrieved bytes match the recorded SHA-256)');
      lines.push('  Signature:  verified (Ed25519 over the canonical signed record)');
      lines.push('  Signer id:  verified (address derived from the stored public key)');
      lines.push(`  Explorer:   ${result.explorerUrl}`);
      break;
    case 'LEGACY_UNVERIFIABLE_SIGNATURE':
      lines.push('LEGACY — NOT FULLY VERIFIED');
      lines.push(`  SHA-256:    ${result.sha256}`);
      lines.push('  Integrity:  verified (retrieved bytes match the recorded SHA-256)');
      lines.push('  Signature:  NOT verified — this is a schema v1 record.');
      lines.push('              Schema v1 records contain no public key, so the stored');
      lines.push('              signature cannot be cryptographically verified. A legacy');
      lines.push('              record cannot acquire a trustworthy historical signature');
      lines.push('              retroactively.');
      lines.push('  Signer id:  NOT verified — no public key is stored.');
      break;
    case 'NOT_FOUND':
      lines.push(`NOT-FOUND: ${result.detail}`);
      break;
    case 'TAMPERED':
      lines.push(`TAMPERED: ${result.detail}`);
      if (result.sha256) lines.push(`  Expected: ${result.sha256}`);
      if (result.actualSha256) lines.push(`  Actual:   ${result.actualSha256}`);
      break;
    case 'INVALID_SIGNATURE':
      lines.push(`INVALID SIGNATURE: ${result.detail}`);
      break;
    case 'SIGNER_MISMATCH':
      lines.push(`SIGNER MISMATCH: ${result.detail}`);
      lines.push(`  Recorded signer: ${result.signerAddress}`);
      break;
    case 'AMBIGUOUS_SEAL_ID':
      lines.push(`AMBIGUOUS SEAL ID: ${result.detail}`);
      break;
    case 'UNSUPPORTED_SCHEMA':
      lines.push(`UNSUPPORTED SCHEMA: ${result.detail}`);
      break;
    case 'INVALID_MANIFEST':
      lines.push(`INVALID MANIFEST: ${result.detail}`);
      break;
    default:
      lines.push(`${result.status}: ${result.detail}`);
      break;
  }
  stdout(`${lines.join('\n')}\n`);
}

function emitVerification(
  result: VerificationResult,
  json: boolean,
  stdout: (text: string) => void,
): number {
  if (json) {
    stdout(`${JSON.stringify(result)}\n`);
  } else {
    printVerificationHuman(result, stdout);
  }
  return result.ok ? 0 : 1;
}

function handleError(
  err: unknown,
  json: boolean,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): number {
  if (err instanceof SealboxError) {
    if (json) {
      stderr(`${JSON.stringify({ ok: false, error: err.message, code: err.code })}\n`);
    } else {
      stderr(`\nError [${err.code}]: ${err.message}\n`);
    }
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) {
      stderr(`${JSON.stringify({ ok: false, error: msg })}\n`);
    } else {
      stderr(`\nUnexpected error: ${msg}\n`);
    }
  }
  return 1;
}

/**
 * Run the Sealbox CLI.
 *
 * @param argv full process argv (`node script ...`).
 * @param overrides partial environment override, used by tests.
 * @returns the process exit code.
 */
export async function runCli(
  argv: string[],
  overrides: Partial<CliEnvironment> = {},
): Promise<number> {
  const environment: CliEnvironment = { ...defaultEnvironment(), ...overrides };
  const { env, stdout, stderr } = environment;

  let exitCode = 0;

  const program = new Command();
  program
    .name('sealbox')
    .description(
      'Seal files to Shelby with an Ed25519-signed, independently verifiable manifest.',
    )
    .version('0.3.0');
  program.exitOverride();

  // ─── seal ────────────────────────────────────────────────────────────────
  program
    .command('seal <path>')
    .description(
      'SHA-256 a file, upload it to Shelby, sign the record, store it in the manifest.',
    )
    .option('--json', 'Output result as JSON')
    .action(async (filePath: string, opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      try {
        const resolved = path.resolve(environment.cwd, filePath);
        if (!fs.existsSync(resolved)) {
          throw new SealboxError(`File not found: ${filePath}`, 'CONFIG');
        }

        const privateKey = env.SIGNER_PRIVATE_KEY;
        if (!privateKey) {
          throw new SealboxError(
            'SIGNER_PRIVATE_KEY is not set in .env. Never commit real keys.',
            'CONFIG',
          );
        }

        const fileBuffer = fs.readFileSync(resolved);
        const sha256 = computeSha256(fileBuffer);
        const sizeBytes = fileBuffer.length;
        const blobName = `sealbox/${sha256}`;
        const network = env.SHELBY_NETWORK ?? 'shelbynet';
        const sealedAt = environment.now().toISOString();

        const signer = createSigner(privateKey);
        let signature: string;
        let signerAddress: string;
        try {
          const payload = createSignedPayload({
            sha256,
            sizeBytes,
            blobName,
            sealedAt,
            network,
            signerPublicKey: signer.signerPublicKey,
          });
          signature = signer.sign(payload);
          signerAddress = signer.signerAddress;
        } finally {
          signer.dispose();
        }

        if (!json) stdout(`Sealing ${filePath} (${sizeBytes} bytes)...\n`);

        // The bucket must resolve to the account that owns the object, so
        // the signer's address is used unless SHELBY_S3_BUCKET overrides it.
        const storage = environment.makeStorage(env, signerAddress);
        await storage.upload(blobName, fileBuffer);

        const entry: ManifestEntry = {
          recordVersion: V2_RECORD_VERSION,
          sealId: sha256.substring(0, 16),
          blobName,
          sha256,
          sizeBytes,
          sealedAt,
          network,
          signatureScheme: ED25519_SIGNATURE_SCHEME,
          signerPublicKey: signer.signerPublicKey,
          signerAddress: signer.signerAddress,
          signature,
          explorerUrl: explorerUrl(network, blobName),
          signedPayloadVersion: SIGNED_PAYLOAD_VERSION,
        };

        const manifest = new Manifest(environment.cwd);
        manifest.addEntry(entry);

        if (json) {
          stdout(`${JSON.stringify({ ok: true, ...entry })}\n`);
        } else {
          stdout('\n✓ Sealed successfully\n');
          stdout(`  Seal ID:      ${entry.sealId}\n`);
          stdout(`  SHA-256:      ${entry.sha256}\n`);
          stdout(`  Signer:       ${entry.signerAddress}\n`);
          stdout(`  Public key:   ${entry.signerPublicKey}\n`);
          stdout(`  Explorer URL: ${entry.explorerUrl}\n`);
        }
      } catch (err) {
        exitCode = handleError(err, json, stdout, stderr);
        return;
      }
      exitCode = 0;
    });

  // ─── verify ──────────────────────────────────────────────────────────────
  program
    .command('verify <sealId>')
    .description(
      'Re-fetch the blob, re-hash it, verify the Ed25519 signature and the signer identity.',
    )
    .option('--json', 'Output result as JSON')
    .action(async (sealId: string, opts: { json?: boolean }) => {
      const json = opts.json ?? false;

      let manifest: Manifest;
      try {
        manifest = new Manifest(environment.cwd);
      } catch (err) {
        if (err instanceof SealboxError) {
          const result: VerificationResult = {
            ok: false,
            status: manifestErrorStatus(err),
            sealId,
            legacyRecord: false,
            integrityVerified: false,
            signatureVerified: false,
            signerVerified: false,
            detail: err.message,
          };
          exitCode = emitVerification(result, json, stdout);
          return;
        }
        exitCode = handleError(err, json, stdout, stderr);
        return;
      }

      let entry: ManifestEntry | undefined;
      try {
        entry = manifest.getEntry(sealId);
      } catch (err) {
        if (err instanceof SealboxError && err.code === 'AMBIGUOUS_SEAL_ID') {
          const result: VerificationResult = {
            ok: false,
            status: 'AMBIGUOUS_SEAL_ID',
            sealId,
            legacyRecord: false,
            integrityVerified: false,
            signatureVerified: false,
            signerVerified: false,
            detail: err.message,
          };
          exitCode = emitVerification(result, json, stdout);
          return;
        }
        exitCode = handleError(err, json, stdout, stderr);
        return;
      }

      if (!entry) {
        const result: VerificationResult = {
          ok: false,
          status: 'NOT_FOUND',
          sealId,
          legacyRecord: false,
          integrityVerified: false,
          signatureVerified: false,
          signerVerified: false,
          detail: `Seal ID "${sealId}" is not in the local manifest.`,
        };
        exitCode = emitVerification(result, json, stdout);
        return;
      }

      if (!json) stdout(`Verifying ${sealId}...\n`);

      try {
        // The bucket must be the same one the object was written to. It
        // resolves from the recorded signer address, so verification never
        // needs the private key.
        const storage = environment.makeStorage(env, entry.signerAddress);
        const result = await verifyEntry({
          entry,
          retrieve: () => storage.download(entry.blobName),
        });
        exitCode = emitVerification(result, json, stdout);
      } catch (err) {
        exitCode = handleError(err, json, stdout, stderr);
      }
    });

  // ─── list ────────────────────────────────────────────────────────────────
  program
    .command('list')
    .description('Print all manifest entries.')
    .option('--json', 'Output as JSON array')
    .action((opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      let manifest: Manifest;
      try {
        manifest = new Manifest(environment.cwd);
      } catch (err) {
        exitCode = handleError(err, json, stdout, stderr);
        return;
      }
      const entries = manifest.getAll();

      if (json) {
        stdout(`${JSON.stringify(entries, null, 2)}\n`);
        exitCode = 0;
        return;
      }

      if (entries.length === 0) {
        stdout('No sealed files found in manifest.\n');
        exitCode = 0;
        return;
      }

      const rows = entries.map((e) => ({
        ID: e.sealId,
        'Blob Name': e.blobName,
        'Size (B)': e.sizeBytes,
        'Sealed At': e.sealedAt.replace('T', ' ').replace(/\..+$/, ''),
        Record:
          (e as { recordVersion?: number }).recordVersion === V2_RECORD_VERSION
            ? 'v2 (verifiable)'
            : `v${LEGACY_RECORD_VERSION} (legacy, signature not verifiable)`,
      }));
      stdout(`${JSON.stringify(rows, null, 2)}\n`);
      exitCode = 0;
    });

  // ─── doctor ──────────────────────────────────────────────────────────────
  program
    .command('doctor')
    .description(
      'Preflight check: local configuration and live network state are reported separately.',
    )
    .option('--json', 'Output checklist as JSON')
    .action(async (opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      const report = await runDoctor(environment);
      if (json) {
        stdout(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        stdout('\nsealbox doctor — preflight checklist\n');
        stdout('─'.repeat(58) + '\n');
        stdout('Local configuration\n');
        for (const c of report.localChecks) {
          stdout(`  ${iconFor(c.state)}  ${c.name.padEnd(28)} ${c.note}\n`);
        }
        stdout('─'.repeat(58) + '\n');
        stdout('Live network\n');
        for (const c of report.liveChecks) {
          stdout(`  ${iconFor(c.state)}  ${c.name.padEnd(28)} ${c.note}\n`);
        }
        stdout('─'.repeat(58) + '\n');
        stdout(
          report.ready
            ? '\nREADY — local configuration is complete and every live check passed.\n'
            : '\nNOT READY — resolve the items marked ✗ or ? above, then re-run sealbox doctor.\n',
        );
      }
      exitCode = report.ready ? 0 : 1;
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'commander.help' || code === 'commander.helpDisplayed' || code === 'commander.version') {
      return 0;
    }
    return handleError(err, false, stdout, stderr);
  }

  return exitCode;
}

// ─── doctor implementation ──────────────────────────────────────────────────

function fullnodeFor(env: NodeJS.ProcessEnv, network: string): string | null {
  const explicit = env.SHELBY_FULLNODE_URL;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return DEFAULT_FULLNODES[network] ?? null;
}

/**
 * Read a coin balance from an Aptos-style fullnode.
 *
 * The `/accounts/{address}/balance/{coinType}` endpoint is used because it
 * accepts a bare coin type and returns the balance directly. The
 * `/resource/{type}` form requires a fully qualified generic struct tag
 * (for example `0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>`); the
 * percent-encoded form of that tag is rejected with HTTP 400 by the node, so
 * using it made the balance check permanently report "could not query".
 *
 * @param decimals display decimals for the coin (APT = 8, ShelbyUSD = 6).
 */
async function readCoinBalance(
  environment: CliEnvironment,
  fullnode: string,
  address: string,
  coinType: string,
  decimals: number,
): Promise<{ state: CheckState; note: string }> {
  const url = `${fullnode}/accounts/${address}/balance/${coinType}`;
  try {
    const { status, body } = await environment.fetchJson(url, 10000);
    if (status === 404) {
      return {
        state: 'fail',
        note: 'Account not found on the fullnode (balance is 0).',
      };
    }
    if (status !== 200) {
      return {
        state: 'unknown',
        note: `Fullnode returned HTTP ${status} — balance could not be established.`,
      };
    }
    // The endpoint returns a bare number; the object form is accepted too so
    // that either shape can be consumed.
    const raw =
      typeof body === 'number'
        ? body
        : (body as { value?: unknown; data?: { coin?: { value?: unknown } } })?.data
            ?.coin?.value ?? (body as { value?: unknown })?.value;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return {
        state: 'unknown',
        note: 'Fullnode response did not contain a numeric coin value.',
      };
    }
    if (value <= 0) {
      return { state: 'fail', note: 'Zero — fund at https://faucet.shelbynet.shelby.xyz' };
    }
    return {
      state: 'pass',
      note: `${(value / 10 ** decimals).toFixed(4)} ${decimals === 8 ? 'APT' : 'ShelbyUSD'}`,
    };
  } catch (err) {
    return {
      state: 'unknown',
      note: `Could not query the fullnode: ${(err as Error).message}`,
    };
  }
}

export async function runDoctor(environment: CliEnvironment): Promise<DoctorReport> {
  const { env } = environment;
  const localChecks: DoctorCheck[] = [];
  const liveChecks: DoctorCheck[] = [];

  // ── local configuration (no network) ────────────────────────────────────
  const endpoint = (env.SHELBY_S3_ENDPOINT ?? '').trim();
  let endpointOk = false;
  let endpointNote = 'Not set — copy .env.example to .env';
  if (endpoint.length > 0) {
    try {
      const url = new URL(endpoint);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        endpointOk = true;
        endpointNote = endpoint;
      } else {
        endpointNote = `Not a valid http(s) URL: ${endpoint}`;
      }
    } catch {
      endpointNote = `Not a valid URL: ${endpoint}`;
    }
  }
  localChecks.push({
    name: 'SHELBY_S3_ENDPOINT',
    state: endpointOk ? 'pass' : 'fail',
    note: endpointNote,
  });

  const apiKey = (env.SHELBY_API_KEY ?? '').trim();
  localChecks.push({
    name: 'SHELBY_API_KEY',
    state: apiKey.length > 0 ? 'pass' : 'fail',
    note:
      apiKey.length > 0
        ? '(set — value hidden)'
        : 'Not set — anonymous mode, rate limits apply. Get a key at https://geomi.dev',
  });

  const signerKey = (env.SIGNER_PRIVATE_KEY ?? '').trim();
  localChecks.push({
    name: 'SIGNER_PRIVATE_KEY',
    state: signerKey.length > 0 ? 'pass' : 'fail',
    note: signerKey.length > 0 ? '(set — value hidden)' : 'Not set — seal command will fail',
  });

  const network = (env.SHELBY_NETWORK ?? '').trim() || 'shelbynet';
  localChecks.push({
    name: 'SHELBY_NETWORK',
    state: 'pass',
    note: `${network}${(env.SHELBY_NETWORK ?? '').trim().length === 0 ? ' (default)' : ''}`,
  });

  // ── live network ────────────────────────────────────────────────────────
  if (endpointOk) {
    try {
      const storage = environment.makeStorage(env);
      await storage.ping();
      liveChecks.push({ name: 'S3 endpoint reachable', state: 'pass', note: endpoint });
    } catch (err) {
      liveChecks.push({
        name: 'S3 endpoint reachable',
        state: 'fail',
        note: `Ping failed: ${(err as Error).message}`,
      });
    }
  } else {
    liveChecks.push({
      name: 'S3 endpoint reachable',
      state: 'skipped',
      note: 'Skipped — endpoint not configured',
    });
  }

  const fullnode = fullnodeFor(env, network);
  if (signerKey.length === 0) {
    liveChecks.push({
      name: 'APT balance > 0',
      state: 'skipped',
      note: 'Skipped — SIGNER_PRIVATE_KEY not set',
    });
    liveChecks.push({
      name: 'ShelbyUSD balance > 0',
      state: 'skipped',
      note: 'Skipped — SIGNER_PRIVATE_KEY not set',
    });
  } else if (fullnode === null) {
    liveChecks.push({
      name: 'APT balance > 0',
      state: 'unknown',
      note: `No fullnode known for network "${network}" — set SHELBY_FULLNODE_URL.`,
    });
    liveChecks.push({
      name: 'ShelbyUSD balance > 0',
      state: 'unknown',
      note: `No fullnode known for network "${network}" — set SHELBY_FULLNODE_URL.`,
    });
  } else {
    let address: string | null = null;
    try {
      const signer = createSigner(signerKey);
      address = signer.signerAddress;
      signer.dispose();
    } catch (err) {
      liveChecks.push({
        name: 'APT balance > 0',
        state: 'unknown',
        note: `Could not derive the signer address: ${(err as Error).message}`,
      });
      liveChecks.push({
        name: 'ShelbyUSD balance > 0',
        state: 'unknown',
        note: 'Skipped — signer address could not be derived',
      });
    }

    if (address !== null) {
      const apt = await readCoinBalance(environment, fullnode, address, APT_COIN_TYPE, 8);
      liveChecks.push({ name: 'APT balance > 0', state: apt.state, note: apt.note });

      const shelby = await readCoinBalance(
        environment,
        fullnode,
        address,
        SHELBYUSD_COIN_TYPE,
        6,
      );
      liveChecks.push({
        name: 'ShelbyUSD balance > 0',
        state: shelby.state,
        note: shelby.note,
      });
    }
  }

  const localPassed = localChecks.filter((c) => c.state === 'pass').length;
  const livePassed = liveChecks.filter((c) => c.state === 'pass').length;
  const ready = localPassed === localChecks.length && livePassed === liveChecks.length;

  return {
    ok: ready,
    ready,
    localChecks,
    liveChecks,
    summary: {
      localPassed,
      localTotal: localChecks.length,
      livePassed,
      liveTotal: liveChecks.length,
    },
  };
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliEnvironment, runCli } from './cli';
import { computeSha256 } from './crypto';
import { SealboxError } from './errors';
import { Manifest, isV2Entry } from './manifest';
import { ShelbyStorage } from './storage';
import { TEST_PRIVATE_KEY_A } from './__fixtures__/keys';

const tmpDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealbox-cli-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface CliHarness {
  dir: string;
  stdout: string[];
  stderr: string[];
  env: NodeJS.ProcessEnv;
  objects: Map<string, Buffer>;
  run: (args: string[]) => Promise<number>;
  out: () => string;
  err: () => string;
}

function harness(overrides: Partial<NodeJS.ProcessEnv> = {}): CliHarness {
  const dir = makeDir();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const objects = new Map<string, Buffer>();
  const env: NodeJS.ProcessEnv = {
    SHELBY_S3_ENDPOINT: 'https://mock-endpoint.example',
    SHELBY_API_KEY: 'test-api-key',
    SHELBY_NETWORK: 'shelbynet',
    SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY_A,
    ...overrides,
  };

  const storage = {
    upload: jest.fn(async (name: string, data: Buffer) => {
      objects.set(name, Buffer.from(data));
    }),
    download: jest.fn(async (name: string) => {
      const data = objects.get(name);
      if (!data) {
        throw new SealboxError(`Blob not found on Shelby: ${name}`, 'NOT_FOUND');
      }
      return data;
    }),
    ping: jest.fn(async () => undefined),
  } as unknown as ShelbyStorage;

  const environment: Partial<CliEnvironment> = {
    env,
    cwd: dir,
    now: () => new Date('2026-10-21T12:00:00.000Z'),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    makeStorage: () => storage,
    fetchJson: async () => ({ status: 404, body: null }),
  };

  return {
    dir,
    stdout,
    stderr,
    env,
    objects,
    run: (args: string[]) => {
      // Each invocation starts with a clean output buffer so that assertions
      // can parse the last command's output directly.
      stdout.length = 0;
      stderr.length = 0;
      return runCli(['node', 'sealbox', ...args], environment);
    },
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  };
}

describe('sealbox CLI — seal', () => {
  test('seal records a signed v2 manifest entry', async () => {
    const cli = harness();
    const file = path.join(cli.dir, 'artifact.txt');
    fs.writeFileSync(file, 'hello sealbox');

    const code = await cli.run(['seal', file]);
    expect(code).toBe(0);

    const manifest = new Manifest(cli.dir);
    const entries = manifest.getAll();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(isV2Entry(entry)).toBe(true);
    if (!isV2Entry(entry)) throw new Error('expected a v2 record');
    expect(entry.recordVersion).toBe(2);
    expect(entry.signerPublicKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(entry.signerAddress).toMatch(/^0x[0-9a-f]{64}$/);
    expect(entry.signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(entry.network).toBe('shelbynet');
    expect(entry.signedPayloadVersion).toBe('2');
    expect(entry.signatureScheme).toBe('ed25519');
  });

  test('seal never prints the private key', async () => {
    const cli = harness();
    const file = path.join(cli.dir, 'artifact.txt');
    fs.writeFileSync(file, 'hello sealbox');

    await cli.run(['seal', file]);
    expect(cli.out()).not.toContain(TEST_PRIVATE_KEY_A);
    expect(cli.out()).not.toContain(TEST_PRIVATE_KEY_A.slice(2));
    expect(cli.err()).not.toContain(TEST_PRIVATE_KEY_A);
  });

  test('seal --json emits the record without the private key', async () => {
    const cli = harness();
    const file = path.join(cli.dir, 'artifact.txt');
    fs.writeFileSync(file, 'hello sealbox');

    const code = await cli.run(['seal', file, '--json']);
    expect(code).toBe(0);

    const payload = JSON.parse(cli.out());
    expect(payload.ok).toBe(true);
    expect(payload.signerPublicKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(cli.out()).not.toContain(TEST_PRIVATE_KEY_A);
    expect(cli.out()).not.toContain(TEST_PRIVATE_KEY_A.slice(2));
  });

  test('seal without a signer key fails with a configuration error', async () => {
    const cli = harness({ SIGNER_PRIVATE_KEY: '' });
    const file = path.join(cli.dir, 'artifact.txt');
    fs.writeFileSync(file, 'hello sealbox');

    const code = await cli.run(['seal', file, '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(cli.err()).code).toBe('CONFIG');
  });

  test('seal of a missing file fails', async () => {
    const cli = harness();
    const code = await cli.run(['seal', path.join(cli.dir, 'nope.txt'), '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(cli.err()).code).toBe('CONFIG');
  });
});

describe('sealbox CLI — verify', () => {
  test('verify reports PASS for a record that was just sealed', async () => {
    const cli = harness();
    const file = path.join(cli.dir, 'artifact.txt');
    fs.writeFileSync(file, 'hello sealbox');
    await cli.run(['seal', file]);

    const sealId = new Manifest(cli.dir).getAll()[0]!.sealId;
    const code = await cli.run(['verify', sealId, '--json']);
    expect(code).toBe(0);

    const result = JSON.parse(cli.out());
    expect(result.ok).toBe(true);
    expect(result.status).toBe('PASS');
    expect(result.integrityVerified).toBe(true);
    expect(result.signatureVerified).toBe(true);
    expect(result.signerVerified).toBe(true);
    expect(result.legacyRecord).toBe(false);
  });

  test('verify --json never yields signatureVerified=true for a forged signature', async () => {
    const cli = harness();
    const file = path.join(cli.dir, 'artifact.txt');
    fs.writeFileSync(file, 'hello sealbox');
    await cli.run(['seal', file]);

    // Forge the manifest: a plausible signature that no signer produced.
    const manifestPath = path.join(cli.dir, 'manifest.json');
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    raw.entries[0].signature = `0x${'de'.repeat(64)}`;
    fs.writeFileSync(manifestPath, JSON.stringify(raw, null, 2));

    const sealId = raw.entries[0].sealId;
    const code = await cli.run(['verify', sealId, '--json']);
    expect(code).toBe(1);

    const result = JSON.parse(cli.out());
    expect(result.ok).toBe(false);
    expect(result.status).toBe('INVALID_SIGNATURE');
    expect(result.signatureVerified).toBe(false);
  });

  test('verify reports TAMPERED when the stored bytes change', async () => {
    const cli = harness();
    const file = path.join(cli.dir, 'artifact.txt');
    fs.writeFileSync(file, 'hello sealbox');
    await cli.run(['seal', file]);

    const sealId = new Manifest(cli.dir).getAll()[0]!.sealId;
    for (const [name, data] of cli.objects) {
      cli.objects.set(name, Buffer.from(`${data.toString('utf-8')}!`));
    }

    const code = await cli.run(['verify', sealId, '--json']);
    expect(code).toBe(1);
    const result = JSON.parse(cli.out());
    expect(result.status).toBe('TAMPERED');
    expect(result.integrityVerified).toBe(false);
  });

  test('verify reports NOT_FOUND for an unknown seal ID', async () => {
    const cli = harness();
    const code = await cli.run(['verify', 'deadbeefdeadbeef', '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(cli.out()).status).toBe('NOT_FOUND');
  });

  test('verify reports NOT_FOUND when the object is gone from storage', async () => {
    const cli = harness();
    const file = path.join(cli.dir, 'artifact.txt');
    fs.writeFileSync(file, 'hello sealbox');
    await cli.run(['seal', file]);
    const sealId = new Manifest(cli.dir).getAll()[0]!.sealId;
    cli.objects.clear();

    const code = await cli.run(['verify', sealId, '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(cli.out()).status).toBe('NOT_FOUND');
  });

  test('verify fails loudly on a corrupt manifest instead of reporting NOT_FOUND', async () => {
    const cli = harness();
    const file = path.join(cli.dir, 'artifact.txt');
    fs.writeFileSync(file, 'hello sealbox');
    await cli.run(['seal', file]);

    const manifestPath = path.join(cli.dir, 'manifest.json');
    fs.writeFileSync(manifestPath, '{ corrupt');

    const code = await cli.run(['verify', 'anything', '--json']);
    expect(code).toBe(1);
    const result = JSON.parse(cli.out());
    expect(result.status).toBe('INVALID_MANIFEST');
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe('{ corrupt');
  });

  test('verify reports a legacy record as not signature-verified', async () => {
    const cli = harness();
    const sha256 = computeSha256(Buffer.from('hello'));
    fs.writeFileSync(
      path.join(cli.dir, 'manifest.json'),
      JSON.stringify([
        {
          sealId: sha256.substring(0, 16),
          blobName: `sealbox/${sha256}`,
          sha256,
          sizeBytes: 5,
          sealedAt: '2026-06-21T10:00:00.000Z',
          signerAddress: '0xlegacy',
          signature: 'legacy-signature',
          explorerUrl: 'https://explorer.shelby.xyz/shelbynet/blob/x',
        },
      ]),
    );
    cli.objects.set(`sealbox/${sha256}`, Buffer.from('hello'));

    const code = await cli.run(['verify', sha256.substring(0, 16), '--json']);
    expect(code).toBe(1);
    const result = JSON.parse(cli.out());
    expect(result.status).toBe('LEGACY_UNVERIFIABLE_SIGNATURE');
    expect(result.legacyRecord).toBe(true);
    expect(result.signatureVerified).toBe(false);
  });

  test('the human-readable output states that a legacy record is not verified', async () => {
    const cli = harness();
    const sha256 = computeSha256(Buffer.from('hello'));
    fs.writeFileSync(
      path.join(cli.dir, 'manifest.json'),
      JSON.stringify([
        {
          sealId: sha256.substring(0, 16),
          blobName: `sealbox/${sha256}`,
          sha256,
          sizeBytes: 5,
          sealedAt: '2026-06-21T10:00:00.000Z',
          signerAddress: '0xlegacy',
          signature: 'legacy-signature',
          explorerUrl: 'https://explorer.shelby.xyz/shelbynet/blob/x',
        },
      ]),
    );
    cli.objects.set(`sealbox/${sha256}`, Buffer.from('hello'));

    await cli.run(['verify', sha256.substring(0, 16)]);
    expect(cli.out()).toContain('LEGACY');
    expect(cli.out()).toContain('NOT verified');
  });
});

describe('sealbox CLI — list', () => {
  test('list --json returns the manifest entries', async () => {
    const cli = harness();
    const file = path.join(cli.dir, 'artifact.txt');
    fs.writeFileSync(file, 'hello sealbox');
    await cli.run(['seal', file]);

    const code = await cli.run(['list', '--json']);
    expect(code).toBe(0);
    const entries = JSON.parse(cli.out());
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].signerPublicKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('list on an empty manifest reports that there is nothing to show', async () => {
    const cli = harness();
    const code = await cli.run(['list']);
    expect(code).toBe(0);
    expect(cli.out()).toContain('No sealed files');
  });

  test('list fails loudly on a corrupt manifest', async () => {
    const cli = harness();
    fs.writeFileSync(path.join(cli.dir, 'manifest.json'), '{ corrupt');
    const code = await cli.run(['list', '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(cli.err()).code).toBe('MANIFEST_CORRUPT');
  });
});

describe('sealbox CLI — doctor', () => {
  test('doctor reports not-ready when the local configuration is incomplete', async () => {
    const cli = harness({ SIGNER_PRIVATE_KEY: '', SHELBY_API_KEY: '' });
    const code = await cli.run(['doctor', '--json']);
    expect(code).toBe(1);

    const report = JSON.parse(cli.out());
    expect(report.ready).toBe(false);
    expect(report.localChecks.length).toBeGreaterThan(0);
    expect(report.liveChecks.length).toBeGreaterThan(0);
  });

  test('doctor keeps local configuration and live network checks separate', async () => {
    const cli = harness();
    const report = JSON.parse((await runDoctorJson(cli)));
    expect(Array.isArray(report.localChecks)).toBe(true);
    expect(Array.isArray(report.liveChecks)).toBe(true);
    const localNames = report.localChecks.map((c: { name: string }) => c.name);
    const liveNames = report.liveChecks.map((c: { name: string }) => c.name);
    expect(localNames).toContain('SIGNER_PRIVATE_KEY');
    expect(liveNames).toContain('S3 endpoint reachable');
    expect(localNames).not.toContain('S3 endpoint reachable');
  });

  test('doctor never prints the private key', async () => {
    const cli = harness();
    await cli.run(['doctor', '--json']);
    expect(cli.out()).not.toContain(TEST_PRIVATE_KEY_A);
    expect(cli.out()).not.toContain(TEST_PRIVATE_KEY_A.slice(2));
    expect(cli.out()).toContain('(set — value hidden)');
  });

  test('doctor reports a live balance it could not determine as unknown, not as zero', async () => {
    const cli = harness();
    const environment: Partial<CliEnvironment> = {
      env: cli.env,
      cwd: cli.dir,
      stdout: (text) => cli.stdout.push(text),
      stderr: (text) => cli.stderr.push(text),
      makeStorage: () => ({ ping: async () => undefined } as unknown as ShelbyStorage),
      fetchJson: async () => {
        throw new Error('network unreachable');
      },
    };
    const code = await runCli(['node', 'sealbox', 'doctor', '--json'], environment);
    expect(code).toBe(1);
    const report = JSON.parse(cli.stdout.join(''));
    const apt = report.liveChecks.find((c: { name: string }) => c.name === 'APT balance > 0');
    expect(apt.state).toBe('unknown');
    expect(report.ready).toBe(false);
  });

  test('doctor reports a confirmed zero balance as a failure, not as unknown', async () => {
    const cli = harness();
    const environment: Partial<CliEnvironment> = {
      env: cli.env,
      cwd: cli.dir,
      stdout: (text) => cli.stdout.push(text),
      stderr: (text) => cli.stderr.push(text),
      makeStorage: () => ({ ping: async () => undefined } as unknown as ShelbyStorage),
      fetchJson: async () => ({ status: 200, body: { data: { coin: { value: '0' } } } }),
    };
    const code = await runCli(['node', 'sealbox', 'doctor', '--json'], environment);
    expect(code).toBe(1);
    const report = JSON.parse(cli.stdout.join(''));
    const apt = report.liveChecks.find((c: { name: string }) => c.name === 'APT balance > 0');
    expect(apt.state).toBe('fail');
  });
});

async function runDoctorJson(cli: CliHarness): Promise<string> {
  await cli.run(['doctor', '--json']);
  return cli.out();
}

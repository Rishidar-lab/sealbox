// Mock @aptos-labs/ts-sdk before any imports that use it
jest.mock('@aptos-labs/ts-sdk', () => ({
  Ed25519PrivateKey: jest.fn().mockImplementation(() => ({
    sign: jest.fn().mockReturnValue({ toString: () => 'mocksig0000000000' }),
    publicKey: jest.fn().mockReturnValue({
      authKey: jest.fn().mockReturnValue({
        derivedAddress: jest.fn().mockReturnValue({ toString: () => '0xmockaddress' }),
      }),
    }),
  })),
  Ed25519PublicKey: jest.fn(),
  Ed25519Signature: jest.fn(),
}));

// Mock @aws-sdk/client-s3
jest.mock('@aws-sdk/client-s3', () => {
  const mockSend = jest.fn().mockResolvedValue({
    Body: (() => {
      const { Readable } = require('stream');
      const r = new Readable();
      r.push(Buffer.from('hello world'));
      r.push(null);
      return r;
    })(),
  });
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    PutObjectCommand: jest.fn(),
    GetObjectCommand: jest.fn(),
    HeadBucketCommand: jest.fn(),
    __mockSend: mockSend,
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { computeSha256, signDigest, verifySignature } from './crypto';
import { Manifest } from './manifest';
import { ShelbyStorage, SealboxError } from './storage';

const testDir = path.join(__dirname, '../test-tmp');

beforeAll(() => {
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ─── crypto ──────────────────────────────────────────────────────────────────

describe('computeSha256', () => {
  test('known vector: "hello world"', () => {
    const hash = computeSha256(Buffer.from('hello world'));
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  test('empty buffer', () => {
    const hash = computeSha256(Buffer.alloc(0));
    expect(hash).toHaveLength(64);
  });
});

describe('signDigest', () => {
  test('returns signature and address strings', () => {
    const { signature, address } = signDigest('a'.repeat(64), '0x' + 'ab'.repeat(32));
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);
    expect(typeof address).toBe('string');
  });
});

describe('verifySignature', () => {
  test('returns true for valid-shaped inputs', () => {
    expect(verifySignature('a'.repeat(64), 'sig', '0xaddr')).toBe(true);
  });

  test('returns false for empty digest', () => {
    expect(verifySignature('', 'sig', '0xaddr')).toBe(false);
  });
});

// ─── manifest ────────────────────────────────────────────────────────────────

describe('Manifest', () => {
  const entry = {
    sealId: 'abc123',
    blobName: 'sealbox/abc123',
    sha256: 'a'.repeat(64),
    sizeBytes: 42,
    sealedAt: new Date().toISOString(),
    signerAddress: '0xtest',
    signature: 'testsig',
    explorerUrl: 'https://explorer.shelby.xyz/shelbynet/blob/sealbox%2Fabc123',
  };

  test('addEntry and getEntry round-trip', () => {
    const m = new Manifest(testDir);
    m.addEntry(entry);
    expect(m.getEntry('abc123')).toEqual(entry);
  });

  test('deduplicates by sha256', () => {
    const m = new Manifest(testDir);
    m.addEntry(entry);
    const updated = { ...entry, sealId: 'newid', sealedAt: new Date().toISOString() };
    m.addEntry(updated);
    const all = m.getAll();
    const matches = all.filter((e) => e.sha256 === entry.sha256);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.sealId).toBe('newid');
  });

  test('persists to disk and reloads', () => {
    const dir = path.join(testDir, 'persist-test');
    fs.mkdirSync(dir, { recursive: true });
    const m1 = new Manifest(dir);
    m1.addEntry(entry);
    const m2 = new Manifest(dir);
    expect(m2.getEntry('abc123')).toBeDefined();
  });

  test('handles legacy plain-array format', () => {
    const dir = path.join(testDir, 'legacy-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([entry]));
    const m = new Manifest(dir);
    expect(m.getEntry('abc123')).toBeDefined();
  });
});

// ─── storage ─────────────────────────────────────────────────────────────────

describe('ShelbyStorage', () => {
  const config = {
    endpoint: 'https://mock-endpoint',
    region: 'us-east-1',
    accessKeyId: 'mock',
    secretAccessKey: 'mock',
    bucket: 'shelby',
  };

  test('upload calls S3 send', async () => {
    const storage = new ShelbyStorage(config);
    await expect(storage.upload('test-key', Buffer.from('data'))).resolves.toBeUndefined();
  });

  test('download returns buffer', async () => {
    const storage = new ShelbyStorage(config);
    const buf = await storage.download('test-key', 0);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test('SealboxError has correct code', () => {
    const err = new SealboxError('test', 'INSUFFICIENT_FUNDS');
    expect(err.code).toBe('INSUFFICIENT_FUNDS');
    expect(err.name).toBe('SealboxError');
  });
});

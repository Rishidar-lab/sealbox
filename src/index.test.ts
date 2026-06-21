jest.mock('@aptos-labs/ts-sdk', () => ({
  Ed25519PrivateKey: jest.fn().mockImplementation(() => ({
    sign: jest.fn().mockReturnValue({ toHex: () => 'mock_sig' }),
    publicKey: jest.fn().mockReturnValue({}),
  })),
  AccountAddress: {
    fromPublicKey: jest.fn().mockReturnValue({ toString: () => 'mock_address' }),
  },
}));

import { computeSha256 } from './crypto';
import { Manifest } from './manifest';
import * as fs from 'fs';
import * as path from 'path';

describe('sealbox core', () => {
  const testDir = path.join(__dirname, '../test-data');
  
  beforeAll(() => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir);
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('computeSha256 should return correct hash', () => {
    const data = Buffer.from('hello world');
    const hash = computeSha256(data);
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  test('Manifest should add and retrieve entries', () => {
    const manifest = new Manifest(testDir);
    const entry = {
      sealId: 'test-id',
      blobName: 'test-blob',
      sha256: 'test-hash',
      sizeBytes: 100,
      sealedAt: new Date().toISOString(),
      signerAddress: 'test-address',
      signature: 'test-sig',
      explorerUrl: 'test-url',
    };
    
    manifest.addEntry(entry);
    const retrieved = manifest.getEntry('test-id');
    expect(retrieved).toEqual(entry);
  });
});

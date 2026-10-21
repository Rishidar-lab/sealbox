import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MANIFEST_SCHEMA_VERSION,
  LegacyManifestEntry,
  Manifest,
  ManifestEntry,
  ManifestEntryV2,
  V2_RECORD_VERSION,
  classifyManifestEntry,
  findEntry,
} from './manifest';
import { SealboxError } from './errors';
import {
  TEST_ADDRESS_A,
  TEST_PUBLIC_KEY_A,
} from './__fixtures__/keys';

const tmpDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealbox-manifest-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function v2Entry(overrides: Partial<ManifestEntryV2> = {}): ManifestEntryV2 {
  const sha256 = 'b'.repeat(64);
  return {
    recordVersion: V2_RECORD_VERSION,
    sealId: sha256.substring(0, 16),
    blobName: `sealbox/${sha256}`,
    sha256,
    sizeBytes: 11,
    sealedAt: '2026-10-21T12:00:00.000Z',
    network: 'shelbynet',
    signatureScheme: 'ed25519',
    signerPublicKey: TEST_PUBLIC_KEY_A,
    signerAddress: TEST_ADDRESS_A,
    signature: `0x${'cd'.repeat(64)}`,
    explorerUrl: `https://explorer.shelby.xyz/shelbynet/blob/sealbox%2F${sha256}`,
    signedPayloadVersion: '2',
    ...overrides,
  };
}

function legacyEntry(overrides: Partial<LegacyManifestEntry> = {}): LegacyManifestEntry {
  const sha256 = 'a'.repeat(64);
  return {
    sealId: sha256.substring(0, 16),
    blobName: `sealbox/${sha256}`,
    sha256,
    sizeBytes: 11,
    sealedAt: '2026-06-21T10:00:00.000Z',
    signerAddress: TEST_ADDRESS_A,
    signature: 'legacy-signature-value',
    explorerUrl: `https://explorer.shelby.xyz/shelbynet/blob/sealbox%2F${sha256}`,
    ...overrides,
  };
}

describe('Manifest — schema v2', () => {
  test('addEntry / getEntry round trip', () => {
    const dir = makeDir();
    const manifest = new Manifest(dir);
    const entry = v2Entry();
    manifest.addEntry(entry);

    const loaded = new Manifest(dir);
    expect(loaded.getEntry(entry.sealId)).toEqual(entry);
    expect(loaded.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
  });

  test('the manifest file is written as valid JSON with a v2 schema version', () => {
    const dir = makeDir();
    new Manifest(dir).addEntry(v2Entry());
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    expect(raw.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(Array.isArray(raw.entries)).toBe(true);
    expect(raw.entries[0].recordVersion).toBe(V2_RECORD_VERSION);
  });

  test('writes are atomic: no temporary files are left behind', () => {
    const dir = makeDir();
    new Manifest(dir).addEntry(v2Entry());
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(['manifest.json']);
  });

  test('re-sealing the same content updates the record instead of duplicating it', () => {
    const dir = makeDir();
    const manifest = new Manifest(dir);
    const entry = v2Entry();
    manifest.addEntry(entry);
    manifest.addEntry({ ...entry, sealId: 'different', sealedAt: '2026-10-22T00:00:00.000Z' });

    const all = new Manifest(dir).getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.sealedAt).toBe('2026-10-22T00:00:00.000Z');
  });

  test('different content produces separate records', () => {
    const dir = makeDir();
    const manifest = new Manifest(dir);
    manifest.addEntry(v2Entry());
    manifest.addEntry(v2Entry({ sha256: 'c'.repeat(64), sealId: 'c'.repeat(16) }));
    expect(new Manifest(dir).getAll()).toHaveLength(2);
  });

  test('records written by another process are not clobbered', () => {
    const dir = makeDir();
    new Manifest(dir).addEntry(v2Entry({ sha256: 'd'.repeat(64), sealId: 'd'.repeat(16) }));

    // A second process writes between our load and our save.
    const other = new Manifest(dir);
    other.addEntry(v2Entry({ sha256: 'e'.repeat(64), sealId: 'e'.repeat(16) }));

    const mine = new Manifest(dir);
    mine.addEntry(v2Entry({ sha256: 'f'.repeat(64), sealId: 'f'.repeat(16) }));

    const all = new Manifest(dir).getAll();
    expect(all.map((e) => e.sha256).sort()).toEqual([
      'd'.repeat(64),
      'e'.repeat(64),
      'f'.repeat(64),
    ]);
  });
});

describe('Manifest — durability and corruption', () => {
  test('a manifest with invalid JSON fails loudly instead of becoming empty', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not valid json');
    expect(() => new Manifest(dir)).toThrow(SealboxError);
    try {
      new Manifest(dir);
    } catch (err) {
      expect((err as SealboxError).code).toBe('MANIFEST_CORRUPT');
    }
  });

  test('a corrupt manifest is never overwritten by a later seal', () => {
    const dir = makeDir();
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, '{ not valid json');
    expect(() => new Manifest(dir).addEntry(v2Entry())).toThrow();
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ not valid json');
  });

  test('a manifest with an unsupported schema version fails loudly', () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 99, entries: [] }),
    );
    try {
      new Manifest(dir);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as SealboxError).code).toBe('UNSUPPORTED_SCHEMA');
    }
  });

  test('a manifest without a valid entries array fails loudly', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 2 }));
    try {
      new Manifest(dir);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as SealboxError).code).toBe('MANIFEST_CORRUPT');
    }
  });

  test('a record with v2 fields but no recordVersion is rejected, not downgraded', () => {
    const dir = makeDir();
    const { recordVersion: _recordVersion, ...withoutVersion } = v2Entry();
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 2, entries: [withoutVersion] }),
    );
    try {
      new Manifest(dir);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as SealboxError).code).toBe('INVALID_RECORD');
    }
  });

  test('a record that declares version 1 but carries v2 fields is rejected', () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 2, entries: [{ ...v2Entry(), recordVersion: 1 }] }),
    );
    try {
      new Manifest(dir);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as SealboxError).code).toBe('INVALID_RECORD');
    }
  });

  test('a record with an unknown record version is rejected', () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 2, entries: [{ ...v2Entry(), recordVersion: 7 }] }),
    );
    try {
      new Manifest(dir);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as SealboxError).code).toBe('UNSUPPORTED_SCHEMA');
    }
  });
});

describe('Manifest — legacy (schema v1) handling', () => {
  test('a legacy plain-array manifest is parsed', () => {
    const dir = makeDir();
    const entry = legacyEntry();
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([entry]));
    const manifest = new Manifest(dir);
    expect(manifest.getEntry(entry.sealId)).toEqual(entry);
    expect(manifest.schemaVersion).toBe(1);
  });

  test('a legacy v1 manifest object is parsed', () => {
    const dir = makeDir();
    const entry = legacyEntry();
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, entries: [entry] }),
    );
    expect(new Manifest(dir).getEntry(entry.sealId)).toBeDefined();
  });

  test('a legacy record is never silently promoted to a verifiable record', () => {
    const dir = makeDir();
    const legacy = legacyEntry();
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, entries: [legacy] }),
    );

    const manifest = new Manifest(dir);
    const entry = manifest.getEntry(legacy.sealId)!;
    expect(classifyManifestEntry(entry)).toBe('legacy');
    expect((entry as ManifestEntryV2).signerPublicKey).toBeUndefined();
    expect((entry as ManifestEntryV2).recordVersion).toBeUndefined();
  });

  test('adding a v2 record to a legacy manifest keeps the legacy record legacy', () => {
    const dir = makeDir();
    const legacy = legacyEntry();
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, entries: [legacy] }),
    );

    const manifest = new Manifest(dir);
    manifest.addEntry(v2Entry());

    const reloaded = new Manifest(dir);
    const legacyReloaded = reloaded.getEntry(legacy.sealId)!;
    expect(classifyManifestEntry(legacyReloaded)).toBe('legacy');
    expect((legacyReloaded as ManifestEntryV2).signerPublicKey).toBeUndefined();
    expect(reloaded.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(reloaded.getAll()).toHaveLength(2);
  });
});

describe('Manifest — seal ID collision handling', () => {
  // Two distinct 64-character digests that share their first 16 characters.
  const COLLIDING_A = `${'a'.repeat(62)}11`;
  const COLLIDING_B = `${'a'.repeat(62)}22`;

  test('two digests sharing a 16-character prefix are both preserved', () => {
    const dir = makeDir();
    const manifest = new Manifest(dir);
    const first = v2Entry({ sha256: COLLIDING_A, sealId: 'a'.repeat(16) });
    const second = v2Entry({ sha256: COLLIDING_B, sealId: 'a'.repeat(16) });
    manifest.addEntry(first);
    manifest.addEntry(second);

    const all = new Manifest(dir).getAll();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.sha256).sort()).toEqual([COLLIDING_A, COLLIDING_B]);
  });

  test('the colliding record gets a longer, still-unique seal ID', () => {
    const dir = makeDir();
    const manifest = new Manifest(dir);
    manifest.addEntry(v2Entry({ sha256: COLLIDING_A, sealId: 'a'.repeat(16) }));
    manifest.addEntry(v2Entry({ sha256: COLLIDING_B, sealId: 'a'.repeat(16) }));

    const all = new Manifest(dir).getAll();
    const ids = all.map((e) => e.sealId);
    expect(new Set(ids).size).toBe(2);
    // Every seal ID remains a prefix of the authoritative digest.
    for (const entry of all) {
      expect(entry.sha256.startsWith(entry.sealId)).toBe(true);
    }
  });

  test('an ambiguous hand-written manifest is reported, not silently resolved', () => {
    const dir = makeDir();
    const first = v2Entry({ sha256: COLLIDING_A, sealId: 'a'.repeat(16) });
    const second = v2Entry({ sha256: COLLIDING_B, sealId: 'a'.repeat(16) });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 2, entries: [first, second] }),
    );

    const manifest = new Manifest(dir);
    expect(() => manifest.getEntry('a'.repeat(16))).toThrow(SealboxError);
    try {
      manifest.getEntry('a'.repeat(16));
    } catch (err) {
      expect((err as SealboxError).code).toBe('AMBIGUOUS_SEAL_ID');
    }
  });

  test('a record can always be looked up by its full SHA-256 digest', () => {
    const dir = makeDir();
    const first = v2Entry({ sha256: COLLIDING_A, sealId: 'a'.repeat(16) });
    const second = v2Entry({ sha256: COLLIDING_B, sealId: 'a'.repeat(16) });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 2, entries: [first, second] }),
    );

    const manifest = new Manifest(dir);
    expect(manifest.getEntry(COLLIDING_B)!.sha256).toBe(COLLIDING_B);
  });
});

describe('findEntry / classifyManifestEntry', () => {
  const entries: ManifestEntry[] = [
    v2Entry({ sha256: '1'.repeat(64), sealId: '1'.repeat(16) }),
    legacyEntry(),
  ];

  test('finds by seal ID', () => {
    const lookup = findEntry(entries, '1'.repeat(16));
    expect(lookup.kind).toBe('found');
  });

  test('finds by full digest', () => {
    const lookup = findEntry(entries, 'a'.repeat(64));
    expect(lookup.kind).toBe('found');
  });

  test('reports not found for an unknown ID', () => {
    expect(findEntry(entries, 'nope').kind).toBe('not_found');
  });

  test('classifies records', () => {
    expect(classifyManifestEntry(v2Entry())).toBe('v2');
    expect(classifyManifestEntry(legacyEntry())).toBe('legacy');
    expect(classifyManifestEntry({ ...v2Entry(), recordVersion: 1 })).toBe('invalid');
    expect(classifyManifestEntry({ ...v2Entry(), recordVersion: 3 })).toBe('unsupported');
    expect(classifyManifestEntry(null)).toBe('invalid');
    expect(classifyManifestEntry('nope')).toBe('invalid');
  });
});

import * as fs from 'fs';
import * as path from 'path';
import { SealboxError } from './errors';

/**
 * Sealbox local manifest.
 *
 * ## Schema versions
 *
 * | file `schemaVersion` | meaning                                            |
 * |---------------------|----------------------------------------------------|
 * | 1                   | legacy manifest (pre-v0.3.0), records have no `recordVersion` |
 * | 2                   | current manifest                                     |
 *
 * | record `recordVersion` | meaning                                                     |
 * |-----------------------|-------------------------------------------------------------|
 * | absent                | legacy (v1) record — the signature cannot be verified         |
 * | 1                     | explicitly legacy (v1) record — same limitation, stated out loud |
 * | 2                     | current record: carries public key, network and payload version |
 *
 * A legacy record is never silently promoted to a verifiable record. Legacy
 * records are stored verbatim: adding `recordVersion: 2` to them would
 * assert cryptographic properties they do not have.
 *
 * ## Durability
 *
 * Writes are atomic: the new content is written to a temporary file in the
 * same directory, flushed with `fsync`, and then `rename()`d over the target.
 * `rename(2)` within a directory is atomic on POSIX, so a reader either sees
 * the complete old file or the complete new file — never a partial write.
 */

export const MANIFEST_FILE_NAME = 'manifest.json';

/** Schema version written by this release. */
export const MANIFEST_SCHEMA_VERSION = 2;

/** Schema version of manifests written before v0.3.0. */
export const LEGACY_MANIFEST_SCHEMA_VERSION = 1;

/** `recordVersion` marker of a legacy (v1) record. */
export const LEGACY_RECORD_VERSION = 1;

/** `recordVersion` marker of a current (v2) record. */
export const V2_RECORD_VERSION = 2;

/** Number of hex characters of the SHA-256 digest used for the seal ID. */
export const SEAL_ID_LENGTH = 16;

/** Fields that only exist on v2 records. */
export const V2_ONLY_FIELDS = [
  'network',
  'signatureScheme',
  'signerPublicKey',
  'signedPayloadVersion',
] as const;

export interface ManifestEntryBase {
  /** Short, human-facing handle. Always a prefix of `sha256`. */
  sealId: string;
  /** Storage object name the artifact was written to. */
  blobName: string;
  /** Lowercase hex SHA-256 of the artifact bytes. */
  sha256: string;
  /** Byte length of the artifact. */
  sizeBytes: number;
  /** ISO-8601 timestamp string chosen by the signer. */
  sealedAt: string;
  /** Aptos authentication-key address of the signer. */
  signerAddress: string;
  /** Ed25519 signature over the canonical signed payload. */
  signature: string;
  /** Block explorer URL, derivable from `network` + `blobName`. */
  explorerUrl: string;
}

/**
 * A record written before v0.3.0. It contains no public key, so the stored
 * signature cannot be verified cryptographically.
 */
export interface LegacyManifestEntry extends ManifestEntryBase {
  recordVersion?: 1;
}

/** A current (v2) record: self-contained enough for independent verification. */
export interface ManifestEntryV2 extends ManifestEntryBase {
  recordVersion: 2;
  /** Storage network the blob was written to. */
  network: string;
  /** Signature scheme used. Only `ed25519` is supported. */
  signatureScheme: string;
  /** `0x`-prefixed Ed25519 public key of the signer. */
  signerPublicKey: string;
  /** Version of the canonical signed payload. */
  signedPayloadVersion: string;
}

export type ManifestEntry = LegacyManifestEntry | ManifestEntryV2;

export interface ManifestFile {
  schemaVersion: number;
  entries: ManifestEntry[];
}

/** Classification of a single manifest record. */
export type EntryKind = 'v2' | 'legacy' | 'invalid' | 'unsupported';

/**
 * Classify a raw manifest record.
 *
 * `invalid` means the record is internally contradictory (for example it
 * carries v2-only fields without a `recordVersion` marker, or it declares
 * `recordVersion: 1` while also carrying v2-only fields). Such a record must
 * not be silently treated as legacy.
 */
export function classifyManifestEntry(entry: unknown): EntryKind {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return 'invalid';
  }
  const record = entry as Record<string, unknown>;
  const version = record.recordVersion;

  if (version !== undefined && version !== LEGACY_RECORD_VERSION && version !== V2_RECORD_VERSION) {
    return 'unsupported';
  }

  const hasV2Fields = V2_ONLY_FIELDS.some((field) => record[field] !== undefined);

  if (version === V2_RECORD_VERSION) {
    return V2_ONLY_FIELDS.every((field) => record[field] !== undefined) ? 'v2' : 'invalid';
  }
  if (version === LEGACY_RECORD_VERSION) {
    return hasV2Fields ? 'invalid' : 'legacy';
  }
  // No version marker: legacy records never had one, so the record is legacy
  // only when it does not carry any v2-only field.
  return hasV2Fields ? 'invalid' : 'legacy';
}

/** True when the record is a current, independently verifiable v2 record. */
export function isV2Entry(entry: ManifestEntry): entry is ManifestEntryV2 {
  return (entry as ManifestEntryV2).recordVersion === V2_RECORD_VERSION;
}

/** True when the record is a legacy (v1) record. */
export function isLegacyEntry(entry: ManifestEntry): entry is LegacyManifestEntry {
  return !isV2Entry(entry);
}

/** Outcome of resolving a caller-supplied seal ID against the manifest. */
export type EntryLookup =
  | { kind: 'found'; entry: ManifestEntry }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; candidates: ManifestEntry[] };

/**
 * Resolve a seal ID (or a full SHA-256 digest) to exactly one record.
 *
 * Lookup never guesses: if more than one record matches the same short seal
 * ID, the result is `ambiguous` instead of an arbitrary pick.
 */
export function findEntry(entries: ManifestEntry[], id: string): EntryLookup {
  const bySealId = entries.filter((entry) => entry.sealId === id);
  if (bySealId.length === 1) return { kind: 'found', entry: bySealId[0] };
  if (bySealId.length > 1) return { kind: 'ambiguous', candidates: bySealId };

  // Fall back to the authoritative content identifier.
  if (/^[0-9a-f]{64}$/.test(id)) {
    const byDigest = entries.filter((entry) => entry.sha256 === id);
    if (byDigest.length === 1) return { kind: 'found', entry: byDigest[0] };
    if (byDigest.length > 1) return { kind: 'ambiguous', candidates: byDigest };
  }

  return { kind: 'not_found' };
}

export class Manifest {
  private readonly filePath: string;
  private data: ManifestFile = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    entries: [],
  };

  constructor(workingDir: string = process.cwd()) {
    this.filePath = path.join(workingDir, MANIFEST_FILE_NAME);
    this.load();
  }

  /** Absolute path of the manifest file backing this instance. */
  get path(): string {
    return this.filePath;
  }

  /**
   * Read and validate the manifest file.
   *
   * @throws SealboxError with code `MANIFEST_CORRUPT` when the file exists but
   *   cannot be parsed, and `UNSUPPORTED_SCHEMA` when it declares a schema
   *   version this build does not understand. A corrupt manifest is never
   *   silently downgraded to an empty manifest — doing so would hide data
   *   loss and would make a corrupted manifest look like a fresh database.
   */
  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.data = { schemaVersion: MANIFEST_SCHEMA_VERSION, entries: [] };
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      throw new SealboxError(
        `Cannot read manifest at ${this.filePath}: ${(err as Error).message}. ` +
          'The file was left untouched — move or restore it before retrying.',
        'MANIFEST_CORRUPT',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SealboxError(
        `Manifest at ${this.filePath} is not valid JSON: ${(err as Error).message}. ` +
          'The file was left untouched — move or restore it before retrying.',
        'MANIFEST_CORRUPT',
      );
    }

    let schemaVersion: number;
    let rawEntries: unknown[];

    if (Array.isArray(parsed)) {
      // Legacy plain-array format written by sealbox v0.1.0.
      schemaVersion = LEGACY_MANIFEST_SCHEMA_VERSION;
      rawEntries = parsed;
    } else if (typeof parsed === 'object' && parsed !== null) {
      const file = parsed as Record<string, unknown>;
      const declared = file.schemaVersion;
      if (typeof declared !== 'number' || !Number.isInteger(declared)) {
        throw new SealboxError(
          `Manifest at ${this.filePath} has no valid schemaVersion.`,
          'MANIFEST_CORRUPT',
        );
      }
      if (declared !== LEGACY_MANIFEST_SCHEMA_VERSION && declared !== MANIFEST_SCHEMA_VERSION) {
        throw new SealboxError(
          `Manifest at ${this.filePath} uses unsupported schema version ${declared}. ` +
            `This build understands ${LEGACY_MANIFEST_SCHEMA_VERSION} and ${MANIFEST_SCHEMA_VERSION}.`,
          'UNSUPPORTED_SCHEMA',
        );
      }
      schemaVersion = declared;
      if (!Array.isArray(file.entries)) {
        throw new SealboxError(
          `Manifest at ${this.filePath} has no valid entries array.`,
          'MANIFEST_CORRUPT',
        );
      }
      rawEntries = file.entries;
    } else {
      throw new SealboxError(
        `Manifest at ${this.filePath} is neither an object nor an array.`,
        'MANIFEST_CORRUPT',
      );
    }

    const entries: ManifestEntry[] = rawEntries.map((rawEntry, index) => {
      const kind = classifyManifestEntry(rawEntry);
      if (kind === 'unsupported') {
        const version = (rawEntry as Record<string, unknown>).recordVersion;
        throw new SealboxError(
          `Manifest record #${index} in ${this.filePath} declares unsupported record version ${String(version)}.`,
          'UNSUPPORTED_SCHEMA',
        );
      }
      if (kind === 'invalid') {
        throw new SealboxError(
          `Manifest record #${index} in ${this.filePath} is structurally invalid.`,
          'INVALID_RECORD',
        );
      }
      return rawEntry as ManifestEntry;
    });

    this.data = { schemaVersion, entries };
  }

  /**
   * Atomic write: write to a temporary file in the same directory, fsync it,
   * then rename it over the target.
   *
   * `rename(2)` within a directory is atomic on POSIX, so concurrent readers
   * observe either the complete previous file or the complete new file.
   */
  private write(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    const tmp = path.join(dir, `.${MANIFEST_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;

    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, payload, { encoding: 'utf-8' });
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* best effort cleanup */
      }
      throw err;
    }

    // Flush the directory entry so the rename survives a crash.
    try {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      /* not supported on every platform/filesystem */
    }
  }

  /**
   * Add or replace a record and persist it.
   *
   * Deduplication is by SHA-256 — the authoritative content identifier — so
   * re-sealing the same bytes updates the existing record instead of adding
   * a second one. A record is never overwritten merely because its shortened
   * seal ID matches another record.
   */
  addEntry(entry: ManifestEntry): void {
    // Re-read from disk so a concurrent write by another process is not
    // clobbered. The remaining race window is between this read and the
    // rename below; sealbox is a single-user local tool.
    this.load();

    const existing = this.data.entries.findIndex((e) => e.sha256 === entry.sha256);
    if (existing !== -1) {
      this.data.entries[existing] = entry;
    } else {
      this.data.entries.push(entry);
    }

    // Guarantee seal-ID uniqueness inside this manifest. If two different
    // digests share the same short prefix, the incoming record gets a longer
    // prefix so that no seal ID ever resolves to two records.
    this.assignUniqueSealIds();

    this.data.schemaVersion = MANIFEST_SCHEMA_VERSION;
    this.write();
  }

  /**
   * Re-assign colliding seal IDs to the shortest unambiguous prefix of the
   * authoritative SHA-256 digest.
   */
  private assignUniqueSealIds(): void {
    const bySealId = new Map<string, ManifestEntry[]>();
    for (const entry of this.data.entries) {
      const bucket = bySealId.get(entry.sealId);
      if (bucket) bucket.push(entry);
      else bySealId.set(entry.sealId, [entry]);
    }

    for (const [sealId, colliding] of bySealId) {
      if (colliding.length < 2) continue;
      for (const entry of colliding) {
        if (entry.sealId !== sealId) continue;
        const digest = entry.sha256;
        for (let length = SEAL_ID_LENGTH + 1; length <= digest.length; length += 1) {
          const candidate = digest.slice(0, length);
          const stillCollides = this.data.entries.some(
            (other) => other !== entry && other.sealId === candidate,
          );
          if (!stillCollides) {
            entry.sealId = candidate;
            break;
          }
        }
      }
    }
  }

  /**
   * Look up a record by seal ID or full SHA-256 digest.
   *
   * @throws SealboxError with code `AMBIGUOUS_SEAL_ID` when more than one
   *   record matches — silently selecting one would be a correctness bug.
   */
  getEntry(sealId: string): ManifestEntry | undefined {
    const lookup = findEntry(this.data.entries, sealId);
    if (lookup.kind === 'ambiguous') {
      throw new SealboxError(
        `Seal ID "${sealId}" matches ${lookup.candidates.length} manifest records. ` +
          'Look the artifact up by its full SHA-256 digest instead.',
        'AMBIGUOUS_SEAL_ID',
      );
    }
    return lookup.kind === 'found' ? lookup.entry : undefined;
  }

  /** All records currently in the manifest. */
  getAll(): ManifestEntry[] {
    return this.data.entries;
  }

  /** Schema version of the loaded manifest file. */
  get schemaVersion(): number {
    return this.data.schemaVersion;
  }
}

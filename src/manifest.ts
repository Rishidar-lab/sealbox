import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const SCHEMA_VERSION = 1;

export interface ManifestEntry {
  sealId: string;
  blobName: string;
  sha256: string;
  sizeBytes: number;
  sealedAt: string;
  signerAddress: string;
  signature: string;
  explorerUrl: string;
}

interface ManifestFile {
  schemaVersion: number;
  entries: ManifestEntry[];
}

export class Manifest {
  private filePath: string;
  private data: ManifestFile = { schemaVersion: SCHEMA_VERSION, entries: [] };

  constructor(workingDir: string = process.cwd()) {
    this.filePath = path.join(workingDir, 'manifest.json');
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      // Support legacy format (plain array)
      if (Array.isArray(parsed)) {
        this.data = { schemaVersion: SCHEMA_VERSION, entries: parsed as ManifestEntry[] };
      } else {
        this.data = parsed as ManifestFile;
      }
    } catch {
      this.data = { schemaVersion: SCHEMA_VERSION, entries: [] };
    }
  }

  /** Atomic write: write to a temp file then rename. */
  save() {
    const dir = path.dirname(this.filePath);
    const tmp = path.join(dir, `.manifest-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  addEntry(entry: ManifestEntry) {
    // Dedupe by sha256 — update existing record if same content re-sealed
    const existing = this.data.entries.findIndex((e) => e.sha256 === entry.sha256);
    if (existing !== -1) {
      this.data.entries[existing] = entry;
    } else {
      this.data.entries.push(entry);
    }
    this.save();
  }

  getEntry(sealId: string): ManifestEntry | undefined {
    return this.data.entries.find((e) => e.sealId === sealId);
  }

  getAll(): ManifestEntry[] {
    return this.data.entries;
  }
}

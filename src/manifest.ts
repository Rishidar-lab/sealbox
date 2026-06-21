import * as fs from 'fs';
import * as path from 'path';

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

export class Manifest {
  private filePath: string;
  private entries: ManifestEntry[] = [];

  constructor(workingDir: string = process.cwd()) {
    this.filePath = path.join(workingDir, 'manifest.json');
    this.load();
  }

  private load() {
    if (fs.existsSync(this.filePath)) {
      try {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        this.entries = JSON.parse(data);
      } catch (e) {
        this.entries = [];
      }
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }

  addEntry(entry: ManifestEntry) {
    this.entries.push(entry);
    this.save();
  }

  getEntry(sealId: string): ManifestEntry | undefined {
    return this.entries.find((e) => e.sealId === sealId);
  }

  getAll(): ManifestEntry[] {
    return this.entries;
  }
}

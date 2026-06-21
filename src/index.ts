#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { computeSha256, signDigest } from './crypto';
import { ShelbyStorage } from './storage';
import { Manifest, ManifestEntry } from './manifest';

dotenv.config();

const program = new Command();

program
  .name('sealbox')
  .description('CLI to seal files to Shelby')
  .version('0.1.0');

program
  .command('seal <path>')
  .description('Seal a file to Shelby')
  .action(async (filePath) => {
    try {
      if (!fs.existsSync(filePath)) {
        console.error(`Error: File not found at ${filePath}`);
        process.exit(1);
      }

      const fileBuffer = fs.readFileSync(filePath);
      const sha256 = computeSha256(fileBuffer);
      const sizeBytes = fileBuffer.length;
      const blobName = `sealbox/${sha256}`;
      const sealId = sha256.substring(0, 12);

      const privateKey = process.env.SIGNER_PRIVATE_KEY;
      if (!privateKey) {
        console.error('Error: SIGNER_PRIVATE_KEY not found in .env');
        process.exit(1);
      }

      const { signature, address } = signDigest(sha256, privateKey);
      
      const storage = new ShelbyStorage({
        endpoint: process.env.SHELBY_S3_ENDPOINT || '',
        region: 'us-east-1',
        accessKeyId: process.env.SHELBY_API_KEY || 'mock',
        secretAccessKey: 'mock',
        bucket: 'shelby',
      });

      console.log(`Sealing ${filePath}...`);
      await storage.upload(blobName, fileBuffer);

      const network = process.env.SHELBY_NETWORK || 'shelbynet';
      const explorerUrl = `https://explorer.shelby.xyz/${network}/blob/${blobName}`;

      const entry: ManifestEntry = {
        sealId,
        blobName,
        sha256,
        sizeBytes,
        sealedAt: new Date().toISOString(),
        signerAddress: address,
        signature,
        explorerUrl,
      };

      const manifest = new Manifest();
      manifest.addEntry(entry);

      console.log(`Successfully sealed!`);
      console.log(`Seal ID: ${sealId}`);
      console.log(`Explorer URL: ${explorerUrl}`);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('verify <sealId>')
  .description('Verify a sealed file')
  .action(async (sealId) => {
    try {
      const manifest = new Manifest();
      const entry = manifest.getEntry(sealId);

      if (!entry) {
        console.error(`Error: Seal ID ${sealId} not found in manifest`);
        process.exit(1);
      }

      const storage = new ShelbyStorage({
        endpoint: process.env.SHELBY_S3_ENDPOINT || '',
        region: 'us-east-1',
        accessKeyId: process.env.SHELBY_API_KEY || 'mock',
        secretAccessKey: 'mock',
        bucket: 'shelby',
      });

      console.log(`Verifying Seal ID: ${sealId}...`);
      const downloadedBuffer = await storage.download(entry.blobName);
      const currentSha256 = computeSha256(downloadedBuffer);

      if (currentSha256 !== entry.sha256) {
        console.log(`FAIL: SHA-256 mismatch!`);
        console.log(`Expected: ${entry.sha256}`);
        console.log(`Actual:   ${currentSha256}`);
        process.exit(1);
      }

      console.log(`PASS: File is byte-identical.`);
      console.log(`Signer: ${entry.signerAddress}`);
      console.log(`Sealed At: ${entry.sealedAt}`);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all manifest entries')
  .action(() => {
    const manifest = new Manifest();
    const entries = manifest.getAll();
    if (entries.length === 0) {
      console.log('No entries found.');
      return;
    }
    console.table(entries.map(e => ({
      ID: e.sealId,
      Name: e.blobName,
      Size: e.sizeBytes,
      Date: e.sealedAt.split('T')[0]
    })));
  });

program.parse(process.argv);

#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs';
import * as https from 'https';
import * as dotenv from 'dotenv';
import { computeSha256, signDigest, verifySignature } from './crypto';
import { ShelbyStorage, SealboxError } from './storage';
import { Manifest, ManifestEntry } from './manifest';

dotenv.config();

const program = new Command();

program
  .name('sealbox')
  .description('Seal files to Shelby as immutable blobs with cryptographic proof.')
  .version('0.2.0');

// ─── helpers ────────────────────────────────────────────────────────────────

function makeStorage(): ShelbyStorage {
  const endpoint = process.env.SHELBY_S3_ENDPOINT;
  if (!endpoint) {
    throw new SealboxError(
      'SHELBY_S3_ENDPOINT is not set. Copy .env.example to .env and fill in the values.',
      'CONFIG',
    );
  }
  return new ShelbyStorage({
    endpoint,
    region: 'us-east-1',
    accessKeyId: process.env.SHELBY_API_KEY ?? 'anonymous',
    secretAccessKey: process.env.SHELBY_API_KEY ?? 'anonymous',
    bucket: 'shelby',
  });
}

function explorerUrl(network: string, blobName: string): string {
  return `https://explorer.shelby.xyz/${network}/blob/${encodeURIComponent(blobName)}`;
}

function handleError(err: unknown, json: boolean): never {
  if (err instanceof SealboxError) {
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: err.message, code: err.code }) + '\n');
    } else {
      process.stderr.write(`\nError [${err.code}]: ${err.message}\n`);
    }
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    } else {
      process.stderr.write(`\nUnexpected error: ${msg}\n`);
    }
  }
  process.exit(1);
}

// ─── seal ───────────────────────────────────────────────────────────────────

program
  .command('seal <path>')
  .description('SHA-256 a file, upload to Shelby, sign the digest, record in manifest.')
  .option('--json', 'Output result as JSON')
  .action(async (filePath, opts) => {
    const json: boolean = opts.json ?? false;
    try {
      if (!fs.existsSync(filePath)) {
        throw new SealboxError(`File not found: ${filePath}`, 'CONFIG');
      }

      const privateKey = process.env.SIGNER_PRIVATE_KEY;
      if (!privateKey) {
        throw new SealboxError(
          'SIGNER_PRIVATE_KEY is not set in .env. Never commit real keys.',
          'CONFIG',
        );
      }

      const fileBuffer = fs.readFileSync(filePath);
      const sha256 = computeSha256(fileBuffer);
      const sizeBytes = fileBuffer.length;
      const blobName = `sealbox/${sha256}`;
      const sealId = sha256.substring(0, 16);
      const network = process.env.SHELBY_NETWORK ?? 'shelbynet';

      if (!json) process.stdout.write(`Sealing ${filePath} (${sizeBytes} bytes)...\n`);

      const { signature, address } = signDigest(sha256, privateKey);
      const storage = makeStorage();
      await storage.upload(blobName, fileBuffer);

      const url = explorerUrl(network, blobName);
      const entry: ManifestEntry = {
        sealId,
        blobName,
        sha256,
        sizeBytes,
        sealedAt: new Date().toISOString(),
        signerAddress: address,
        signature,
        explorerUrl: url,
      };

      const manifest = new Manifest();
      manifest.addEntry(entry);

      if (json) {
        process.stdout.write(JSON.stringify({ ok: true, ...entry }) + '\n');
      } else {
        process.stdout.write(`\n✓ Sealed successfully\n`);
        process.stdout.write(`  Seal ID:      ${sealId}\n`);
        process.stdout.write(`  SHA-256:      ${sha256}\n`);
        process.stdout.write(`  Signer:       ${address}\n`);
        process.stdout.write(`  Explorer URL: ${url}\n`);
      }
    } catch (err) {
      handleError(err, json);
    }
  });

// ─── verify ─────────────────────────────────────────────────────────────────

program
  .command('verify <sealId>')
  .description('Re-fetch blob, recompute SHA-256, verify signature — prints PASS / TAMPERED / NOT-FOUND.')
  .option('--json', 'Output result as JSON')
  .action(async (sealId, opts) => {
    const json: boolean = opts.json ?? false;
    try {
      const manifest = new Manifest();
      const entry = manifest.getEntry(sealId);

      if (!entry) {
        if (json) {
          process.stdout.write(
            JSON.stringify({ ok: false, status: 'NOT_FOUND', sealId }) + '\n',
          );
        } else {
          process.stdout.write(`NOT-FOUND: Seal ID "${sealId}" is not in the local manifest.\n`);
        }
        process.exit(1);
      }

      if (!json) process.stdout.write(`Verifying ${sealId}...\n`);

      const storage = makeStorage();
      let downloadedBuffer: Buffer;
      try {
        downloadedBuffer = await storage.download(entry.blobName);
      } catch (err) {
        if (err instanceof SealboxError && err.code === 'NOT_FOUND') {
          if (json) {
            process.stdout.write(
              JSON.stringify({ ok: false, status: 'NOT_FOUND', sealId, blobName: entry.blobName }) + '\n',
            );
          } else {
            process.stdout.write(
              `NOT-FOUND: Blob "${entry.blobName}" was not found on Shelby (may have expired).\n`,
            );
          }
          process.exit(1);
        }
        throw err;
      }

      const currentSha256 = computeSha256(downloadedBuffer);
      const hashMatch = currentSha256 === entry.sha256;
      const sigOk = verifySignature(entry.sha256, entry.signature, entry.signerAddress);

      if (!hashMatch) {
        if (json) {
          process.stdout.write(
            JSON.stringify({
              ok: false,
              status: 'TAMPERED',
              sealId,
              expected: entry.sha256,
              actual: currentSha256,
            }) + '\n',
          );
        } else {
          process.stdout.write(
            `TAMPERED: SHA-256 mismatch!\n  Expected: ${entry.sha256}\n  Actual:   ${currentSha256}\n`,
          );
        }
        process.exit(1);
      }

      const result = {
        ok: true,
        status: 'PASS',
        sealId,
        sha256: entry.sha256,
        sealedAt: entry.sealedAt,
        signerAddress: entry.signerAddress,
        signatureValid: sigOk,
        explorerUrl: entry.explorerUrl,
      };

      if (json) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stdout.write(
          `\nPASS ✓\n` +
            `  SHA-256:   ${entry.sha256}\n` +
            `  Sealed at: ${entry.sealedAt}\n` +
            `  Signer:    ${entry.signerAddress}\n` +
            `  Sig check: ${sigOk ? 'ok' : 'structural only'}\n` +
            `  Explorer:  ${entry.explorerUrl}\n`,
        );
      }
    } catch (err) {
      handleError(err, json);
    }
  });

// ─── list ────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('Print all manifest entries.')
  .option('--json', 'Output as JSON array')
  .action((opts) => {
    const json: boolean = opts.json ?? false;
    const manifest = new Manifest();
    const entries = manifest.getAll();

    if (json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
      return;
    }

    if (entries.length === 0) {
      process.stdout.write('No sealed files found in manifest.\n');
      return;
    }

    console.table(
      entries.map((e) => ({
        ID: e.sealId,
        'Blob Name': e.blobName,
        'Size (B)': e.sizeBytes,
        'Sealed At': e.sealedAt.replace('T', ' ').replace(/\..+$/, ''),
      })),
    );
  });

// ─── doctor ──────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Preflight check: validates .env, pings S3 endpoint, checks account funding.')
  .option('--json', 'Output checklist as JSON')
  .action(async (opts) => {
    const json: boolean = opts.json ?? false;

    const checks: { name: string; pass: boolean; note: string }[] = [];

    function check(name: string, pass: boolean, note: string) {
      checks.push({ name, pass, note });
    }

    // 1. SHELBY_S3_ENDPOINT
    const endpoint = process.env.SHELBY_S3_ENDPOINT ?? '';
    check(
      'SHELBY_S3_ENDPOINT',
      endpoint.length > 0,
      endpoint.length > 0 ? endpoint : 'Not set — copy .env.example to .env',
    );

    // 2. SHELBY_API_KEY
    const apiKey = process.env.SHELBY_API_KEY ?? '';
    check(
      'SHELBY_API_KEY',
      apiKey.length > 0,
      apiKey.length > 0 ? '(set — value hidden)' : 'Not set — anonymous mode, rate limits apply. Get key at https://geomi.dev',
    );

    // 3. SIGNER_PRIVATE_KEY
    const signerKey = process.env.SIGNER_PRIVATE_KEY ?? '';
    check(
      'SIGNER_PRIVATE_KEY',
      signerKey.length > 0,
      signerKey.length > 0 ? '(set — value hidden)' : 'Not set — seal command will fail',
    );

    // 4. SHELBY_NETWORK
    const network = process.env.SHELBY_NETWORK ?? '';
    check(
      'SHELBY_NETWORK',
      network.length > 0,
      network.length > 0 ? network : 'Not set — defaults to shelbynet',
    );

    // 5. S3 endpoint reachability
    if (endpoint.length > 0) {
      try {
        const storage = makeStorage();
        await storage.ping();
        check('S3 endpoint reachable', true, endpoint);
      } catch (err: any) {
        check(
          'S3 endpoint reachable',
          false,
          `Ping failed: ${err?.message ?? String(err)}`,
        );
      }
    } else {
      check('S3 endpoint reachable', false, 'Skipped — endpoint not configured');
    }

    // 6. Account funded (APT + ShelbyUSD) via Aptos fullnode
    const fullnode = 'https://api.shelbynet.shelby.xyz/v1';
    let fundedApt = false;
    let fundedShelby = false;
    if (signerKey.length > 0) {
      try {
        // Derive address from private key
        const { Ed25519PrivateKey } = await import('@aptos-labs/ts-sdk');
        const pk = new Ed25519PrivateKey(signerKey);
        const address = pk.publicKey().authKey().derivedAddress().toString();

        const aptRes = await fetchJson(
          `${fullnode}/accounts/${address}/resource/0x1::coin::CoinStore%3C0x1::aptos_coin::AptosCoin%3E`,
        );
        const aptBalance = Number(aptRes?.data?.coin?.value ?? 0);
        fundedApt = aptBalance > 0;
        check(
          'APT balance > 0',
          fundedApt,
          fundedApt
            ? `${(aptBalance / 1e8).toFixed(4)} APT`
            : 'Zero — fund at https://faucet.shelbynet.shelby.xyz',
        );

        const shelbyRes = await fetchJson(
          `${fullnode}/accounts/${address}/resource/0x1::coin::CoinStore%3C0x1b18363a9f1fe5e6ebf247daba5cc1c18052bb232efdc4c50f556053922d98e1%3A%3Ashelby_usd%3A%3AShelbyUSD%3E`,
        );
        const shelbyBalance = Number(shelbyRes?.data?.coin?.value ?? 0);
        fundedShelby = shelbyBalance > 0;
        check(
          'ShelbyUSD balance > 0',
          fundedShelby,
          fundedShelby
            ? `${(shelbyBalance / 1e6).toFixed(4)} ShelbyUSD`
            : 'Zero — fund at https://faucet.shelbynet.shelby.xyz',
        );
      } catch (err: any) {
        check('APT balance > 0', false, `Could not query: ${err?.message ?? String(err)}`);
        check('ShelbyUSD balance > 0', false, 'Skipped — query failed');
      }
    } else {
      check('APT balance > 0', false, 'Skipped — SIGNER_PRIVATE_KEY not set');
      check('ShelbyUSD balance > 0', false, 'Skipped — SIGNER_PRIVATE_KEY not set');
    }

    const allPass = checks.every((c) => c.pass);

    if (json) {
      process.stdout.write(JSON.stringify({ ready: allPass, checks }, null, 2) + '\n');
    } else {
      process.stdout.write('\nsealbox doctor — preflight checklist\n');
      process.stdout.write('─'.repeat(50) + '\n');
      for (const c of checks) {
        const icon = c.pass ? '✓' : '✗';
        process.stdout.write(`  ${icon}  ${c.name.padEnd(28)} ${c.note}\n`);
      }
      process.stdout.write('─'.repeat(50) + '\n');
      process.stdout.write(
        allPass
          ? '\nREADY — all checks passed. You can run sealbox seal.\n'
          : '\nNOT READY — fix the items marked ✗ above, then re-run sealbox doctor.\n',
      );
    }

    process.exit(allPass ? 0 : 1);
  });

// ─── util ────────────────────────────────────────────────────────────────────

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d.toString()));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', reject);
  });
}

program.parse(process.argv);

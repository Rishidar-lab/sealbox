import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Typed errors surfaced to the user with actionable guidance. */
export class SealboxError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'INSUFFICIENT_FUNDS'
      | 'RATE_LIMITED'
      | 'NOT_FOUND'
      | 'TAMPERED'
      | 'NETWORK'
      | 'CONFIG',
  ) {
    super(message);
    this.name = 'SealboxError';
  }
}

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'NetworkingError',
  'RequestTimeout',
  'ServiceUnavailable',
  'ThrottlingException',
  'SlowDown',
]);

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 300,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const code: string = err?.Code ?? err?.code ?? err?.name ?? '';
      const status: number = err?.$metadata?.httpStatusCode ?? 0;

      // Insufficient ShelbyUSD (HTTP 402 or message match)
      if (
        status === 402 ||
        /insufficient.*shelby|shelby.*token/i.test(err?.message ?? '')
      ) {
        throw new SealboxError(
          'Insufficient ShelbyUSD balance.\n' +
            '  Fund your account at: https://faucet.shelbynet.shelby.xyz\n' +
            '  Then retry: sealbox seal <path>',
          'INSUFFICIENT_FUNDS',
        );
      }

      // Rate-limit — distinguish anonymous vs authenticated
      if (
        status === 429 ||
        /rate.?limit|too.?many.?request/i.test(err?.message ?? '')
      ) {
        if (!process.env.SHELBY_API_KEY) {
          throw new SealboxError(
            'Rate-limited in anonymous mode.\n' +
              '  Set SHELBY_API_KEY in .env to avoid limits.\n' +
              '  Get a key at: https://geomi.dev',
            'RATE_LIMITED',
          );
        }
        throw new SealboxError(
          'Rate-limited even with API key. Wait a moment and retry.',
          'RATE_LIMITED',
        );
      }

      const isRetryable =
        RETRYABLE_CODES.has(code) ||
        status === 500 ||
        status === 503 ||
        status === 504;

      if (!isRetryable || attempt === maxAttempts - 1) break;

      const delay = baseDelayMs * 2 ** attempt + Math.random() * 100;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export class ShelbyStorage {
  private client: S3Client;
  private bucket: string;

  constructor(config: StorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
    this.bucket = config.bucket;
  }

  async upload(name: string, data: Buffer): Promise<void> {
    await withRetry(() =>
      this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: name, Body: data }),
      ),
    );
  }

  async download(name: string, propagationRetries = 3): Promise<Buffer> {
    for (let attempt = 0; attempt <= propagationRetries; attempt++) {
      try {
        const response = await withRetry(() =>
          this.client.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: name }),
          ),
        );
        const stream = response.Body as Readable;
        return await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => resolve(Buffer.concat(chunks)));
        });
      } catch (err: any) {
        const status: number = err?.$metadata?.httpStatusCode ?? 0;
        const isNotFound = status === 404 || err?.name === 'NoSuchKey';
        if (isNotFound && attempt < propagationRetries) {
          // Brief wait for blob propagation before retry
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        if (isNotFound) {
          throw new SealboxError(
            `Blob not found on Shelby: ${name}`,
            'NOT_FOUND',
          );
        }
        throw err;
      }
    }
    throw new SealboxError(
      `Blob not found after propagation retries: ${name}`,
      'NOT_FOUND',
    );
  }

  /** Ping the S3 endpoint — used by sealbox doctor. */
  async ping(): Promise<void> {
    await withRetry(
      () => this.client.send(new HeadBucketCommand({ Bucket: this.bucket })),
      2,
      200,
    );
  }
}

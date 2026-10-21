import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { SealboxError } from './errors';

export { SealboxError } from './errors';
export type { SealboxErrorCode } from './errors';

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * Per-request timeout in milliseconds. `0` disables the timeout.
   * The AWS SDK has no default request timeout, so without this a hung
   * connection would block a `seal` or `verify` indefinitely.
   */
  requestTimeoutMs?: number;
}

/**
 * Validate the storage endpoint before it reaches the S3 client.
 *
 * The endpoint comes from configuration, so an obvious mistake (a missing
 * scheme, a non-HTTP scheme, a URL with credentials in it) should be reported
 * as a configuration problem instead of an opaque network error.
 */
export function assertValidEndpoint(endpoint: string): string {
  const trimmed = (endpoint ?? '').trim();
  if (trimmed.length === 0) {
    throw new SealboxError(
      'SHELBY_S3_ENDPOINT is not set. Copy .env.example to .env and fill in the values.',
      'CONFIG',
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SealboxError(
      `SHELBY_S3_ENDPOINT is not a valid URL: ${trimmed}`,
      'CONFIG',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SealboxError(
      `SHELBY_S3_ENDPOINT must use http:// or https:// (got ${url.protocol}//).`,
      'CONFIG',
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new SealboxError(
      'SHELBY_S3_ENDPOINT must not embed credentials in the URL.',
      'CONFIG',
    );
  }
  return trimmed.replace(/\/+$/, '');
}

/** Default per-request timeout for storage operations. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const RETRYABLE_CODES = new Set([
  'AbortError',
  'TimeoutError',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'NetworkingError',
  'RequestTimeout',
  'ServiceUnavailable',
  'ThrottlingException',
  'SlowDown',
]);

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

/**
 * Detect an "insufficient funds" failure.
 *
 * Deliberately narrow: a loose pattern risks reporting a configuration or
 * permission problem as a balance problem, which would send users to the
 * faucet for the wrong reason.
 */
function matchesInsufficientFunds(message: string): boolean {
  const text = message.toLowerCase();
  if (/insufficient\s+(funds|balance|credit)/.test(text)) return true;
  if (/insufficient[^\n]{0,40}shelby/.test(text)) return true;
  if (/\bshelbyusd\b[^\n]{0,40}insufficient/.test(text)) return true;
  return false;
}

function matchesRateLimit(message: string): boolean {
  const text = message.toLowerCase();
  return /rate.?limit/.test(text) || /too.?many.?request/.test(text);
}

function httpStatus(err: unknown): number {
  const meta = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata;
  return typeof meta?.httpStatusCode === 'number' ? meta.httpStatusCode : 0;
}

function errorCode(err: unknown): string {
  const e = err as { Code?: string; code?: string; name?: string };
  return e?.Code ?? e?.code ?? e?.name ?? '';
}

function errorMessage(err: unknown): string {
  const e = err as { message?: string };
  return typeof e?.message === 'string' ? e.message : String(err);
}

/**
 * Run `fn` with a bounded number of attempts and exponential backoff.
 *
 * Only transient failures are retried. Permanent failures (authentication,
 * authorization, insufficient funds, rate limiting) are surfaced immediately
 * so that they are never mistaken for a transient hiccup.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 300,
): Promise<T> {
  const attempts = Math.max(1, maxAttempts);
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const code = errorCode(err);
      const status = httpStatus(err);
      const message = errorMessage(err);

      // Insufficient ShelbyUSD (HTTP 402 or an explicit server message).
      if (status === 402 || matchesInsufficientFunds(message)) {
        throw new SealboxError(
          'Insufficient ShelbyUSD balance.\n' +
            '  Fund your account at: https://faucet.shelbynet.shelby.xyz\n' +
            '  Then retry: sealbox seal <path>',
          'INSUFFICIENT_FUNDS',
        );
      }

      // Rate limiting is not retried automatically: the correct back-off is
      // operator-controlled (use an API key, or wait).
      if (status === 429 || matchesRateLimit(message)) {
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

      // Authentication / authorization problems are permanent.
      if (status === 401) {
        throw new SealboxError(
          'Storage endpoint rejected the supplied credentials (HTTP 401). ' +
            'The Shelby S3 gateway uses its own accessKeyId/secretAccessKey ' +
            'for SigV4 signing; set SHELBY_S3_ACCESS_KEY_ID and ' +
            'SHELBY_S3_SECRET_ACCESS_KEY.',
          'AUTHENTICATION',
        );
      }
      if (status === 403) {
        throw new SealboxError(
          'Storage endpoint denied the request (HTTP 403). The bucket must ' +
            'resolve to the signing account address; set SHELBY_S3_BUCKET.',
          'AUTHORIZATION',
        );
      }

      const isRetryable =
        RETRYABLE_CODES.has(code) || RETRYABLE_STATUSES.has(status);

      if (!isRetryable || attempt === attempts - 1) break;

      const delay = baseDelayMs * 2 ** attempt + Math.random() * 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
}

/**
 * The storage configuration actually in force, with the signing secret
 * deliberately excluded. Exposed for diagnostics and for tests that pin the
 * documented Shelby S3 gateway contract.
 */
export interface ResolvedStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  requestTimeoutMs: number;
}

export class ShelbyStorage {
  private client: S3Client;
  private bucket: string;
  private requestTimeoutMs: number;

  /** The configuration actually in force (never includes the secret). */
  readonly resolved: ResolvedStorageConfig;

  constructor(config: StorageConfig) {
    const endpoint = assertValidEndpoint(config.endpoint);
    // `forcePathStyle` makes the SDK address objects as
    // `{endpoint}/{bucket}/{key}`. The endpoint's own path is kept as a
    // prefix, so an endpoint such as `https://host/shelby` with the bucket
    // `shelby` addresses objects at `https://host/shelby/shelby/{key}`.
    // This matches the configuration sealbox has always used; if your
    // deployment exposes the S3 service at a different root, set
    // `SHELBY_S3_ENDPOINT` to that root.
    this.client = new S3Client({
      endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
      // Shelby's gateway does not support object versioning, ACLs or
      // server-side encryption; asking for them is pointless.
      maxAttempts: 1,
    });
    this.bucket = config.bucket;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.resolved = {
      endpoint,
      region: config.region,
      bucket: this.bucket,
      requestTimeoutMs: this.requestTimeoutMs,
    };
  }

  /**
   * Send one command with a bounded timeout.
   *
   * The AWS SDK v3 has no default request timeout, so a hung connection
   * would otherwise block forever. `send()` accepts an `abortSignal`, which
   * is the SDK's supported cancellation mechanism.
   */
  private async withTimeout<T>(
    fn: (abortSignal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    if (this.requestTimeoutMs <= 0) {
      return fn(undefined);
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Abort the request so the socket is released, and fail the call
        // even if the transport ignores the abort signal.
        controller.abort();
        const err = new Error(
          `Storage request timed out after ${this.requestTimeoutMs} ms.`,
        );
        err.name = 'TimeoutError';
        reject(err);
      }, this.requestTimeoutMs);
    });
    // The request may win the race; make sure a later timeout rejection is
    // not reported as an unhandled rejection.
    timeout.catch(() => undefined);
    try {
      return await Promise.race([fn(controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Write an object.
   *
   * The operation is a `PUT` of a fixed key with a fixed body, so retrying it
   * is idempotent: a repeated attempt cannot create an additional object or
   * a different body. No other write side effect is performed.
   */
  async upload(name: string, data: Buffer): Promise<void> {
    await withRetry(() =>
      this.withTimeout((signal) =>
        this.client.send(
          new PutObjectCommand({ Bucket: this.bucket, Key: name, Body: data }),
          signal ? { abortSignal: signal } : undefined,
        ),
      ),
    );
  }

  /**
   * Read an object.
   *
   * Newly written blobs are not immediately visible on every Shelby
   * deployment, so a 404 is retried a bounded number of times before it is
   * reported as `NOT_FOUND`.
   */
  async download(name: string, propagationRetries = 3): Promise<Buffer> {
    const attempts = Math.max(0, propagationRetries);
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        const response = await withRetry(() =>
          this.withTimeout((signal) =>
            this.client.send(
              new GetObjectCommand({ Bucket: this.bucket, Key: name }),
              signal ? { abortSignal: signal } : undefined,
            ),
          ),
        );
        return await readBody(response?.Body, name);
      } catch (err: unknown) {
        const status = httpStatus(err);
        const isNotFound = status === 404 || errorCode(err) === 'NoSuchKey';
        if (isNotFound && attempt < attempts) {
          // Brief wait for blob propagation before retrying.
          await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
          continue;
        }
        if (isNotFound) {
          throw new SealboxError(`Blob not found on Shelby: ${name}`, 'NOT_FOUND');
        }
        throw err;
      }
    }
    throw new SealboxError(
      `Blob not found after propagation retries: ${name}`,
      'NOT_FOUND',
    );
  }

  /** Ping the S3 endpoint — used by `sealbox doctor`. */
  async ping(): Promise<void> {
    await withRetry(
      () =>
        this.withTimeout((signal) =>
          this.client.send(
            new HeadBucketCommand({ Bucket: this.bucket }),
            signal ? { abortSignal: signal } : undefined,
          ),
        ),
      2,
      200,
    );
  }
}

/**
 * Collect an S3 response body into a Buffer.
 *
 * Handles both the streaming and the in-memory shapes the AWS SDK can
 * return, and surfaces a typed error instead of throwing a bare
 * `TypeError` when the body is missing.
 */
async function readBody(body: unknown, name: string): Promise<Buffer> {
  if (body === undefined || body === null) {
    throw new SealboxError(
      `Storage endpoint returned an empty body for ${name}.`,
      'NETWORK',
    );
  }

  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'utf-8');

  if (body instanceof Readable || typeof (body as Readable).on === 'function') {
    const stream = body as Readable;
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  throw new SealboxError(
    `Storage endpoint returned an unsupported body type for ${name}.`,
    'NETWORK',
  );
}

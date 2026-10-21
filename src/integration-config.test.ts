/**
 * Tests that pin the documented Shelby S3 gateway contract.
 *
 * The contract is recorded in docs/SHELBY-INTEGRATION.md. These tests exist
 * so that a future change cannot silently drift away from it again — the
 * v0.2.0 adapter hard-coded `us-east-1` for the SigV4 region and a bucket
 * name that cannot resolve to any account, and used the
 * `/resource/<generic struct tag>` balance endpoint, which the fullnode
 * rejects with HTTP 400.
 */
import { makeStorageFromEnv, DEFAULT_S3_REGION, FALLBACK_S3_BUCKET } from './cli';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './storage';

const BASE_ENV: NodeJS.ProcessEnv = {
  SHELBY_S3_ENDPOINT: 'https://api.shelbynet.shelby.xyz/shelby',
  SHELBY_API_KEY: 'shelby-api-key',
};

const ADDRESS = '0x147e4d3a5b10eaed2a93536e284c23096dfcea9ac61f0a8420e5d01fbd8f0ea8';

describe('Shelby S3 gateway configuration', () => {
  test('the SigV4 region defaults to shelbyland, not us-east-1', () => {
    const storage = makeStorageFromEnv(BASE_ENV);
    expect(storage.resolved.region).toBe(DEFAULT_S3_REGION);
    expect(storage.resolved.region).toBe('shelbyland');
  });

  test('the region can be overridden', () => {
    const storage = makeStorageFromEnv({
      ...BASE_ENV,
      SHELBY_S3_REGION: 'us-east-1',
    });
    expect(storage.resolved.region).toBe('us-east-1');
  });

  test('the bucket resolves to the account address when one is supplied', () => {
    const storage = makeStorageFromEnv(BASE_ENV, ADDRESS);
    expect(storage.resolved.bucket).toBe(ADDRESS);
  });

  test('the bucket can be overridden explicitly', () => {
    const storage = makeStorageFromEnv(
      { ...BASE_ENV, SHELBY_S3_BUCKET: 'my-alias' },
      ADDRESS,
    );
    expect(storage.resolved.bucket).toBe('my-alias');
  });

  test('without an account address the legacy bucket name is used', () => {
    const storage = makeStorageFromEnv(BASE_ENV);
    expect(storage.resolved.bucket).toBe(FALLBACK_S3_BUCKET);
  });

  test('the request timeout is bounded by default and overridable', () => {
    expect(makeStorageFromEnv(BASE_ENV).resolved.requestTimeoutMs).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    expect(
      makeStorageFromEnv({ ...BASE_ENV, SHELBY_S3_TIMEOUT_MS: '5000' }).resolved
        .requestTimeoutMs,
    ).toBe(5000);
  });

  test('a non-numeric timeout is rejected as a configuration error', () => {
    expect(() =>
      makeStorageFromEnv({ ...BASE_ENV, SHELBY_S3_TIMEOUT_MS: 'soon' }),
    ).toThrow(/SHELBY_S3_TIMEOUT_MS/);
  });

  test('a missing endpoint is a configuration error', () => {
    expect(() => makeStorageFromEnv({})).toThrow(/SHELBY_S3_ENDPOINT/);
  });

  test('the resolved configuration never exposes the signing secret', () => {
    const storage = makeStorageFromEnv({
      ...BASE_ENV,
      SHELBY_S3_SECRET_ACCESS_KEY: 'super-secret-value',
    });
    expect(JSON.stringify(storage.resolved)).not.toContain('super-secret-value');
    expect(JSON.stringify(storage.resolved)).not.toContain('shelby-api-key');
  });
});

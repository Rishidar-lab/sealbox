/**
 * Storage tests.
 *
 * The S3 client is mocked — that is a network boundary, and mocking it is
 * legitimate. What is *not* mocked anywhere in this suite is the
 * cryptographic core.
 */
jest.mock('@aws-sdk/client-s3', () => {
  const mockSend = jest.fn();
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
    GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
    HeadBucketCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
    __mockSend: mockSend,
  };
});

import { Readable } from 'stream';
import { ShelbyStorage, SealboxError, assertValidEndpoint } from './storage';

const { __mockSend: mockSend } = jest.requireMock('@aws-sdk/client-s3');

const config = {
  endpoint: 'https://mock-endpoint.example',
  region: 'us-east-1',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'shelby',
};

function bodyOf(text: string): Readable {
  const stream = new Readable();
  stream.push(Buffer.from(text));
  stream.push(null);
  return stream;
}

function httpError(status: number, message = 'mock failure'): Error & {
  $metadata: { httpStatusCode: number };
} {
  const err = new Error(message) as Error & { $metadata: { httpStatusCode: number } };
  err.$metadata = { httpStatusCode: status };
  return err;
}

beforeEach(() => {
  mockSend.mockReset();
  delete process.env.SHELBY_API_KEY;
});

describe('ShelbyStorage — upload', () => {
  test('upload performs exactly one PUT with the right bucket, key and body', async () => {
    mockSend.mockResolvedValue({});
    const storage = new ShelbyStorage(config);
    const data = Buffer.from('hello');

    await expect(storage.upload('sealbox/abc', data)).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0];
    expect(command.input).toMatchObject({
      Bucket: 'shelby',
      Key: 'sealbox/abc',
      Body: data,
    });
  });

  test('upload retries a transient failure and then succeeds', async () => {
    mockSend
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { name: 'ECONNRESET' }))
      .mockResolvedValueOnce({});
    const storage = new ShelbyStorage(config);

    await expect(storage.upload('sealbox/abc', Buffer.from('x'))).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test('upload gives up after a bounded number of attempts', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('reset'), { name: 'ECONNRESET' }));
    const storage = new ShelbyStorage(config);

    await expect(storage.upload('sealbox/abc', Buffer.from('x'))).rejects.toBeDefined();
    // 4 attempts is the configured maximum; retries must never be unbounded.
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  test('a permanent failure is not retried', async () => {
    mockSend.mockRejectedValue(httpError(403));
    const storage = new ShelbyStorage(config);

    await expect(storage.upload('sealbox/abc', Buffer.from('x'))).rejects.toThrow(SealboxError);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('an authentication failure is not retried', async () => {
    mockSend.mockRejectedValue(httpError(401));
    const storage = new ShelbyStorage(config);

    await expect(storage.upload('sealbox/abc', Buffer.from('x'))).rejects.toMatchObject({
      code: 'AUTHENTICATION',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('ShelbyStorage — download', () => {
  test('download returns the object bytes', async () => {
    mockSend.mockResolvedValue({ Body: bodyOf('hello world') });
    const storage = new ShelbyStorage(config);

    const data = await storage.download('sealbox/abc', 0);
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.toString('utf-8')).toBe('hello world');
  });

  test('a missing object is reported as NOT_FOUND', async () => {
    mockSend.mockRejectedValue(httpError(404));
    const storage = new ShelbyStorage(config);

    await expect(storage.download('sealbox/abc', 0)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('a 404 is retried while the blob propagates, then reported', async () => {
    mockSend.mockRejectedValue(httpError(404));
    const storage = new ShelbyStorage(config);

    await expect(storage.download('sealbox/abc', 1)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // One initial attempt plus one propagation retry.
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test('a permanent failure is not retried', async () => {
    mockSend.mockRejectedValue(httpError(403));
    const storage = new ShelbyStorage(config);

    await expect(storage.download('sealbox/abc', 0)).rejects.toThrow(SealboxError);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('a stream error is propagated, not swallowed', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('stream exploded'));
      },
    });
    mockSend.mockResolvedValue({ Body: stream });
    const storage = new ShelbyStorage(config);

    await expect(storage.download('sealbox/abc', 0)).rejects.toThrow('stream exploded');
  });

  test('a missing body is reported as a typed error', async () => {
    mockSend.mockResolvedValue({});
    const storage = new ShelbyStorage(config);

    await expect(storage.download('sealbox/abc', 0)).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });
});

describe('ShelbyStorage — error mapping', () => {
  test('HTTP 402 is mapped to INSUFFICIENT_FUNDS', async () => {
    mockSend.mockRejectedValue(httpError(402, 'Payment Required'));
    const storage = new ShelbyStorage(config);

    await expect(storage.upload('k', Buffer.from('x'))).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
  });

  test('an explicit insufficient-balance message is mapped to INSUFFICIENT_FUNDS', async () => {
    mockSend.mockRejectedValue(new Error('Insufficient ShelbyUSD balance for this upload'));
    const storage = new ShelbyStorage(config);

    await expect(storage.upload('k', Buffer.from('x'))).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
  });

  test('an unrelated message is not mistaken for insufficient funds', async () => {
    mockSend.mockRejectedValue(new Error('the request was malformed'));
    const storage = new ShelbyStorage(config);

    await expect(storage.upload('k', Buffer.from('x'))).rejects.not.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
  });

  test('HTTP 429 is mapped to RATE_LIMITED and is not retried', async () => {
    mockSend.mockRejectedValue(httpError(429));
    const storage = new ShelbyStorage(config);

    await expect(storage.upload('k', Buffer.from('x'))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('HTTP 401 is mapped to AUTHENTICATION', async () => {
    mockSend.mockRejectedValue(httpError(401));
    const storage = new ShelbyStorage(config);

    await expect(storage.upload('k', Buffer.from('x'))).rejects.toMatchObject({
      code: 'AUTHENTICATION',
    });
  });

  test('HTTP 403 is mapped to AUTHORIZATION', async () => {
    mockSend.mockRejectedValue(httpError(403));
    const storage = new ShelbyStorage(config);

    await expect(storage.upload('k', Buffer.from('x'))).rejects.toMatchObject({
      code: 'AUTHORIZATION',
    });
  });

  test('error messages never contain the access key or secret', async () => {
    mockSend.mockRejectedValue(httpError(402));
    const storage = new ShelbyStorage(config);
    try {
      await storage.upload('k', Buffer.from('x'));
      throw new Error('expected a throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(config.accessKeyId);
      expect(message).not.toContain(config.secretAccessKey);
    }
  });
});

describe('ShelbyStorage — request timeout', () => {
  test('a hung request is aborted by the timeout instead of blocking forever', async () => {
    // A request that never settles.
    mockSend.mockImplementation(() => new Promise(() => undefined));
    const storage = new ShelbyStorage({ ...config, requestTimeoutMs: 60 });

    const started = Date.now();
    await expect(storage.upload('sealbox/abc', Buffer.from('x'))).rejects.toBeDefined();
    const elapsed = Date.now() - started;
    // Bounded: the abort fires and the retry loop gives up quickly.
    expect(elapsed).toBeLessThan(3000);
  });

  test('the timeout is disabled when it is set to zero', async () => {
    mockSend.mockResolvedValue({});
    const storage = new ShelbyStorage({ ...config, requestTimeoutMs: 0 });
    await expect(storage.upload('sealbox/abc', Buffer.from('x'))).resolves.toBeUndefined();
  });
});

describe('ShelbyStorage — endpoint validation', () => {
  test('a missing endpoint is a configuration error', () => {
    expect(() => assertValidEndpoint('')).toThrow(SealboxError);
    expect(() => assertValidEndpoint('   ')).toThrow(SealboxError);
  });

  test('a malformed URL is a configuration error', () => {
    expect(() => assertValidEndpoint('not a url')).toThrow(SealboxError);
  });

  test('a non-HTTP scheme is a configuration error', () => {
    expect(() => assertValidEndpoint('ftp://example.com')).toThrow(SealboxError);
  });

  test('an endpoint carrying credentials is rejected', () => {
    expect(() => assertValidEndpoint('https://user:pass@example.com')).toThrow(SealboxError);
  });

  test('a valid endpoint is accepted and trailing slashes are trimmed', () => {
    expect(assertValidEndpoint('https://example.com/shelby/')).toBe('https://example.com/shelby');
  });

  test('constructing a client with a bad endpoint fails immediately', () => {
    expect(() => new ShelbyStorage({ ...config, endpoint: 'nope' })).toThrow(SealboxError);
  });
});

describe('ShelbyStorage — ping', () => {
  test('ping succeeds against a reachable endpoint', async () => {
    mockSend.mockResolvedValue({});
    const storage = new ShelbyStorage(config);
    await expect(storage.ping()).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('ping fails when the endpoint is unreachable', async () => {
    mockSend.mockRejectedValue(httpError(503));
    const storage = new ShelbyStorage(config);
    await expect(storage.ping()).rejects.toBeDefined();
    // ping uses at most 2 attempts.
    expect(mockSend.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

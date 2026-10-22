/**
 * Real cryptographic tests.
 *
 * These tests execute the actual Ed25519 implementation from
 * `@aptos-labs/ts-sdk` (and therefore `@noble/curves`) against deterministic
 * test-only key material. Nothing in this file is mocked: mocking the
 * signature check is exactly the mistake this suite exists to prevent.
 */
import {
  ED25519_SIGNATURE_SCHEME,
  SIGNED_PAYLOAD_DOMAIN,
  SIGNED_PAYLOAD_VERSION,
  addressesMatch,
  computeSha256,
  createSignedPayload,
  createSigner,
  deriveSignerAddress,
  isValidAddress,
  isValidPublicKey,
  isValidSha256,
  isValidSignature,
  normalizeAddress,
  normalizePublicKey,
  normalizeSignature,
  signSignedPayload,
  verifyEd25519Signature,
} from './crypto';
import {
  BOGUS_SIGNATURE,
  TEST_ADDRESS_A,
  TEST_ADDRESS_B,
  TEST_ADDRESS_C,
  TEST_PRIVATE_KEY_A,
  TEST_PRIVATE_KEY_B,
  TEST_PRIVATE_KEY_C,
  TEST_PUBLIC_KEY_A,
  TEST_PUBLIC_KEY_B,
  TEST_PUBLIC_KEY_C,
} from './__fixtures__/keys';

const BASE_FIELDS = {
  sha256: computeSha256(Buffer.from('hello world')),
  sizeBytes: 11,
  blobName: 'sealbox/b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  sealedAt: '2026-10-21T12:00:00.000Z',
  network: 'shelbynet',
  signerPublicKey: TEST_PUBLIC_KEY_A,
};

/**
 * Reference parser for the canonical payload format.
 *
 * It implements the documented length-prefixed framing independently of the
 * producer — a byte-level parser that consumes exactly the declared number of
 * bytes per field — so the producer cannot silently change the format
 * without the tests noticing.
 */
function parseCanonicalPayload(payload: Buffer): Record<string, string> {
  const COLON = 0x3a;
  const LF = 0x0a;
  let offset = 0;

  const domainEnd = payload.indexOf(LF, offset);
  expect(domainEnd).toBeGreaterThan(-1);
  expect(payload.subarray(offset, domainEnd).toString('utf-8')).toBe(SIGNED_PAYLOAD_DOMAIN);
  offset = domainEnd + 1;

  const fields: Record<string, string> = {};
  while (offset < payload.length) {
    const nameEnd = payload.indexOf(COLON, offset);
    const name = payload.subarray(offset, nameEnd).toString('utf-8');
    const lengthEnd = payload.indexOf(COLON, nameEnd + 1);
    const length = Number(payload.subarray(nameEnd + 1, lengthEnd).toString('utf-8'));
    const valueStart = lengthEnd + 1;
    const value = payload.subarray(valueStart, valueStart + length).toString('utf-8');
    expect(Buffer.byteLength(value, 'utf-8')).toBe(length);
    fields[name] = value;
    offset = valueStart + length;
    expect(payload[offset]).toBe(LF);
    offset += 1;
  }
  return fields;
}

// ─── A. SHA-256 ─────────────────────────────────────────────────────────────

describe('computeSha256', () => {
  test('known vector: "hello world"', () => {
    expect(computeSha256(Buffer.from('hello world'))).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });

  test('known vector: empty input', () => {
    expect(computeSha256(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('different bytes produce different digests', () => {
    const a = computeSha256(Buffer.from('sealbox-a'));
    const b = computeSha256(Buffer.from('sealbox-b'));
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
    expect(b).toHaveLength(64);
  });

  test('handles binary payloads', () => {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f]);
    const digest = computeSha256(binary);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(computeSha256(Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f])));
  });

  test('isValidSha256 accepts only lowercase 64-char hex', () => {
    expect(isValidSha256(computeSha256(Buffer.from('x')))).toBe(true);
    expect(isValidSha256('A'.repeat(64))).toBe(false);
    expect(isValidSha256('a'.repeat(63))).toBe(false);
    expect(isValidSha256('')).toBe(false);
    expect(isValidSha256(undefined)).toBe(false);
  });
});

// ─── B. canonical signed payload ───────────────────────────────────────────

describe('createSignedPayload', () => {
  test('is deterministic for identical fields', () => {
    const a = createSignedPayload(BASE_FIELDS);
    const b = createSignedPayload(BASE_FIELDS);
    expect(a.equals(b)).toBe(true);
  });

  test('does not depend on JavaScript object property ordering', () => {
    const reordered = {
      signerPublicKey: BASE_FIELDS.signerPublicKey,
      network: BASE_FIELDS.network,
      sealedAt: BASE_FIELDS.sealedAt,
      blobName: BASE_FIELDS.blobName,
      sizeBytes: BASE_FIELDS.sizeBytes,
      sha256: BASE_FIELDS.sha256,
    };
    expect(createSignedPayload(reordered).equals(createSignedPayload(BASE_FIELDS))).toBe(
      true,
    );
  });

  test('contains the domain separator and the payload version', () => {
    const payload = createSignedPayload(BASE_FIELDS).toString('utf-8');
    expect(payload.startsWith(`${SIGNED_PAYLOAD_DOMAIN}\n`)).toBe(true);
    expect(payload).toContain(`payloadVersion:${SIGNED_PAYLOAD_VERSION.length}:${SIGNED_PAYLOAD_VERSION}\n`);
  });

  test('has no unstable whitespace and no trailing newline padding', () => {
    const payload = createSignedPayload(BASE_FIELDS).toString('utf-8');
    expect(payload).not.toMatch(/[ \t]/);
    expect(payload.endsWith('\n')).toBe(true);
    expect(payload).not.toMatch(/\n\n/);
  });

  test('length-prefixes every value so field boundaries cannot be forged', () => {
    const hostileBlobName =
      'evil\nsha256:64:' + '0'.repeat(64) + '\nsizeBytes:999';
    const payload = createSignedPayload({
      ...BASE_FIELDS,
      blobName: hostileBlobName,
    });

    // A length-aware parser recovers the injected text verbatim and still
    // finds the real digest — the injected text cannot pose as a field.
    const parsed = parseCanonicalPayload(payload);
    expect(parsed.sha256).toBe(BASE_FIELDS.sha256);
    expect(parsed.sizeBytes).toBe(String(BASE_FIELDS.sizeBytes));
    expect(parsed.blobName).toBe(hostileBlobName);
    expect(Object.keys(parsed).filter((k) => k === 'sha256')).toHaveLength(1);
  });

  test('rejects a malformed digest, size, blob name, network or public key', () => {
    expect(() => createSignedPayload({ ...BASE_FIELDS, sha256: 'nope' })).toThrow();
    expect(() => createSignedPayload({ ...BASE_FIELDS, sizeBytes: -1 })).toThrow();
    expect(() => createSignedPayload({ ...BASE_FIELDS, sizeBytes: 1.5 })).toThrow();
    expect(() => createSignedPayload({ ...BASE_FIELDS, blobName: '' })).toThrow();
    expect(() => createSignedPayload({ ...BASE_FIELDS, network: '' })).toThrow();
    expect(() => createSignedPayload({ ...BASE_FIELDS, sealedAt: '' })).toThrow();
    expect(() => createSignedPayload({ ...BASE_FIELDS, signerPublicKey: 'nope' })).toThrow();
  });
});

// ─── C. real sign / verify ─────────────────────────────────────────────────

describe('real Ed25519 sign and verify', () => {
  const payload = createSignedPayload(BASE_FIELDS);
  const signed = signSignedPayload(payload, TEST_PRIVATE_KEY_A);

  test('the signer derives the expected public key and address', () => {
    expect(signed.signerPublicKey).toBe(TEST_PUBLIC_KEY_A);
    expect(signed.signerAddress).toBe(TEST_ADDRESS_A);
    expect(ED25519_SIGNATURE_SCHEME).toBe('ed25519');
  });

  test('a signature made with the matching key verifies', () => {
    const result = verifyEd25519Signature({
      payload,
      signatureHex: signed.signature,
      publicKeyHex: signed.signerPublicKey,
    });
    expect(result.valid).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  test('the same signature does NOT verify against a different public key', () => {
    const result = verifyEd25519Signature({
      payload,
      signatureHex: signed.signature,
      publicKeyHex: TEST_PUBLIC_KEY_B,
    });
    expect(result.valid).toBe(false);
    expect(result.failure).toBe('SIGNATURE_MISMATCH');
  });

  test('mutating the payload invalidates the signature', () => {
    const mutated = createSignedPayload({ ...BASE_FIELDS, sha256: 'b'.repeat(64) });
    const result = verifyEd25519Signature({
      payload: mutated,
      signatureHex: signed.signature,
      publicKeyHex: signed.signerPublicKey,
    });
    expect(result.valid).toBe(false);
  });

  test('mutating the digest inside the signed record invalidates the signature', () => {
    const mutated = createSignedPayload({ ...BASE_FIELDS, sha256: 'c'.repeat(64) });
    const result = verifyEd25519Signature({
      payload: mutated,
      signatureHex: signed.signature,
      publicKeyHex: signed.signerPublicKey,
    });
    expect(result.valid).toBe(false);
  });

  test('mutating the timestamp inside the signed record invalidates the signature', () => {
    const mutated = createSignedPayload({
      ...BASE_FIELDS,
      sealedAt: '2026-10-21T12:00:01.000Z',
    });
    const result = verifyEd25519Signature({
      payload: mutated,
      signatureHex: signed.signature,
      publicKeyHex: signed.signerPublicKey,
    });
    expect(result.valid).toBe(false);
  });

  test('mutating the blob name inside the signed record invalidates the signature', () => {
    const mutated = createSignedPayload({ ...BASE_FIELDS, blobName: 'sealbox/other' });
    const result = verifyEd25519Signature({
      payload: mutated,
      signatureHex: signed.signature,
      publicKeyHex: signed.signerPublicKey,
    });
    expect(result.valid).toBe(false);
  });

  test('mutating the network inside the signed record invalidates the signature', () => {
    const mutated = createSignedPayload({ ...BASE_FIELDS, network: 'testnet' });
    const result = verifyEd25519Signature({
      payload: mutated,
      signatureHex: signed.signature,
      publicKeyHex: signed.signerPublicKey,
    });
    expect(result.valid).toBe(false);
  });

  test('mutating the size inside the signed record invalidates the signature', () => {
    const mutated = createSignedPayload({ ...BASE_FIELDS, sizeBytes: BASE_FIELDS.sizeBytes + 1 });
    const result = verifyEd25519Signature({
      payload: mutated,
      signatureHex: signed.signature,
      publicKeyHex: signed.signerPublicKey,
    });
    expect(result.valid).toBe(false);
  });

  test('a bogus but well-formed signature never verifies', () => {
    const result = verifyEd25519Signature({
      payload,
      signatureHex: BOGUS_SIGNATURE,
      publicKeyHex: TEST_PUBLIC_KEY_A,
    });
    expect(result.valid).toBe(false);
    expect(result.failure).toBe('SIGNATURE_MISMATCH');
  });

  test('a malformed signature fails closed with a typed failure', () => {
    for (const bad of ['', 'sig', `0x${'de'.repeat(63)}`, `0x${'zz'.repeat(64)}`, '0x']) {
      const result = verifyEd25519Signature({
        payload,
        signatureHex: bad,
        publicKeyHex: TEST_PUBLIC_KEY_A,
      });
      expect(result.valid).toBe(false);
      expect(result.failure).toBe('MALFORMED_SIGNATURE');
    }
  });

  test('a malformed public key fails closed with a typed failure', () => {
    for (const bad of ['', 'pub', `0x${'ab'.repeat(31)}`, `0x${'ab'.repeat(33)}`, '0xnothex']) {
      const result = verifyEd25519Signature({
        payload,
        signatureHex: signed.signature,
        publicKeyHex: bad,
      });
      expect(result.valid).toBe(false);
      expect(result.failure).toBe('MALFORMED_PUBLIC_KEY');
    }
  });

  test('a public key of the right length but not a usable key fails closed', () => {
    // 0xff..ff is not a valid compressed point at all.
    const notAPoint = verifyEd25519Signature({
      payload,
      signatureHex: signed.signature,
      publicKeyHex: `0x${'ff'.repeat(32)}`,
    });
    expect(notAPoint.valid).toBe(false);
    expect(notAPoint.failure).toBe('MALFORMED_PUBLIC_KEY');
  });

  test('signature verification never throws for hostile input', () => {
    expect(() =>
      verifyEd25519Signature({
        payload,
        signatureHex: '\u0000\u0001',
        publicKeyHex: '\u0000',
      }),
    ).not.toThrow();
  });

  test('a key that was signed by a different signer does not verify', () => {
    const other = signSignedPayload(payload, TEST_PRIVATE_KEY_B);
    const result = verifyEd25519Signature({
      payload,
      signatureHex: other.signature,
      publicKeyHex: TEST_PUBLIC_KEY_A,
    });
    expect(result.valid).toBe(false);
  });
});

// ─── D. signer identity ────────────────────────────────────────────────────

describe('signer identity derivation', () => {
  test('derives the expected Aptos authentication-key address', () => {
    expect(deriveSignerAddress(TEST_PUBLIC_KEY_A)).toBe(TEST_ADDRESS_A);
    expect(deriveSignerAddress(TEST_PUBLIC_KEY_B)).toBe(TEST_ADDRESS_B);
    expect(deriveSignerAddress(TEST_PUBLIC_KEY_C)).toBe(TEST_ADDRESS_C);
  });

  test('is case-insensitive but shape-strict', () => {
    expect(deriveSignerAddress(TEST_PUBLIC_KEY_A.toUpperCase().replace('0X', '0x'))).toBe(
      TEST_ADDRESS_A,
    );
    expect(() => deriveSignerAddress('0x1234')).toThrow();
    expect(() => deriveSignerAddress('')).toThrow();
  });

  test('addressesMatch accepts the same address in different case', () => {
    expect(addressesMatch(TEST_ADDRESS_A, TEST_ADDRESS_A.toUpperCase().replace('0X', '0x'))).toBe(
      true,
    );
  });

  test('addressesMatch rejects a different address', () => {
    expect(addressesMatch(TEST_ADDRESS_A, TEST_ADDRESS_B)).toBe(false);
    expect(addressesMatch(TEST_ADDRESS_A, TEST_ADDRESS_C)).toBe(false);
  });

  test('addressesMatch rejects malformed input instead of throwing', () => {
    expect(addressesMatch(TEST_ADDRESS_A, '0xnothex')).toBe(false);
    expect(addressesMatch('', '')).toBe(false);
    expect(addressesMatch('0x1', '0x1')).toBe(false);
  });

  test('a third independent key derives its own distinct address', () => {
    const signer = createSigner(TEST_PRIVATE_KEY_C);
    try {
      expect(signer.signerPublicKey).toBe(TEST_PUBLIC_KEY_C);
      expect(signer.signerAddress).toBe(TEST_ADDRESS_C);
      expect(signer.signerAddress).not.toBe(TEST_ADDRESS_A);
      expect(signer.signerAddress).not.toBe(TEST_ADDRESS_B);
    } finally {
      signer.dispose();
    }
  });

  test('createSigner exposes the same public key and address', () => {
    const signer = createSigner(TEST_PRIVATE_KEY_A);
    try {
      expect(signer.signerPublicKey).toBe(TEST_PUBLIC_KEY_A);
      expect(signer.signerAddress).toBe(TEST_ADDRESS_A);
    } finally {
      signer.dispose();
    }
  });
});

// ─── E. encoding normalization ─────────────────────────────────────────────

describe('encoding normalization', () => {
  test('public keys, signatures and addresses normalize to lowercase 0x form', () => {
    expect(normalizePublicKey(TEST_PUBLIC_KEY_A.toUpperCase().replace('0X', '0x'))).toBe(
      TEST_PUBLIC_KEY_A,
    );
    expect(normalizeAddress(TEST_ADDRESS_A.toUpperCase().replace('0X', '0x'))).toBe(
      TEST_ADDRESS_A,
    );
    expect(normalizeSignature(`0x${'AB'.repeat(64)}`)).toBe(`0x${'ab'.repeat(64)}`);
  });

  test('normalizers reject malformed input', () => {
    expect(() => normalizePublicKey('0x1234')).toThrow();
    expect(() => normalizeSignature('0x1234')).toThrow();
    expect(() => normalizeAddress('0x1234')).toThrow();
  });

  test('shape predicates agree with the normalizers', () => {
    expect(isValidPublicKey(TEST_PUBLIC_KEY_A)).toBe(true);
    expect(isValidPublicKey('0x1234')).toBe(false);
    expect(isValidSignature(`0x${'ab'.repeat(64)}`)).toBe(true);
    expect(isValidSignature('0x1234')).toBe(false);
    expect(isValidAddress(TEST_ADDRESS_A)).toBe(true);
    expect(isValidAddress('0x1')).toBe(false);
  });
});

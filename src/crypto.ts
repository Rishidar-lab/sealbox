import * as nodeCrypto from 'crypto';
// The `/crypto` subpath is used deliberately: the package barrel pulls in the
// Aptos CLI and HTTP client, which sealbox does not need. The crypto
// subpath exposes exactly the Ed25519 primitives used here.
import {
  Ed25519PrivateKey,
  Ed25519PublicKey,
  Ed25519Signature,
} from '@aptos-labs/ts-sdk/crypto';
// `@noble/curves` is the curve implementation the Aptos SDK itself uses. It
// is pinned to the exact version the SDK depends on so that both share one
// copy. It is used for strict public-key validation — see
// `validateEd25519PublicKey` for why that is necessary.
import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Sealbox cryptographic primitives.
 *
 * Everything in this module is backed by the real Ed25519 implementation in
 * `@aptos-labs/ts-sdk` (which itself delegates to `@noble/curves`). Nothing
 * here mocks, stubs or approximates the curve.
 *
 * ## Stored encodings (normalized, documented)
 *
 * | value        | representation                                   |
 * |--------------|--------------------------------------------------|
 * | public key   | `0x` + 64 lowercase hex chars (32 raw bytes)      |
 * | signature    | `0x` + 128 lowercase hex chars (64 raw bytes)     |
 * | signer addr  | `0x` + 64 lowercase hex chars (32 raw bytes)      |
 * | SHA-256      | 64 lowercase hex chars (no `0x` prefix)           |
 *
 * The signer address is the Aptos "legacy Ed25519" authentication-key
 * address, i.e. `publicKey.authKey().derivedAddress()`, always rendered in
 * the long AIP-40 form so that short/special forms can never be used to
 * smuggle a different byte string past the consistency check.
 *
 * ## Canonical signed payload
 *
 * The signed payload is produced by {@link createSignedPayload} and is the
 * single source of truth for what the signature covers. The *same* function is
 * used at seal time and at verify time.
 *
 * Format (UTF-8, LF line endings, no trailing whitespace):
 *
 * ```text
 * SEALBOX-MANIFEST-V2\n
 * payloadVersion:<len>:<value>\n
 * sha256:<len>:<value>\n
 * sizeBytes:<len>:<value>\n
 * blobName:<len>:<value>\n
 * sealedAt:<len>:<value>\n
 * network:<len>:<value>\n
 * signerPublicKey:<len>:<value>\n
 * ```
 *
 * `<len>` is the UTF-8 *byte* length of the value that follows. Length
 * prefixing makes the encoding injective: no field value can forge a field
 * boundary, so no escaping scheme (and no locale/encoding dependent
 * transformation) is required. Field order is fixed by the function body and
 * is therefore independent of JavaScript object property ordering.
 */

/** Domain separator. Unique to Sealbox; prevents cross-protocol replay. */
export const SIGNED_PAYLOAD_DOMAIN = 'SEALBOX-MANIFEST-V2';

/** Version of the canonical signed-payload format. */
export const SIGNED_PAYLOAD_VERSION = '2';

/** The only signature scheme understood by this release. */
export const ED25519_SIGNATURE_SCHEME = 'ed25519';

/** Length of a raw Ed25519 public key, in bytes. */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/** Length of a raw Ed25519 signature, in bytes. */
export const ED25519_SIGNATURE_BYTES = 64;

/** Build the hex pattern for a `0x`-prefixed value of `bytes` raw bytes. */
function hexPattern(bytes: number): RegExp {
  return new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
}

const PUBLIC_KEY_PATTERN = hexPattern(ED25519_PUBLIC_KEY_BYTES);
const SIGNATURE_PATTERN = hexPattern(ED25519_SIGNATURE_BYTES);
const ADDRESS_PATTERN = hexPattern(ED25519_PUBLIC_KEY_BYTES);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Fields covered by the signature, in canonical order. */
export interface SignedPayloadFields {
  /** Lowercase hex SHA-256 of the artifact bytes. */
  sha256: string;
  /** Byte length of the artifact. */
  sizeBytes: number;
  /** Storage object name the artifact was written to. */
  blobName: string;
  /** ISO-8601 timestamp string chosen by the signer. */
  sealedAt: string;
  /** Storage network the blob was written to. */
  network: string;
  /** Normalized `0x`-prefixed Ed25519 public key of the signer. */
  signerPublicKey: string;
}

/** Result of signing a canonical payload. */
export interface SignedPayloadSignature {
  /** Normalized `0x`-prefixed Ed25519 signature. */
  signature: string;
  /** Normalized `0x`-prefixed Ed25519 public key. */
  signerPublicKey: string;
  /** Normalized `0x`-prefixed Aptos authentication-key address. */
  signerAddress: string;
}

/** Why an Ed25519 verification did not succeed. */
export type Ed25519Failure =
  | 'MALFORMED_PUBLIC_KEY'
  | 'MALFORMED_SIGNATURE'
  | 'SIGNATURE_MISMATCH';

/** Outcome of an Ed25519 verification attempt. */
export interface Ed25519Verification {
  valid: boolean;
  failure?: Ed25519Failure;
}

// ─── hashing ────────────────────────────────────────────────────────────────

export function computeSha256(data: Buffer | Uint8Array): string {
  return nodeCrypto.createHash('sha256').update(data).digest('hex');
}

/** True when `value` is a lowercase hex SHA-256 digest. */
export function isValidSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

// ─── canonical signed payload ───────────────────────────────────────────────

/**
 * Render one canonical payload field.
 *
 * The value is length-prefixed with its UTF-8 byte length so that the
 * encoding is unambiguous even for values containing newlines, colons or
 * non-ASCII characters.
 */
function payloadField(name: string, value: string): string {
  const byteLength = Buffer.byteLength(value, 'utf-8');
  return `${name}:${byteLength}:${value}\n`;
}

/**
 * Build the canonical, domain-separated bytes that get signed.
 *
 * @throws Error if a field value is structurally invalid. Callers that must
 *   not throw should validate the record first (see `src/verification.ts`).
 */
export function createSignedPayload(fields: SignedPayloadFields): Buffer {
  if (!isValidSha256(fields.sha256)) {
    throw new Error('Signed payload requires a lowercase 64-character SHA-256 hex digest.');
  }
  if (!Number.isSafeInteger(fields.sizeBytes) || fields.sizeBytes < 0) {
    throw new Error('Signed payload requires a non-negative integer sizeBytes.');
  }
  if (typeof fields.blobName !== 'string' || fields.blobName.length === 0) {
    throw new Error('Signed payload requires a non-empty blobName.');
  }
  if (typeof fields.sealedAt !== 'string' || fields.sealedAt.length === 0) {
    throw new Error('Signed payload requires a non-empty sealedAt.');
  }
  if (typeof fields.network !== 'string' || fields.network.length === 0) {
    throw new Error('Signed payload requires a non-empty network.');
  }
  if (!isValidPublicKey(fields.signerPublicKey)) {
    throw new Error('Signed payload requires a normalized 0x-prefixed 32-byte Ed25519 public key.');
  }

  const canonical = [
    `${SIGNED_PAYLOAD_DOMAIN}\n`,
    payloadField('payloadVersion', SIGNED_PAYLOAD_VERSION),
    payloadField('sha256', fields.sha256),
    payloadField('sizeBytes', String(fields.sizeBytes)),
    payloadField('blobName', fields.blobName),
    payloadField('sealedAt', fields.sealedAt),
    payloadField('network', fields.network),
    payloadField('signerPublicKey', normalizePublicKey(fields.signerPublicKey)),
  ].join('');

  return Buffer.from(canonical, 'utf-8');
}

// ─── encoding normalization ─────────────────────────────────────────────────

/**
 * Normalize an Ed25519 public key to `0x` + 64 lowercase hex chars.
 * @throws Error when the value is not a well-formed public key.
 */
export function normalizePublicKey(value: string): string {
  if (!isValidPublicKey(value)) {
    throw new Error('Invalid Ed25519 public key: expected 0x + 64 hex characters.');
  }
  return `0x${value.slice(2).toLowerCase()}`;
}

/**
 * Normalize an Ed25519 signature to `0x` + 128 lowercase hex chars.
 * @throws Error when the value is not a well-formed signature.
 */
export function normalizeSignature(value: string): string {
  if (!isValidSignature(value)) {
    throw new Error('Invalid Ed25519 signature: expected 0x + 128 hex characters.');
  }
  return `0x${value.slice(2).toLowerCase()}`;
}

/**
 * Normalize a signer address to `0x` + 64 lowercase hex chars (long AIP-40).
 * @throws Error when the value is not a well-formed address.
 */
export function normalizeAddress(value: string): string {
  if (!isValidAddress(value)) {
    throw new Error('Invalid signer address: expected 0x + 64 hex characters.');
  }
  return `0x${value.slice(2).toLowerCase()}`;
}

export function isValidPublicKey(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_KEY_PATTERN.test(value);
}

export function isValidSignature(value: unknown): value is string {
  return typeof value === 'string' && SIGNATURE_PATTERN.test(value);
}

export function isValidAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value);
}

// ─── public key validation ─────────────────────────────────────────────────

/** Why a stored Ed25519 public key was rejected. */
export type PublicKeyRejection =
  /** The bytes are not a well-formed compressed Edwards point. */
  | 'MALFORMED_ENCODING'
  /** The point has small order: it is not in the prime-order subgroup. */
  | 'NOT_PRIME_ORDER'
  /** The point is the identity element and cannot be a public key. */
  | 'IDENTITY_POINT';

/**
 * Strictly validate an Ed25519 public key.
 *
 * ## Why this is necessary
 *
 * The Aptos SDK's `Ed25519PublicKey` constructor only checks the byte
 * length, and the underlying `@noble/curves` verifier runs in ZIP-215 mode,
 * which *skips* the small-order public-key rejection that RFC 8032
 * §5.1.7 relies on. As a result, `verifyBytes()` returns `true` for
 * combinations such as the all-zero public key with the all-zero signature —
 * a signature no legitimate signer ever produced. A manifest built that way
 * would otherwise pass verification.
 *
 * Sealbox therefore requires the stored public key to be:
 *
 *  1. a strictly-decoded (RFC 8032, not ZIP-215) compressed Edwards point —
 *     this rejects non-canonical `y` encodings;
 *  2. **not** the identity element;
 *  3. in the prime-order subgroup (`[L]P == identity`), which excludes every
 *     small-order/torsion point.
 *
 * Together these admit exactly the public keys a legitimate Ed25519 signer
 * can produce.
 */
export function validateEd25519PublicKey(
  publicKeyHex: string,
): { valid: true } | { valid: false; reason: PublicKeyRejection } {
  if (!isValidPublicKey(publicKeyHex)) {
    return { valid: false, reason: 'MALFORMED_ENCODING' };
  }
  try {
    // `fromHex` with the default (non-ZIP-215) rules throws for bytes that
    // are not a strictly valid compressed point.
    const point = ed25519.Point.fromHex(publicKeyHex.slice(2));
    if (point.is0()) {
      return { valid: false, reason: 'IDENTITY_POINT' };
    }
    if (!point.isTorsionFree()) {
      return { valid: false, reason: 'NOT_PRIME_ORDER' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'MALFORMED_ENCODING' };
  }
}

// ─── signing ────────────────────────────────────────────────────────────────

/**
 * Derive the Aptos authentication-key address of an Ed25519 public key.
 *
 * Uses exactly the same SDK semantics as the sealing path
 * (`publicKey().authKey().derivedAddress()`), rendered in long form.
 *
 * @throws Error when the public key is malformed, is not a valid curve point,
 *   is the identity element, or is not in the prime-order subgroup.
 */
export function deriveSignerAddress(publicKeyHex: string): string {
  const validation = validateEd25519PublicKey(publicKeyHex);
  if (!validation.valid) {
    throw new Error(
      `Invalid Ed25519 public key (${validation.reason}); refusing to derive a signer address.`,
    );
  }
  const publicKey = new Ed25519PublicKey(normalizePublicKey(publicKeyHex));
  const address = publicKey.authKey().derivedAddress();
  return `0x${address.toStringLong().slice(2).toLowerCase()}`;
}

/**
 * A signer bound to one private key.
 *
 * `dispose()` clears the SDK's key buffer. This is a best-effort
 * window-narrowing measure only: JavaScript offers no guarantee that key
 * material is erased from memory (see SECURITY.md).
 */
export interface SealboxSigner {
  /** Normalized `0x`-prefixed Ed25519 public key. */
  readonly signerPublicKey: string;
  /** Normalized `0x`-prefixed Aptos authentication-key address. */
  readonly signerAddress: string;
  /** Signs exact payload bytes and returns a normalized signature. */
  sign(payload: Uint8Array): string;
  /** Best-effort clearing of the private-key buffer. */
  dispose(): void;
}

/**
 * Create a signer from a hex-encoded Ed25519 private key.
 *
 * @param privateKeyHex plain hex (with or without `0x`) or an AIP-80 string.
 * @throws Error when the key is unusable.
 */
export function createSigner(privateKeyHex: string): SealboxSigner {
  // `strict = false` keeps the SDK from printing its AIP-80 advisory for
  // plain hex keys. Both plain hex and AIP-80 strings are accepted.
  const privateKey = new Ed25519PrivateKey(privateKeyHex, false);
  const publicKey = privateKey.publicKey();
  const signerPublicKey = normalizePublicKey(publicKey.toString());
  const signerAddress = deriveSignerAddress(signerPublicKey);

  return {
    signerPublicKey,
    signerAddress,
    sign(payload: Uint8Array): string {
      return normalizeSignature(privateKey.signBytes(payload).toString());
    },
    dispose(): void {
      privateKey.clear();
    },
  };
}

/**
 * Sign a canonical payload with an Ed25519 private key.
 *
 * The private key is used only through the SDK's `Uint8Array` internals and
 * is `clear()`-ed before this function returns. `clear()` is a best-effort
 * window-narrowing measure only — JavaScript gives no guarantee that key
 * material is erased from memory (see SECURITY.md).
 *
 * @param payload bytes produced by {@link createSignedPayload}
 * @param privateKeyHex hex-encoded Ed25519 private key (plain or AIP-80)
 * @throws Error when the private key is unusable or the payload is invalid.
 */
export function signSignedPayload(
  payload: Uint8Array,
  privateKeyHex: string,
): SignedPayloadSignature {
  const signer = createSigner(privateKeyHex);
  try {
    return {
      signature: signer.sign(payload),
      signerPublicKey: signer.signerPublicKey,
      signerAddress: signer.signerAddress,
    };
  } finally {
    signer.dispose();
  }
}

// ─── verification ───────────────────────────────────────────────────────────

/**
 * Cryptographically verify an Ed25519 signature over exact payload bytes.
 *
 * This never throws and never returns `true` for a malformed public key,
 * a malformed signature or a payload that does not match. Malformed inputs
 * are reported as typed failures so the caller can surface an accurate
 * status instead of a generic boolean.
 */
export function verifyEd25519Signature(args: {
  payload: Uint8Array;
  signatureHex: string;
  publicKeyHex: string;
}): Ed25519Verification {
  // The stored public key must be a usable public key, not merely 32 bytes
  // of hex. See `validateEd25519PublicKey` for the concrete forgery this
  // prevents.
  const keyValidation = validateEd25519PublicKey(args.publicKeyHex);
  if (!keyValidation.valid) {
    return { valid: false, failure: 'MALFORMED_PUBLIC_KEY' };
  }

  let publicKey: Ed25519PublicKey;
  try {
    publicKey = new Ed25519PublicKey(normalizePublicKey(args.publicKeyHex));
  } catch {
    return { valid: false, failure: 'MALFORMED_PUBLIC_KEY' };
  }

  let signature: Ed25519Signature;
  try {
    signature = new Ed25519Signature(normalizeSignature(args.signatureHex));
  } catch {
    return { valid: false, failure: 'MALFORMED_SIGNATURE' };
  }

  try {
    // `verifyBytes` treats the input as raw bytes and additionally rejects
    // non-canonical (malleable) S values, matching Aptos core.
    const valid = publicKey.verifyBytes({
      message: args.payload,
      signature,
    });
    return valid ? { valid: true } : { valid: false, failure: 'SIGNATURE_MISMATCH' };
  } catch {
    // e.g. the public key bytes are the right length but not a curve point.
    return { valid: false, failure: 'MALFORMED_PUBLIC_KEY' };
  }
}

/**
 * Compare two signer addresses for equality after canonicalization.
 *
 * Both sides must be well-formed long-form addresses; anything else is a
 * mismatch (fail closed).
 */
export function addressesMatch(a: string, b: string): boolean {
  if (!isValidAddress(a) || !isValidAddress(b)) return false;
  return a.slice(2).toLowerCase() === b.slice(2).toLowerCase();
}

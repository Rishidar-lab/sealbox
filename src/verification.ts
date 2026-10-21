import {
  SIGNED_PAYLOAD_VERSION,
  ED25519_SIGNATURE_SCHEME,
  addressesMatch,
  computeSha256,
  createSignedPayload,
  deriveSignerAddress,
  isValidAddress,
  isValidPublicKey,
  isValidSha256,
  isValidSignature,
  verifyEd25519Signature,
} from './crypto';
import {
  ManifestEntry,
  ManifestEntryV2,
  isLegacyEntry,
  isV2Entry,
} from './manifest';
import { SealboxError } from './errors';

/**
 * Verification outcomes.
 *
 * `PASS` is only returned when *every* mandatory stage succeeded:
 * content integrity, signature authenticity and signer consistency.
 */
export type VerificationStatus =
  /** All mandatory checks passed. */
  | 'PASS'
  /** No manifest record matches the requested seal ID. */
  | 'NOT_FOUND'
  /** The retrieved bytes do not match the recorded digest/size. */
  | 'TAMPERED'
  /** The Ed25519 signature is malformed or does not verify. */
  | 'INVALID_SIGNATURE'
  /** The signature verifies but the signer address does not match the key. */
  | 'SIGNER_MISMATCH'
  /** The manifest record is structurally invalid. */
  | 'INVALID_MANIFEST'
  /** The record uses a schema/payload/scheme version we do not support. */
  | 'UNSUPPORTED_SCHEMA'
  /** The stored object could not be retrieved. */
  | 'STORAGE_ERROR'
  /** A legacy (schema v1) record: integrity can be checked, authenticity cannot. */
  | 'LEGACY_UNVERIFIABLE_SIGNATURE'
  /** More than one manifest record matches the requested seal ID. */
  | 'AMBIGUOUS_SEAL_ID';

export interface VerificationResult {
  /** True only when `status === 'PASS'`. */
  ok: boolean;
  status: VerificationStatus;
  /** The seal ID that was requested. */
  sealId: string;
  /** True when the record predates manifest schema v2. */
  legacyRecord: boolean;
  /** True when the retrieved bytes hash to the recorded SHA-256. */
  integrityVerified: boolean;
  /** True only after a real Ed25519 verification succeeded. */
  signatureVerified: boolean;
  /** True when the stored signer address matches the public key's address. */
  signerVerified: boolean;
  /** Recorded SHA-256 digest. */
  sha256?: string;
  /** Recorded artifact size in bytes. */
  sizeBytes?: number;
  /** Recorded seal timestamp (signer-attested, not independently trusted). */
  sealedAt?: string;
  /** Recorded signer address. */
  signerAddress?: string;
  /** Stored public key, so a third party can verify independently. */
  signerPublicKey?: string;
  /** Block explorer URL. */
  explorerUrl?: string;
  /** Storage object name. */
  blobName?: string;
  /** Digest of the bytes that were actually retrieved (TAMPERED only). */
  actualSha256?: string;
  /** Human-readable explanation of the outcome. */
  detail: string;
}

/** Build the block-explorer URL for a stored object. */
export function explorerUrl(network: string, blobName: string): string {
  return `https://explorer.shelby.xyz/${network}/blob/${encodeURIComponent(blobName)}`;
}

/** What the verifier needs from the outside world. */
export interface VerificationInput {
  /** The manifest record under verification. */
  entry: ManifestEntry;
  /** Retrieves the stored object bytes. */
  retrieve: () => Promise<Buffer>;
}

function baseResult(
  entry: ManifestEntry,
  status: VerificationStatus,
  detail: string,
  ok: boolean,
): VerificationResult {
  return {
    ok,
    status,
    sealId: entry.sealId,
    legacyRecord: isLegacyEntry(entry),
    integrityVerified: false,
    signatureVerified: false,
    signerVerified: false,
    sha256: entry.sha256,
    sizeBytes: entry.sizeBytes,
    sealedAt: entry.sealedAt,
    signerAddress: entry.signerAddress,
    explorerUrl: entry.explorerUrl,
    blobName: entry.blobName,
    detail,
  };
}

/**
 * Validate the shape of a legacy (v1) record.
 *
 * Legacy records carry no public key, so the only thing that can be checked
 * is content integrity. The record is *not* treated as cryptographically
 * verified.
 */
async function verifyLegacyEntry(
  entry: ManifestEntry,
  retrieve: () => Promise<Buffer>,
): Promise<VerificationResult> {
  if (!isValidSha256(entry.sha256)) {
    return baseResult(
      entry,
      'INVALID_MANIFEST',
      'Legacy record has a malformed SHA-256 field.',
      false,
    );
  }
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
    return baseResult(
      entry,
      'INVALID_MANIFEST',
      'Legacy record has a malformed sizeBytes field.',
      false,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await retrieve();
  } catch (err) {
    return storageFailure(entry, err);
  }

  const actual = computeSha256(bytes);
  if (bytes.length !== entry.sizeBytes) {
    const result = baseResult(
      entry,
      'TAMPERED',
      `Stored object is ${bytes.length} bytes but the manifest records ${entry.sizeBytes}.`,
      false,
    );
    result.actualSha256 = actual;
    return result;
  }
  if (actual !== entry.sha256) {
    const result = baseResult(
      entry,
      'TAMPERED',
      'Stored object does not match the recorded SHA-256 digest.',
      false,
    );
    result.actualSha256 = actual;
    return result;
  }

  const result = baseResult(
    entry,
    'LEGACY_UNVERIFIABLE_SIGNATURE',
    'Legacy (schema v1) record: content integrity verified, but the record ' +
      'contains no public key, so the stored signature cannot be verified ' +
      'cryptographically. A legacy record cannot acquire a trustworthy ' +
      'historical signature retroactively.',
    false,
  );
  result.integrityVerified = true;
  return result;
}

/** Map a retrieval failure onto a typed verification status. */
function storageFailure(entry: ManifestEntry, err: unknown): VerificationResult {
  if (err instanceof SealboxError && err.code === 'NOT_FOUND') {
    return baseResult(
      entry,
      'NOT_FOUND',
      `Blob "${entry.blobName}" was not found in storage.`,
      false,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return baseResult(
    entry,
    'STORAGE_ERROR',
    `Could not retrieve the stored object: ${message}`,
    false,
  );
}

/**
 * Verify a manifest record end to end.
 *
 * Pipeline (all stages are mandatory for `PASS`):
 *
 *  1. validate the manifest record / schema;
 *  2. retrieve the stored object;
 *  3. rebuild the canonical signed payload from the recorded fields;
 *  4. cryptographically verify the Ed25519 signature over that payload;
 *  5. derive the signer address from the stored public key and compare it
 *     with the recorded signer address;
 *  6. confirm the retrieved bytes match the recorded size and SHA-256;
 *  7. confirm the derived values (seal ID prefix, explorer URL) still match
 *     the signed fields.
 *
 * Every stage is evaluated independently so that the report says exactly
 * which properties hold. The reported *status* is then chosen by priority:
 * a record that is not authenticated is reported as such even when other
 * properties also fail.
 */
export async function verifyEntry(
  input: VerificationInput,
): Promise<VerificationResult> {
  const { entry, retrieve } = input;

  if (isLegacyEntry(entry)) {
    return verifyLegacyEntry(entry, retrieve);
  }

  if (!isV2Entry(entry)) {
    return baseResult(
      entry,
      'INVALID_MANIFEST',
      'Manifest record is neither a legacy nor a v2 record.',
      false,
    );
  }

  // ── 1. schema / field validation ────────────────────────────────────────
  const schemaProblem = validateV2Record(entry);
  if (schemaProblem) {
    return baseResult(entry, schemaProblem.status, schemaProblem.detail, false);
  }

  // ── 2. retrieve ─────────────────────────────────────────────────────────
  let bytes: Buffer;
  try {
    bytes = await retrieve();
  } catch (err) {
    return storageFailure(entry, err);
  }

  const result = baseResult(entry, 'PASS', '', true);

  // ── 3. canonical signed payload ─────────────────────────────────────────
  let payload: Buffer;
  try {
    payload = createSignedPayload({
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      blobName: entry.blobName,
      sealedAt: entry.sealedAt,
      network: entry.network,
      signerPublicKey: entry.signerPublicKey,
    });
  } catch (err) {
    result.ok = false;
    result.status = 'INVALID_MANIFEST';
    result.detail = `Could not rebuild the canonical signed payload: ${(err as Error).message}`;
    return result;
  }

  // ── 4. real Ed25519 verification ───────────────────────────────────────
  const verification = verifyEd25519Signature({
    payload,
    signatureHex: entry.signature,
    publicKeyHex: entry.signerPublicKey,
  });
  if (verification.valid) {
    result.signatureVerified = true;
  }

  // ── 5. signer consistency ───────────────────────────────────────────────
  let derivedAddress: string | null = null;
  try {
    derivedAddress = deriveSignerAddress(entry.signerPublicKey);
  } catch {
    derivedAddress = null;
  }
  // The signer is only "verified" when the signature verified *and* the
  // recorded address matches the address derived from the public key. A
  // matching address on its own proves nothing — the signature is what binds
  // the key to this record.
  if (
    result.signatureVerified &&
    derivedAddress !== null &&
    addressesMatch(derivedAddress, entry.signerAddress)
  ) {
    result.signerVerified = true;
  }

  // ── 6. content integrity ────────────────────────────────────────────────
  const actualSha256 = computeSha256(bytes);
  const sizeMatches = bytes.length === entry.sizeBytes;
  const hashMatches = actualSha256 === entry.sha256;
  if (sizeMatches && hashMatches) {
    result.integrityVerified = true;
  } else {
    result.actualSha256 = actualSha256;
  }

  // ── 7. derived-value consistency ────────────────────────────────────────
  const sealIdConsistent = entry.sha256.startsWith(entry.sealId);
  const explorerUrlConsistent = entry.explorerUrl === explorerUrl(entry.network, entry.blobName);

  // ── status selection (by priority) ─────────────────────────────────────
  if (!result.signatureVerified) {
    result.ok = false;
    if (verification.failure === 'MALFORMED_PUBLIC_KEY') {
      result.status = 'INVALID_MANIFEST';
      result.detail = 'Stored signer public key is not a usable Ed25519 public key.';
    } else if (verification.failure === 'MALFORMED_SIGNATURE') {
      result.status = 'INVALID_SIGNATURE';
      result.detail = 'Stored signature is not a well-formed Ed25519 signature.';
    } else {
      result.status = 'INVALID_SIGNATURE';
      result.detail =
        'Ed25519 signature does not verify against the stored public key and the canonical signed payload.';
    }
    return result;
  }

  if (!result.integrityVerified) {
    result.ok = false;
    result.status = 'TAMPERED';
    result.detail = sizeMatches
      ? 'Stored object does not match the recorded SHA-256 digest.'
      : `Stored object is ${bytes.length} bytes but the manifest records ${entry.sizeBytes}.`;
    return result;
  }

  if (!result.signerVerified) {
    result.ok = false;
    result.status = 'SIGNER_MISMATCH';
    result.detail =
      derivedAddress === null
        ? 'Could not derive a signer address from the stored public key.'
        : 'The recorded signer address does not match the address derived from the stored public key.';
    return result;
  }

  if (!sealIdConsistent || !explorerUrlConsistent) {
    result.ok = false;
    result.status = 'INVALID_MANIFEST';
    result.detail = !sealIdConsistent
      ? 'Record seal ID is not a prefix of its SHA-256 digest.'
      : 'Record explorer URL does not match its network and blob name.';
    return result;
  }

  result.ok = true;
  result.status = 'PASS';
  result.detail =
    'Content integrity, Ed25519 signature authenticity and signer identity all verified.';
  result.signerPublicKey = entry.signerPublicKey;
  return result;
}

/**
 * Validate the structural fields of a v2 record.
 *
 * @returns a problem description, or `null` when the record is well-formed.
 */
function validateV2Record(
  entry: ManifestEntryV2,
): { status: VerificationStatus; detail: string } | null {
  if (entry.signedPayloadVersion !== SIGNED_PAYLOAD_VERSION) {
    return {
      status: 'UNSUPPORTED_SCHEMA',
      detail:
        `Record declares signed payload version "${entry.signedPayloadVersion}"; ` +
        `this build verifies version "${SIGNED_PAYLOAD_VERSION}".`,
    };
  }
  if (entry.signatureScheme !== ED25519_SIGNATURE_SCHEME) {
    return {
      status: 'UNSUPPORTED_SCHEMA',
      detail:
        `Record declares signature scheme "${entry.signatureScheme}"; ` +
        `this build verifies "${ED25519_SIGNATURE_SCHEME}".`,
    };
  }
  if (!isValidSha256(entry.sha256)) {
    return { status: 'INVALID_MANIFEST', detail: 'Record has a malformed SHA-256 field.' };
  }
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
    return { status: 'INVALID_MANIFEST', detail: 'Record has a malformed sizeBytes field.' };
  }
  if (typeof entry.blobName !== 'string' || entry.blobName.length === 0) {
    return { status: 'INVALID_MANIFEST', detail: 'Record has a malformed blobName field.' };
  }
  if (typeof entry.sealId !== 'string' || entry.sealId.length === 0) {
    return { status: 'INVALID_MANIFEST', detail: 'Record has a malformed sealId field.' };
  }
  if (typeof entry.network !== 'string' || entry.network.length === 0) {
    return { status: 'INVALID_MANIFEST', detail: 'Record has a malformed network field.' };
  }
  if (typeof entry.sealedAt !== 'string' || entry.sealedAt.length === 0) {
    return { status: 'INVALID_MANIFEST', detail: 'Record has a malformed sealedAt field.' };
  }
  if (!isValidPublicKey(entry.signerPublicKey)) {
    return { status: 'INVALID_MANIFEST', detail: 'Record has a malformed signerPublicKey field.' };
  }
  if (!isValidAddress(entry.signerAddress)) {
    return { status: 'INVALID_MANIFEST', detail: 'Record has a malformed signerAddress field.' };
  }
  if (!isValidSignature(entry.signature)) {
    return { status: 'INVALID_SIGNATURE', detail: 'Record has a malformed signature field.' };
  }
  return null;
}

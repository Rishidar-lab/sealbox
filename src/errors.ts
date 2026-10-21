/**
 * Typed errors surfaced to the user with actionable guidance.
 *
 * Every failure that reaches the CLI carries one of these codes so that
 * `--json` output is machine-readable and so that generic `false` values are
 * never used to represent a security-relevant failure.
 */
export type SealboxErrorCode =
  /** Account does not hold enough ShelbyUSD to pay for the upload. */
  | 'INSUFFICIENT_FUNDS'
  /** Request was rate limited by the storage provider. */
  | 'RATE_LIMITED'
  /** The requested object does not exist in the bucket. */
  | 'NOT_FOUND'
  /** Retrieved bytes do not match the recorded digest. */
  | 'TAMPERED'
  /** Generic network/transport failure. */
  | 'NETWORK'
  /** Local configuration problem (missing env var, bad path, ...). */
  | 'CONFIG'
  /** The storage endpoint rejected the supplied credentials (HTTP 401). */
  | 'AUTHENTICATION'
  /** The storage endpoint refused the operation (HTTP 403). */
  | 'AUTHORIZATION'
  /** The manifest file exists but cannot be parsed or violates its schema. */
  | 'MANIFEST_CORRUPT'
  /** A schema version that this build does not understand. */
  | 'UNSUPPORTED_SCHEMA'
  /** A manifest record is structurally invalid. */
  | 'INVALID_RECORD'
  /** More than one manifest record matches the requested seal ID. */
  | 'AMBIGUOUS_SEAL_ID';

export class SealboxError extends Error {
  constructor(
    message: string,
    public readonly code: SealboxErrorCode,
  ) {
    super(message);
    this.name = 'SealboxError';
  }
}

/**
 * TEST-ONLY FIXTURES.
 *
 * These Ed25519 keys are deterministic, publicly known and exist only in
 * this test suite. They are unfunded, are not used by any Sealbox release
 * and MUST NOT be used to seal real artifacts.
 *
 * Expected public keys and addresses are hard-coded on purpose: they are an
 * independent check that the SDK-derived values are stable, rather than a
 * tautology that re-derives them with the same code path under test.
 */

/** TEST FIXTURE — deterministic throwaway key A. */
export const TEST_PRIVATE_KEY_A = `0x${'11'.repeat(32)}`;
/** TEST FIXTURE — deterministic throwaway key B. */
export const TEST_PRIVATE_KEY_B = `0x${'22'.repeat(32)}`;
/** TEST FIXTURE — deterministic throwaway key C. */
export const TEST_PRIVATE_KEY_C = `0x${'33'.repeat(32)}`;

/** Expected public key for {@link TEST_PRIVATE_KEY_A}. */
export const TEST_PUBLIC_KEY_A =
  '0xd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737';
/** Expected Aptos authentication-key address for {@link TEST_PRIVATE_KEY_A}. */
export const TEST_ADDRESS_A =
  '0x147e4d3a5b10eaed2a93536e284c23096dfcea9ac61f0a8420e5d01fbd8f0ea8';

/** Expected public key for {@link TEST_PRIVATE_KEY_B}. */
export const TEST_PUBLIC_KEY_B =
  '0xa09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0';
/** Expected Aptos authentication-key address for {@link TEST_PRIVATE_KEY_B}. */
export const TEST_ADDRESS_B =
  '0xa32657fd60acb0433491a33d84823c04722ae76639b272873cc27d015232904e';

/** Expected public key for {@link TEST_PRIVATE_KEY_C}. */
export const TEST_PUBLIC_KEY_C =
  '0x17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce';
/** Expected Aptos authentication-key address for {@link TEST_PRIVATE_KEY_C}. */
export const TEST_ADDRESS_C =
  '0x121f5dc2e67b1c62df700496c9704904f45eac6ddf458452dbeef1cabdf4709f';

/**
 * A syntactically valid but cryptographically meaningless signature.
 *
 * This is the shape of the defect that sealbox v0.2.0 shipped with: a
 * non-empty signature string that was never cryptographically checked.
 */
export const BOGUS_SIGNATURE = `0x${'de'.repeat(64)}`;

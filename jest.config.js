/**
 * Jest configuration.
 *
 * `@aptos-labs/ts-sdk` v7 ships as native ESM only. Jest's CommonJS runtime
 * cannot load it untransformed, so the SDK and its ESM-only dependencies
 * (`@noble/*`, `@scure/*`) are transpiled to CommonJS by ts-jest.
 *
 * The cryptographic tests execute this real implementation — the SDK is
 * never mocked, because a mocked signature check would prove nothing.
 */
const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  transform: {
    ...tsJestTransformCfg,
    "^.+\\.m?js$": [
      "ts-jest",
      {
        tsconfig: {
          allowJs: true,
          checkJs: false,
          module: "CommonJS",
          target: "ES2022",
          esModuleInterop: true,
          moduleResolution: "node",
          isolatedModules: true,
        },
      },
    ],
  },
  transformIgnorePatterns: [
    "node_modules/(?!(@aptos-labs/ts-sdk|@noble|@scure|commander|dotenv)/)",
  ],
  testMatch: ["**/src/**/*.test.ts"],
  clearMocks: true,
};

# Contributing to sealbox

We love your input! We want to make contributing to this project as easy and
transparent as possible.

## Pull requests

1. Fork the repo and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. If you've changed APIs, update the documentation — including the README
   security claims, which must match the implementation exactly.
4. Ensure the checks pass (see below).
5. Make sure your commit messages follow [Conventional Commits](https://www.conventionalcommits.org/),
   e.g. `feat: add json output`, `fix: retry logic`.
6. Open the pull request.

## Development setup

```bash
git clone https://github.com/Rishidar-lab/sealbox.git
cd sealbox
npm ci
npm run typecheck
npm test
npm run build
```

## Checks

| command            | what it does                                  |
|--------------------|-----------------------------------------------|
| `npm run typecheck`| `tsc --noEmit`                                |
| `npm run lint`     | ESLint (flat config, `eslint.config.mjs`)     |
| `npm test`         | Jest                                          |
| `npm run build`    | `tsc` → `dist/`                               |

CI runs `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` and
`npm run build` on Node.js 22.

## Testing rules for this repository

The cryptographic core must **not** be mocked.

* `src/crypto.test.ts` and `src/security-regression.test.ts` exercise the real
  Ed25519 implementation with deterministic, clearly-fake test keys from
  `src/__fixtures__/keys.ts`. Those keys are unfunded and must never be used
  for a real seal.
* Mocking is acceptable for network and storage boundaries (S3, balances,
  fullnode reachability, faucets, live Shelby services).
* Mocking the signature check is **not** acceptable. A test that mocks
  `Ed25519PublicKey.verifyBytes()` proves nothing about verification.

## Secrets

Never commit `.env`, a private key, or an API key. `sealbox doctor` reports
only whether a key is configured. The optional `live-integration` workflow
reads its credentials from GitHub Secrets only.

## License

By contributing, you agree that your contributions will be licensed under the
project's MIT License.

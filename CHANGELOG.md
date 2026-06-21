# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-06-21
### Added
- Live Early-Access ready integration with Shelby.
- `sealbox doctor` command for preflight environment checks.
- `--json` flag across all commands for easier scripting.
- Exponential backoff and retry logic for S3/network operations.
- Clear error surfacing for insufficient funds and rate limits.
- Atomic writes and sha256 deduplication in the local manifest.
- Optional live-integration GitHub Actions job.
- Comprehensive documentation: live walkthrough in README, SECURITY.md, CONTRIBUTING.md.

## [0.1.0] - 2026-06-21
### Added
- Initial release.
- Core `seal`, `verify`, and `list` commands.
- Mock-tested scaffold with basic S3 upload and Ed25519 signing.

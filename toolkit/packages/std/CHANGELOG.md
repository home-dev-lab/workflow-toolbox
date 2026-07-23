# Changelog

All notable changes to `@workflow-toolbox/std` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-07-12

### Added

- Initial release. Small, dependency-light utilities shared across the
  `@workflow-toolbox` packages: runtime type-narrowers for parsing untrusted JSON, and an
  effort-tier resolver for reading per-role reasoning-effort overrides out of a workflow's
  launch config. Backs `@workflow-toolbox/patterns` and `@workflow-toolbox/build`, and is
  published standalone for reuse by any tool that parses agent/runtime output.

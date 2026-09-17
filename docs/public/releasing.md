# Release procedure

Run these steps from `toolkit/` before a plugin release.

1. Run `pnpm quality`. Treat `quality:coverage` as the release's single coverage-enabled full-suite invocation; do not run it beside another Vitest process.
2. Run `pnpm quality:delta`. Copy its Markdown table verbatim into `plugin/CHANGELOG.md` as the release entry's `### Quality` section. Do not compose that section by hand.
3. Improve at least one quality ratchet. A lower maximum is an improvement for size, complexity, duplication, dead code, and cycles; a higher minimum is an improvement for coverage.
4. Run `pnpm quality:baseline`. Review and stage the generated toolkit quality baseline.
5. Create the `release:` commit and tag it `workflow-toolbox--v<version>`.

The release-record guard blocks a `release:` commit when the staged changelog does not add a
`### Quality` section or no baseline ratchet improved since the previous plugin tag. If a measured
release exception is unavoidable, add `gates: quality-skipped — <reason>` to the commit message.
The guard records that escape instead of silently weakening a ratchet.

Coverage includes `toolkit/packages/*/src/**` and `plugin/bin/**/*.mjs`. It excludes tests,
fixtures, generated `dist` output, and fixture executables because those are test inputs or build
artifacts rather than shipped source. Vitest, jscpd, knip, ESLint, and dependency-cruiser are Node
tools and use path APIs in the quality wrapper; the same commands are expected to run on Linux,
macOS, and Windows without POSIX shell pipelines.

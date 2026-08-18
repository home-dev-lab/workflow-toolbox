// cli-bundle-smoke.test.ts — guards the PUBLISHED `workflow-toolbox` bin's bundle.
//
// Why this exists: the scaffold / debug / report subcommands in src/cli.ts are
// implemented by importing the PRIVATE workspace packages @workflow-toolbox/scaffold
// and @workflow-toolbox/debugger; the pipeline subcommand (I5 authoring increment)
// similarly depends on @workflow-toolbox/pipeline-spec via bundle-pipeline.ts. All of these
// are devDependencies, so tsup BUNDLES their code into dist/cli.js at publish time (only
// `dependencies` — @workflow-toolbox/runtime and esbuild — stay external). A code comment in
// cli.ts asserts "no bare imports survive in the bundle", but nothing tested it: the rest of
// the suite runs the SOURCE (tsx src/cli.ts) and only exercises build + check. A refactor
// that reintroduced an unbundled bare import to a private package would ship a published bin
// that 404s / MODULE_NOT_FOUNDs on `npx workflow-toolbox scaffold` — invisible to the
// source-level gates. This test builds the real tsup bundle and proves the guarantee,
// end-to-end.
import * as cp from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(PACKAGE_ROOT, 'dist')
const BUNDLE = path.join(DIST, 'cli.js')

// The workspace packages whose code MUST be inlined (never left as a bare specifier) in
// the published bundle: every @workflow-toolbox/* sibling that this package does NOT
// declare as a runtime dependency. A consumer installs only what `dependencies` names, so
// a bare import of anything else is unresolvable for them.
//
// ⚠ DERIVED, never listed. This was a hardcoded array and it went stale twice over:
// @workflow-toolbox/pipeline-spec was named "private" after it had been published, and
// @workflow-toolbox/std likewise. The list stayed correct-looking, and the assertion built
// on it turned red on a CORRECT fix — a dependency move that made the package legitimately
// external — which cost a revert and an afternoon (card 1844397188394779824).
//
// ⚠ Note the criterion is NOT "is it published". @workflow-toolbox/std IS published and
// still must be inlined here, because `build` does not depend on it: a consumer installing
// `build` gets no `std`. What decides is the dependency edge, not the registry.
const WORKSPACE_SCOPE = '@workflow-toolbox/'
const buildManifest = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
) as { dependencies?: Record<string, string> }
const DECLARED_DEPS = new Set(Object.keys(buildManifest.dependencies ?? {}))
const PRIVATE_PACKAGES = fs
  .readdirSync(path.join(PACKAGE_ROOT, '..'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `${WORKSPACE_SCOPE}${e.name}`)
  .filter((name) => name !== `${WORKSPACE_SCOPE}build` && !DECLARED_DEPS.has(name))

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Build the real published artifact (tsup → dist/). dist/ is gitignored and built on
// demand, so producing it here is the point, not a side effect. Generous timeout: tsup
// emits three entry points plus .d.ts.
//
// Spawn target = node + tsup's OWN bin JS entry, resolved from this package — NOT
// `execFileSync('pnpm', ['run', 'build'], ...)`: on Windows the pnpm shim is a .cmd
// file, which Node (>=18.20, CVE-2024-27980) refuses to spawn without shell:true. node
// + a resolved .js runs identically on every OS (same pattern as observe-cli.ts's tsx spawn).
beforeAll(() => {
  const require = createRequire(path.join(PACKAGE_ROOT, 'package.json'))
  const tsupPkgJson = require.resolve('tsup/package.json')
  const tsupBin = (JSON.parse(fs.readFileSync(tsupPkgJson, 'utf8')) as { bin: { tsup: string } }).bin.tsup
  const tsupCli = path.join(path.dirname(tsupPkgJson), tsupBin)
  cp.execFileSync(process.execPath, [tsupCli], { cwd: PACKAGE_ROOT, stdio: 'pipe' })
}, 180_000)

afterAll(() => {
  // Leave dist/ in place if it was already there; we don't own its lifecycle and other
  // tooling rebuilds it on demand. Nothing to clean — the build is idempotent.
})

describe('published CLI bundle — undeclared workspace deps are inlined, declared ones may be external', () => {
  it('tsup emitted the cli bundle', () => {
    expect(fs.existsSync(BUNDLE)).toBe(true)
  })

  it('no bare import/require of a private @workflow-toolbox package survives the bundle', () => {
    // Scan every emitted .js (tsup may split shared code into chunk-*.js).
    const src = fs
      .readdirSync(DIST)
      .filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(DIST, f), 'utf8'))
      .join('\n')

    for (const pkg of PRIVATE_PACKAGES) {
      const esc = escapeRe(pkg)
      // Match the package root OR any subpath import (e.g. .../debugger/source), bounded
      // by the closing quote or a `/`, so a longer differently-named package can't match.
      const importRe = new RegExp(`from\\s*["']${esc}(["'/])`)
      const requireRe = new RegExp(`require\\(\\s*["']${esc}(["'/])`)
      expect(src, `bare ESM import of ${pkg} survived the bundle`).not.toMatch(importRe)
      expect(src, `bare require of ${pkg} survived the bundle`).not.toMatch(requireRe)
    }
  })

  // Each consumer subcommand must LOAD from the built bundle and dispatch into its
  // (bundled) handler without a module-resolution failure. Run with no args: the handler
  // throws a clean argument error — which proves the code is present and reachable —
  // rather than ERR_MODULE_NOT_FOUND, which is what a broken bundle would throw on load.
  // ⚠ A CONSUMER SANDBOX, not this workspace. ESM resolves a bare specifier from the importing
  // FILE's location upward, never from cwd — so running the bundle in place always resolves
  // @workflow-toolbox/* through the workspace links, whose `exports` point at TypeScript SOURCE.
  // node cannot load that from a built artifact, and the failure looks exactly like a broken
  // bundle. (The old `cwd: PACKAGE_ROOT` comment claimed cwd governed this. It does not.)
  //
  // So: copy dist/ somewhere neutral and give it a node_modules holding each externalized
  // workspace dependency as its PUBLISHED shape — the manifest from that package's own
  // `publishConfig`, pointing at its built dist. Nearest node_modules wins, and a symlink to the
  // real one behind it still resolves third-party deps like esbuild. Offline, deterministic, and
  // it exercises the resolution a consumer actually gets.
  const consumerSandbox = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cli-consumer-'))
    const pkgDir = path.join(root, 'pkg')
    fs.mkdirSync(pkgDir, { recursive: true })
    for (const f of fs.readdirSync(DIST)) fs.copyFileSync(path.join(DIST, f), path.join(pkgDir, f))
    const nm = path.join(pkgDir, 'node_modules', '@workflow-toolbox')
    fs.mkdirSync(nm, { recursive: true })
    for (const dep of DECLARED_DEPS) {
      if (!dep.startsWith(WORKSPACE_SCOPE)) continue
      const name = dep.slice(WORKSPACE_SCOPE.length)
      const src = path.join(PACKAGE_ROOT, '..', name)
      const manifest = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')) as Record<string, unknown>
      const published = (manifest.publishConfig ?? {}) as Record<string, unknown>
      const target = path.join(nm, name)
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(
        path.join(target, 'package.json'),
        JSON.stringify({ name: manifest.name, version: manifest.version, type: manifest.type, ...published }, null, 2),
      )
      fs.symlinkSync(path.join(src, 'dist'), path.join(target, 'dist'), 'dir')
    }
    // Third-party deps (esbuild) resolve one level further up, through THIS package's own
    // node_modules — pnpm installs per package, so the workspace root does not carry them.
    // The shims above sit nearer and therefore still win for @workflow-toolbox/*.
    fs.symlinkSync(path.join(PACKAGE_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir')
    return path.join(pkgDir, 'cli.js')
  }

  for (const cmd of ['scaffold', 'debug', 'report', 'pipeline']) {
    it(`\`${cmd}\` loads from the bundle and dispatches (no MODULE_NOT_FOUND)`, () => {
      const res = cp.spawnSync(process.execPath, [consumerSandbox(), cmd], {
        encoding: 'utf8',
      })
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
      expect(out).not.toMatch(/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find (package|module)/i)
      // Positive check: dispatch actually reached the subcommand's bundled handler.
      expect(out).toMatch(new RegExp(`workflow-toolbox ${cmd}|${cmd}`, 'i'))
    })
  }
})

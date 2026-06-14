// cli-bundle-smoke.test.ts — guards the PUBLISHED `workflow-toolbox` bin's bundle.
//
// Why this exists: the scaffold / debug / report subcommands in src/cli.ts are
// implemented by importing the PRIVATE workspace packages @workflow-toolbox/scaffold
// and @workflow-toolbox/debugger. Those are devDependencies, so tsup BUNDLES their
// code into dist/cli.js at publish time (only `dependencies` — @workflow-toolbox/runtime
// and esbuild — stay external). A code comment in cli.ts asserts "no bare imports survive
// in the bundle", but nothing tested it: the rest of the suite runs the SOURCE
// (tsx src/cli.ts) and only exercises build + check. A refactor that reintroduced an
// unbundled bare import to a private package would ship a published bin that 404s /
// MODULE_NOT_FOUNDs on `npx workflow-toolbox scaffold` — invisible to the source-level
// gates. This test builds the real tsup bundle and proves the guarantee, end-to-end.
import * as cp from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(PACKAGE_ROOT, 'dist')
const BUNDLE = path.join(DIST, 'cli.js')

// The private workspace packages whose code MUST be inlined (never left as a bare
// specifier) in the published bundle. @workflow-toolbox/runtime is intentionally NOT
// here — it is a real `dependency` and correctly stays external.
const PRIVATE_PACKAGES = [
  '@workflow-toolbox/scaffold',
  '@workflow-toolbox/debugger',
  '@workflow-toolbox/std',
]

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Build the real published artifact (tsup → dist/). dist/ is gitignored and built on
// demand, so producing it here is the point, not a side effect. Generous timeout: tsup
// emits three entry points plus .d.ts.
beforeAll(() => {
  cp.execFileSync('pnpm', ['run', 'build'], { cwd: PACKAGE_ROOT, stdio: 'pipe' })
}, 180_000)

afterAll(() => {
  // Leave dist/ in place if it was already there; we don't own its lifecycle and other
  // tooling rebuilds it on demand. Nothing to clean — the build is idempotent.
})

describe('published CLI bundle — private workspace deps are inlined, not externalized', () => {
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
  for (const cmd of ['scaffold', 'debug', 'report']) {
    it(`\`${cmd}\` loads from the bundle and dispatches (no MODULE_NOT_FOUND)`, () => {
      const res = cp.spawnSync(process.execPath, [BUNDLE, cmd], {
        cwd: PACKAGE_ROOT, // so the external deps (runtime, esbuild) resolve via the package's node_modules
        encoding: 'utf8',
      })
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
      expect(out).not.toMatch(/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find (package|module)/i)
      // Positive check: dispatch actually reached the subcommand's bundled handler.
      expect(out).toMatch(new RegExp(`workflow-toolbox ${cmd}|${cmd}`, 'i'))
    })
  }
})

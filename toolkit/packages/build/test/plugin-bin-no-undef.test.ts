import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_BIN = join(REPO_ROOT, 'plugin/bin')

// The plugin's runtime scripts are `.mjs` and live OUTSIDE the toolkit, so nothing
// checked them for undefined references:
//
//   - `pnpm lint` runs `eslint .` from toolkit/, and ESLint refuses to lint outside
//     its base path (the cwd), so plugin/bin was never in scope;
//   - the shared config is `tseslint.configs.recommended`, which disables `no-undef`
//     because tsc covers `.ts` — nothing covers `.mjs`;
//   - `node --check` sees syntax only, and an undefined reference is valid syntax.
//
// Measured 2026-08-27, merging main into a long-lived branch: a function renamed on
// one side kept its OLD call sites on the other, and auto-merge produced no conflict
// marker because those lines were touched by only one side. Test, typecheck and lint
// were all green with the symbol undefined — inside a FAIL-OPEN hook, so the resulting
// ReferenceError would have been swallowed and the failure the hook exists to record
// would have vanished.
//
// This runs ESLint through its Node API rather than the CLI precisely because the API
// takes an explicit `cwd`: that is what lets the base path be the repo root while the
// dependency resolves from toolkit/. It is also why this is a test rather than a second
// `lint` script — a `cd ..` in a package script is one more thing to get wrong on a
// platform we do not develop on.
const NODE_GLOBALS = [
  '__dirname', '__filename', 'AbortController', 'AbortSignal', 'Buffer', 'clearImmediate',
  'clearInterval', 'clearTimeout', 'console', 'fetch', 'globalThis', 'performance', 'process',
  'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout', 'structuredClone',
  'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams',
]

function noUndefConfig(pattern: string) {
  const globals: Record<string, 'readonly'> = {}
  for (const name of NODE_GLOBALS) globals[name] = 'readonly'
  return [
    {
      files: [pattern],
      languageOptions: { ecmaVersion: 2023 as const, sourceType: 'module' as const, globals },
      rules: { 'no-undef': 'error' as const },
    },
  ]
}

async function undefinedReferencesIn(cwd: string, target: string, pattern: string) {
  const eslint = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: noUndefConfig(pattern) })
  const results = await eslint.lintFiles([target])
  return results.flatMap((r) =>
    r.messages
      .filter((m) => m.ruleId === 'no-undef')
      .map((m) => `${r.filePath.slice(cwd.length)}:${m.line} ${m.message}`),
  )
}

describe('plugin/bin carries no undefined references', () => {
  const roots: string[] = []
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  it('reports nothing across the whole directory', async () => {
    expect(await undefinedReferencesIn(REPO_ROOT, PLUGIN_BIN, 'plugin/bin/**/*.mjs')).toEqual([])
  })

  // The lock's own red proof, run on every suite rather than once by hand: a check whose
  // ability to fail is never exercised is decoration, and this one guards a defect class
  // that produced no other visible signal.
  //
  // ⚠ The mutation happens on a COPY in a temp directory, never on the working tree. A
  // suite that rewrites a real file leaves it rewritten when it is interrupted, and under
  // a parallel run the tests that SPAWN these hooks would read the broken version.
  it('reports the defect when a call site names a function that does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-no-undef-'))
    roots.push(root)
    const dir = join(root, 'scripts')
    mkdirSync(dir, { recursive: true })

    // Reproduce the real shape: rename the DEFINITION and leave every caller behind.
    // `String.replace` with a string pattern hits the first occurrence only, which is the
    // declaration — so the callers below it become dangling, exactly as they did when one
    // side of a merge renamed the function and the other side kept calling the old name.
    //
    // ⚠ The assertion checks the PROPERTY (an undefined reference is reported), never a
    // particular spelling. An earlier version asserted the new name appeared in the output
    // and passed on one branch and failed on another — the mutation was doing something
    // other than what its comment claimed, and only running it against a second tree showed
    // that. A red proof whose mutation is not itself verified proves nothing.
    const original = readFileSync(join(PLUGIN_BIN, 'wt-actionable-snapshot-producer-hook.mjs'), 'utf8')
    expect(original).toContain('function recordAttempt(')
    const mutated = original.replace('function recordAttempt(', 'function recordAttemptRenamed(')
    expect(mutated).not.toBe(original)

    const victim = join(dir, 'hook.mjs')
    writeFileSync(victim, mutated, 'utf8')

    const found = await undefinedReferencesIn(root, victim, '**/*.mjs')
    expect(found.length).toBeGreaterThan(0)
    expect(found.join('\n')).toContain('recordAttempt')
  })
})

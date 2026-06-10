// plugin-integration.test.ts — anti-drift tests binding the plugin to the toolkit.
//
// lint.ts started life as a port of the plugin's validate-workflow.mjs, then
// gained the quoted-key extension for serialized meta (M3) — and the .mjs
// silently drifted: it false-positived on every toolkit-built artifact until M6
// backported the extension. These tests pin the alignment so drift in either
// direction goes red instead of unnoticed:
//
//   1. Verdict parity: the plugin's .mjs CLI and lintWorkflowSource() agree
//      (pass/fail + error count) on a fixture set covering every lint rule,
//      bare-key and serialized-quoted-key forms alike.
//   2. Every committed artifact under toolkit/workflows/ passes the plugin's
//      linter (the exact M6 acceptance criterion).
//   3. The toolkit composition SOURCES shipped as reading material under the
//      workflow-composer skill's assets/examples/toolkit/ are byte-identical
//      to their toolkit/examples/ sources of truth (P3.9).
//
// The .mjs is exercised as a real child process — its CLI behaviour (exit
// codes, report format) is the contract users see, not its internals.

import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { lintWorkflowSource } from '../src/lint.js'

// ---------------------------------------------------------------------------
// Paths — the repo root is 4 levels up from this test directory
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_LINTER = join(
  REPO_ROOT,
  'plugin/skills/workflow-composer/scripts/validate-workflow.mjs',
)
const TOOLKIT_WORKFLOWS_DIR = join(REPO_ROOT, 'toolkit/workflows')
const TOOLKIT_EXAMPLES_DIR = join(REPO_ROOT, 'toolkit/examples')
const SKILL_TOOLKIT_EXAMPLES_DIR = join(
  REPO_ROOT,
  'plugin/skills/workflow-composer/assets/examples/toolkit',
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = mkdtempSync(join(tmpdir(), 'wt-plugin-lint-'))
let fixtureCounter = 0

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true })
})

/** Run the plugin's validate-workflow.mjs CLI on a source string. */
function runPluginLinter(src: string): { passed: boolean; errorCount: number } {
  const file = join(TMP_DIR, `fixture-${fixtureCounter++}.js`)
  writeFileSync(file, src, 'utf8')
  const res = spawnSync(process.execPath, [PLUGIN_LINTER, file], {
    encoding: 'utf8',
  })
  const errorCount = (res.stdout.match(/^ {2}ERROR /gm) ?? []).length
  return { passed: res.status === 0, errorCount }
}

/** Run the plugin's linter on an existing file path. */
function runPluginLinterOnFile(path: string): { passed: boolean; stdout: string } {
  const res = spawnSync(process.execPath, [PLUGIN_LINTER, path], {
    encoding: 'utf8',
  })
  return { passed: res.status === 0, stdout: res.stdout }
}

// ---------------------------------------------------------------------------
// 1. Verdict parity — .mjs CLI vs lintWorkflowSource on the same fixtures
// ---------------------------------------------------------------------------

/** [label, source] — one fixture per lint rule, in both meta key styles. */
const PARITY_FIXTURES: Array<[string, string]> = [
  [
    'clean hand-written workflow (bare keys)',
    `export const meta = {
  name: 'wf',
  description: 'a workflow',
}
const r = await agent('do it')
return r
`,
  ],
  [
    'clean serialized meta (JSON-quoted keys, bundler shape)',
    `export const meta = {
  "name": "wf",
  "description": "a toolkit-built workflow"
};
var __wt = (() => { var x = {}; return x; })();
return await __wt.default.run({ agent, parallel, pipeline, phase, log, budget, workflow }, args)
`,
  ],
  [
    'missing name (bare keys)',
    `export const meta = {
  description: 'no name here',
}
return 1
`,
  ],
  [
    'missing name (quoted keys)',
    `export const meta = {
  "description": "no name here"
};
return 1
`,
  ],
  [
    'reserved key __proto__ (quoted — the serialized escape hatch)',
    `export const meta = {
  "name": "wf",
  "description": "sneaky",
  "__proto__": { "x": 1 }
};
return 1
`,
  ],
  [
    'code before meta',
    `const early = 1
export const meta = {
  name: 'wf',
  description: 'late meta',
}
return early
`,
  ],
  [
    'banned non-deterministic call',
    `export const meta = {
  name: 'wf',
  description: 'uses Date.now',
}
return Date.now()
`,
  ],
  [
    'meta with spread (not a pure literal)',
    `export const meta = {
  name: 'wf',
  description: 'spread inside',
  ...extra,
}
return 1
`,
  ],
  // P3.9 review fix: the fixtures below close the parity gaps the adversarial
  // review found — R4b/R4c/the other R7 calls/R8/R9 had no parity coverage.
  [
    'meta with template literal (R4b)',
    'export const meta = {\n  name: `wf`,\n  description: \'template in meta\',\n}\nreturn 1\n',
  ],
  [
    'meta with function call (R4c)',
    `export const meta = {
  name: makeName(),
  description: 'call in meta',
}
return 1
`,
  ],
  [
    'banned Math.random() (R7)',
    `export const meta = {
  name: 'wf',
  description: 'uses Math.random',
}
return Math.random()
`,
  ],
  [
    'banned argless new Date() (R7)',
    `export const meta = {
  name: 'wf',
  description: 'uses new Date()',
}
return new Date()
`,
  ],
  [
    'host import — warning only, exits clean (R8)',
    `export const meta = {
  name: 'wf',
  description: 'imports a module',
}
import fs from 'node:fs'
return 1
`,
  ],
  [
    'mixed thunk/bare parallel array — warning only, exits clean (R9)',
    `export const meta = {
  name: 'wf',
  description: 'mixed parallel array',
}
const r = await parallel([() => agent('a'), agent('b')])
return r
`,
  ],
]

describe('plugin linter ↔ lintWorkflowSource verdict parity', () => {
  for (const [label, src] of PARITY_FIXTURES) {
    it(`agrees on: ${label}`, () => {
      const toolkit = lintWorkflowSource(src)
      const plugin = runPluginLinter(src)

      expect(plugin.passed).toBe(toolkit.errors.length === 0)
      expect(plugin.errorCount).toBe(toolkit.errors.length)
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Every committed toolkit artifact passes the plugin's linter
// ---------------------------------------------------------------------------

describe('plugin linter accepts committed toolkit artifacts', () => {
  const artifacts = readdirSync(TOOLKIT_WORKFLOWS_DIR).filter((f) => f.endsWith('.js'))

  it('finds the committed artifacts', () => {
    expect(artifacts.length).toBeGreaterThanOrEqual(4)
  })

  for (const file of artifacts) {
    it(`passes ${file}`, () => {
      const { passed, stdout } = runPluginLinterOnFile(join(TOOLKIT_WORKFLOWS_DIR, file))
      expect(stdout).not.toMatch(/ERROR/)
      expect(passed).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// 3. Toolkit composition sources shipped as skill reading material match
//    toolkit/examples/ — a different directory pair from §2 (built artifacts):
//    these are the .workflow.ts SOURCES (pedagogical reading in the
//    workflow-composer skill), not built artifacts. Copies are made by hand at
//    ship time; this pins them.
// ---------------------------------------------------------------------------

describe('skill-shipped toolkit composition sources match toolkit/examples/', () => {
  const SHIPPED_COMPOSITIONS = [
    'pr-review.workflow.ts',
    'monorepo-refactor-plan.workflow.ts',
    'monorepo-refactor-execute.workflow.ts',
    'doc-rewrite.workflow.ts',
  ]

  for (const file of SHIPPED_COMPOSITIONS) {
    it(`${file} is byte-identical in both locations`, () => {
      const toolkitCopy = readFileSync(join(TOOLKIT_EXAMPLES_DIR, file), 'utf8')
      const skillCopy = readFileSync(join(SKILL_TOOLKIT_EXAMPLES_DIR, file), 'utf8')
      expect(skillCopy).toBe(toolkitCopy)
    })
  }
})

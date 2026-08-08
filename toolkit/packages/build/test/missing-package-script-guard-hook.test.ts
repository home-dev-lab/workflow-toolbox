import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-missing-package-script-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

function run(command: string, cwd: string) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      cwd,
    }),
    encoding: 'utf8',
  })
  return {
    // Warn-only guard: `warned` means the predicate matched and a non-blocking reason was
    // emitted via permissionDecision: 'allow'. `denied` must NEVER be true for this hook.
    warned: res.stdout.includes('WARNING (not blocked)'),
    denied: res.stdout.includes('"deny"'),
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
  }
}

describe('wt-missing-package-script-guard-hook', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wt-script-guard-'))
    // Root package.json defines test/typecheck/lint (mirrors this project's toolkit/package.json).
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', scripts: { test: 'vitest run', typecheck: 'tsc', lint: 'eslint .' } }),
    )
    // Sub-package with NO lint script (mirrors toolkit/packages/smoke/package.json in this repo,
    // which defines typecheck but no test, no lint).
    mkdirSync(join(root, 'packages', 'smoke'), { recursive: true })
    writeFileSync(join(root, 'packages', 'smoke', 'package.json'), JSON.stringify({ name: 'smoke', scripts: { typecheck: 'tsc' } }))
    // A directory with no package.json at all.
    mkdirSync(join(root, 'no-pkg'), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // ---- REAL, harvested verbatim from this repo's own docs / package.json scripts ----

  it('REAL (CLAUDE.md): silent — `pnpm test && pnpm typecheck && pnpm lint` from the root, all three exist', () => {
    const r = run('pnpm test && pnpm typecheck && pnpm lint', root)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('REAL (CLAUDE.md): silent — `pnpm install` (not a script lookup)', () => {
    const r = run('pnpm install', root)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('REAL (upgrade-canary SKILL.md): silent — `cd toolkit && pnpm canary:version` shape, cd resolves and script exists at target', () => {
    mkdirSync(join(root, 'toolkit'), { recursive: true })
    writeFileSync(join(root, 'toolkit', 'package.json'), JSON.stringify({ scripts: { 'canary:version': 'tsx x.ts' } }))
    const r = run(`cd ${join(root, 'toolkit')} && pnpm canary:version`, root)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('REAL (toolkit-scaffold SKILL.md): silent — `pnpm add -D @workflow-toolbox/runtime ...` (not a script lookup)', () => {
    const r = run('pnpm add -D @workflow-toolbox/runtime @workflow-toolbox/patterns @workflow-toolbox/build', root)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('REAL (toolkit-scaffold SKILL.md): silent — `pnpm exec workflow-toolbox …` (not a script lookup)', () => {
    const r = run('pnpm exec workflow-toolbox build x.workflow.ts --typecheck', root)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it("REAL (toolkit/package.json build:dist script value): silent — `pnpm --filter ... run build` (workspace-aware flag)", () => {
    const r = run('pnpm --filter @workflow-toolbox/runtime --filter @workflow-toolbox/patterns run build', root)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it("REAL (toolkit/package.json typecheck script value): silent — `pnpm -r typecheck` (workspace-aware flag)", () => {
    const r = run('pnpm -r typecheck', root)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  // ---- CONSTRUCTED-REAL: real command syntax + real repo layout (toolkit/packages/smoke has
  // no `lint` script), producing the genuine true-positive shape this guard exists for. No doc
  // states the MISTAKE itself — that is exactly what a guard exists to catch.

  it('CONSTRUCTED-REAL: warns — `pnpm lint` from a sub-package that has no lint script, points to the root', () => {
    const r = run('pnpm lint', join(root, 'packages', 'smoke'))
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.stdout).toContain('lint')
    expect(r.stdout).toContain(root)
    expect(r.status).toBe(0)
  })

  it('CONSTRUCTED-REAL: warns — `cd packages/smoke && pnpm test` (test also missing there), cd-tracked', () => {
    const r = run('cd packages/smoke && pnpm test', root)
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.stdout).toContain('test')
    expect(r.status).toBe(0)
  })

  // ---- INVENTED: synthetic edge cases exercising the cd-tracking / parsing machinery itself ----

  it('INVENTED: silent — no package.json anywhere up the tree', () => {
    const r = run('pnpm test', join(root, 'no-pkg', '..', '..', '..'))
    expect(r.status).toBe(0)
  })

  it('INVENTED: silent — the exact false-positive shape this port fixes: `cd toolkit && pnpm test`, tool cwd is elsewhere', () => {
    mkdirSync(join(root, 'toolkit'), { recursive: true })
    writeFileSync(join(root, 'toolkit', 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    const r = run(`cd ${join(root, 'toolkit')} && pnpm test`, tmpdir())
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: warns — two cumulative cds land on the sub-package missing the script', () => {
    const r = run(`cd ${root} && cd packages/smoke && pnpm lint`, tmpdir())
    expect(r.warned).toBe(true)
  })

  it('INVENTED: silent — `cd -` makes the directory untrusted', () => {
    const r = run('cd - && pnpm lint', join(root, 'packages', 'smoke'))
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: silent — `cd "$SOMEVAR"` makes the directory untrusted', () => {
    const r = run('cd "$SOMEVAR" && pnpm lint', join(root, 'packages', 'smoke'))
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: silent — `cd $(dirname .)` makes the directory untrusted', () => {
    const r = run('cd $(dirname .) && pnpm lint', join(root, 'packages', 'smoke'))
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: silent — a subshell/parenthesized segment is not modeled', () => {
    const r = run('(cd packages/smoke && pnpm lint)', root)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: silent — cd to a nonexistent directory', () => {
    const r = run('cd /does/not/exist && pnpm lint', root)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: silent — an absolute-path cd LATER in the chain recovers after an unresolvable one', () => {
    const r = run(`cd "$SOMEVAR" && cd ${root} && pnpm test`, tmpdir())
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: silent — a genuine typo with no ancestor defining it either', () => {
    const r = run('pnpm totally-made-up-script', root)
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('genuine typo')
  })

  it('INVENTED: silent — "pnpm lint" mentioned inside a quoted commit message is not a real invocation', () => {
    // Without quote stripping, splitting on `;` would cut INSIDE this quoted string, producing a
    // spurious `pnpm lint` segment — a false positive. Same discipline as the merge-chain guard.
    const r = run('git commit -m "before; pnpm lint; after"', join(root, 'packages', 'smoke'))
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: silent — "pnpm lint" inside a heredoc body is not a real invocation', () => {
    const r = run(["git commit -F - <<'MSG'", 'run pnpm lint from the sub-package', 'MSG'].join('\n'), join(root, 'packages', 'smoke'))
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: silent — a direct binary path is not a script lookup', () => {
    const r = run('node_modules/.bin/vite build', join(root, 'packages', 'smoke'))
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: silent — npx is not a tracked package manager', () => {
    const r = run('npx workflow-toolbox scaffold spec.json --out-dir .', join(root, 'packages', 'smoke'))
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('INVENTED: stays out of the way for an ordinary command with no pnpm/npm/yarn', () => {
    const r = run('git status', root)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Bash')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) => h.command?.includes('wt-missing-package-script-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})

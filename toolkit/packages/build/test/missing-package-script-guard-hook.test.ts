import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-missing-package-script-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

function run(command: string, cwd: string, extraEnv: Record<string, string> = {}, agentId?: string) {
  const journalDir = mkdtempSync(join(tmpdir(), 'wt-missing-script-journal-'))
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        cwd,
        ...(agentId ? { agent_id: agentId } : {}),
      }),
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv, WT_GUARD_JOURNAL_DIR: journalDir },
    })
    const entries = readdirSync(journalDir)
      .filter((file) => file.endsWith('.ndjson'))
      .flatMap((file) =>
        readFileSync(join(journalDir, file), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      )
    return {
      // Detection is journaled; the stdout notice (when any) is context-only.
      warned: entries.some((entry) => entry.decision === 'warned'),
      denied: res.stdout.includes('"deny"'),
      stdout: res.stdout,
      stderr: res.stderr,
      status: res.status,
      entries,
    }
  } finally {
    rmSync(journalDir, { recursive: true, force: true })
  }
}

let root = ''

function setupPackageRoot(): void {
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
}

function setupNoticeRoot(): void {
  root = mkdtempSync(join(tmpdir(), 'wt-script-notice-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', scripts: { lint: 'eslint .' } }))
  mkdirSync(join(root, 'packages', 'smoke'), { recursive: true })
  writeFileSync(join(root, 'packages', 'smoke', 'package.json'), JSON.stringify({ name: 'smoke', scripts: {} }))
}

function registerCases1(): void {
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
}

function registerCases2(): void {
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
    expect(r.stdout).toContain('additionalContext')
    expect(r.entries[0]).toMatchObject({ decision: 'warned', class: 'missing-script' })
    expect(r.status).toBe(0)
  })
  it('CONSTRUCTED-REAL: warns — `cd packages/smoke && pnpm test` (test also missing there), cd-tracked', () => {
    const r = run('cd packages/smoke && pnpm test', root)
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.stdout).toContain('additionalContext')
    expect(r.status).toBe(0)
  })
}

function registerCases3(): void {
  it('SECURITY LOCK: the journal record never contains the package path from the input cwd', () => {
    const secret = 'SECRET-7f3a'
    mkdirSync(join(root, 'packages', secret), { recursive: true })
    writeFileSync(join(root, 'packages', secret, 'package.json'), JSON.stringify({ name: 'secret', scripts: {} }))

    const r = run('pnpm lint', join(root, 'packages', secret))
    expect(r.warned).toBe(true)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      guard: 'wt-missing-package-script-guard-hook.mjs',
      decision: 'warned',
      class: 'missing-script',
    })
    expect(JSON.stringify(r.entries[0])).not.toContain(secret)
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
    const r = run(`cd ${root.replaceAll('\\', '/')} && cd packages/smoke && pnpm lint`, tmpdir())
    expect(r.warned).toBe(true)
  })
}

function registerCases4(): void {
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
}

function registerCases5(): void {
  it('INVENTED: warns — a genuine typo with no ancestor defining it either', () => {
    const r = run('pnpm totally-made-up-script', root)
    expect(r.warned).toBe(true)
    // The detection is recorded and a context-only notice is printed to the model.
    expect(r.stdout).toContain('may be a genuine typo')
    expect(r.entries[0]).toMatchObject({ decision: 'warned', class: 'missing-script' })
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
}

function registerNoticeCases1(): void {
  it('ancestor case: the notice names the script, the governing dir and the ancestor that defines it', () => {
    const smoke = join(root, 'packages', 'smoke')
    const r = run('pnpm lint', smoke)
    const out = parseNotice(r.stdout)
    expect(Object.keys(out)).toEqual(['hookSpecificOutput'])
    expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName'])
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    const text = String(out.hookSpecificOutput.additionalContext)
    expect(text).toContain('`lint`')
    expect(text).toContain(smoke)
    expect(text).toContain(`defined in the package.json at \`${root}\``)
  })
  it('typo case: no ancestor defines it, the notice says it may be a genuine typo', () => {
    const r = run('pnpm totally-made-up-script', root)
    const text = String(parseNotice(r.stdout).hookSpecificOutput.additionalContext)
    expect(text).toContain('`totally-made-up-script`')
    expect(text).toContain('may be a genuine typo')
  })
  it('NEVER emits permissionDecision or permissionDecisionReason, on any warning row', () => {
    const rows: [string, string][] = [
      ['pnpm lint', join(root, 'packages', 'smoke')],
      ['cd packages/smoke && pnpm lint', root],
      ['pnpm totally-made-up-script', root],
      ['npm run nope', root],
    ]
    for (const [command, cwd] of rows) {
      const r = run(command, cwd)
      expect(r.warned, command).toBe(true)
      expect(r.stdout, command).not.toBe('')
      expect(r.stdout, command).not.toContain('permissionDecision')
      expect(r.stdout, command).not.toContain('"allow"')
    }
  })
}

function registerNoticeCases2(): void {
  it('WT_GUARD_MODE=observe keeps stdout silent but still journals', () => {
    const r = run('pnpm lint', join(root, 'packages', 'smoke'), { WT_GUARD_MODE: 'observe' })
    expect(r.stdout).toBe('')
    expect(r.entries).toHaveLength(1)
  })
  it('a subagent receives the same context-only notice', () => {
    const r = run('pnpm lint', join(root, 'packages', 'smoke'), {}, 'agent-1')
    const out = parseNotice(r.stdout)
    expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName'])
  })
}

function parseNotice(stdout: string) {
  return JSON.parse(stdout) as { hookSpecificOutput: Record<string, unknown> }
}

function registerManifestCase(): void {
  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Bash')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) => h.command?.includes('wt-missing-package-script-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
}

describe('wt-missing-package-script-guard-hook', () => {
  beforeEach(setupPackageRoot)
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  registerCases1()
  registerCases2()
  registerCases3()
  registerCases4()
  registerCases5()
  registerManifestCase()
  registerShellScriptCases()
})

function registerShellScriptCases(): void {
  const smoke = () => join(root, 'packages', 'smoke')
  it('warns on a missing script inside `bash -c` and `sh -c` scripts, tracking cwd', () => {
    const rows: [string, string][] = [
      ["bash -c 'pnpm nope-script'", root],
      ['sh -c "cd packages/smoke && pnpm lint"', root],
      ["bash -c 'cd packages/smoke && pnpm lint'", root],
      ["cd packages/smoke && bash -c 'pnpm lint'", root],
      ['setsid nohup bash -c "pnpm nope-script > out.log 2>&1" &', root],
      ["/bin/zsh -lc 'pnpm nope-script'", root],
      ["bash -o pipefail -c 'pnpm nope-script'", root],
      ["bash -c \"bash -c 'pnpm nope-script'\"", root],
    ]
    for (const [command, cwd] of rows) {
      const r = run(command, cwd)
      expect(r.warned, command).toBe(true)
      expect(r.stdout, command).not.toContain('permissionDecision')
    }
  })
  it('stays silent when the script exists or is not a -c script', () => {
    const rows: [string, string][] = [
      ["bash -c 'pnpm test'", root],
      ["bash -c 'cd packages/smoke && pnpm typecheck'", root],
      ['bash script.sh -c "pnpm nope-script"', root],
      ['git commit -m "bash -c \'pnpm nope-script\'"', root],
      ['echo "pnpm nope-script"', root],
      ["echo bash -c 'pnpm nope-script'", root],
      ["bash -c 'cd packages/smoke; cd ../..; pnpm lint'", smoke()],
    ]
    for (const [command, cwd] of rows) {
      const r = run(command, cwd)
      expect(r.warned, command).toBe(false)
      expect(r.stdout, command).toBe('')
    }
  })
  it('a cd inside the script does not move the outer chain', () => {
    const r = run("bash -c 'cd packages/smoke' && pnpm lint", root)
    expect(r.warned).toBe(false)
  })
}

describe('wt-missing-package-script-guard-hook: context-only notice', () => {
  beforeEach(setupNoticeRoot)
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  registerNoticeCases1()
  registerNoticeCases2()
})

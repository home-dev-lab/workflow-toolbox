// label-intent-producer-hook.test.ts — TDD lock for card 1827598841508005595:
// the label-intent-lens detector must be invoked MECHANICALLY (a hook that
// executes the real script), not by a skill line a model can silently skip.
//
// Two layers, matching the discipline used for the sibling actionable-*
// producer:
//   1. Pure unit tests on plugin/bin/lib/label-intent-runner.mjs, with an
//      injected execFile so no real child process or toolkit is needed.
//   2. An INTEGRATION test that spawns the real hook file with a real (fake,
//      but executable) `tsx` binary and script under a temp toolkit dir —
//      this is the layer that proves an actual `execFileSync` happens, not
//      just that the pure logic is correct in isolation. A stub-only test
//      suite would go green on a hook that never actually shells out, which
//      is exactly the defect class this card exists to close.

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-label-intent-producer-hook.mjs')
const CORE = join(REPO_ROOT, 'plugin/bin/lib/label-intent-runner.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wt-label-intent-${tag}-`))
  roots.push(root)
  return root
}

// --- Layer 1: pure unit tests on the core runner, via a subprocess so the
// ESM file is exercised exactly as the hook exercises it (same discipline as
// actionability-planka-producer.test.ts's CORE-import fixtures). ---

function runCoreSnippet(snippet: string): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import * as core from ${JSON.stringify(new URL(CORE, 'file://').href)};\n${snippet}`],
    { encoding: 'utf8' },
  )
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status }
}

describe('label-intent-runner core', () => {
  it('parseLensOutput reads the real summary line the script prints', () => {
    const r = runCoreSnippet(
      `console.log(JSON.stringify(core.parseLensOutput('label-intent-lens — board 1\\n\\nTOTAL: 2 finding(s), 1 advisory/advisories, 40 card(s)\\nRESULT: FAIL (exit 1)\\n')))`,
    )
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ findings: 2, advisories: 1, cards: 40 })
  })

  it('parseLensOutput returns null on unrecognized output — never a guessed zero', () => {
    const r = runCoreSnippet(`console.log(JSON.stringify(core.parseLensOutput('not the summary line at all')))`)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('null')
  })

  it('runLabelIntentLens: ran=false with no boardId — never calls execFile', () => {
    const r = runCoreSnippet(
      `let called = false; const result = core.runLabelIntentLens({ toolkitDir: '/nonexistent', boardId: undefined, execFileImpl: () => { called = true; return '' } }); console.log(JSON.stringify({ result, called }))`,
    )
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.result.ran).toBe(false)
    expect(parsed.called).toBe(false)
  })

  it('runLabelIntentLens: a clean board (exit 0, 0 findings) reports ok:true', () => {
    const r = runCoreSnippet(
      `const result = core.runLabelIntentLens({ toolkitDir: ${JSON.stringify(join(REPO_ROOT, 'toolkit'))}, boardId: 'b1', execFileImpl: () => 'label-intent-lens — board b1\\n\\nTOTAL: 0 finding(s), 0 advisory/advisories, 5 card(s)\\nRESULT: PASS (exit 0)\\n' }); console.log(JSON.stringify(result))`,
    )
    expect(r.status).toBe(0)
    const result = JSON.parse(r.stdout)
    expect(result).toMatchObject({ ran: true, ok: true, findings: 0, advisories: 0, cards: 5 })
  })

  it('runLabelIntentLens: findings present (exit 1, execFile throws) still parses ok:false', () => {
    const r = runCoreSnippet(
      `const err = new Error('Command failed'); err.status = 1; err.stdout = 'label-intent-lens — board b1\\n\\nTOTAL: 3 finding(s), 0 advisory/advisories, 5 card(s)\\nRESULT: FAIL (exit 1)\\n'; const result = core.runLabelIntentLens({ toolkitDir: ${JSON.stringify(join(REPO_ROOT, 'toolkit'))}, boardId: 'b1', execFileImpl: () => { throw err } }); console.log(JSON.stringify(result))`,
    )
    expect(r.status).toBe(0)
    const result = JSON.parse(r.stdout)
    expect(result).toMatchObject({ ran: true, ok: false, findings: 3, advisories: 0, cards: 5 })
  })

  it('runLabelIntentLens: a genuine crash (throw, unparsable stdout) reports ran:false — never a guessed verdict', () => {
    const r = runCoreSnippet(
      `const err = new Error('ENOENT spawn tsx'); const result = core.runLabelIntentLens({ toolkitDir: ${JSON.stringify(join(REPO_ROOT, 'toolkit'))}, boardId: 'b1', execFileImpl: () => { throw err } }); console.log(JSON.stringify(result))`,
    )
    expect(r.status).toBe(0)
    const result = JSON.parse(r.stdout)
    expect(result.ran).toBe(false)
    expect(result.reason).toContain('ENOENT')
  })

  it('runLabelIntentLens: no vendored toolkit (tsx/script absent) reports ran:false, never calls execFile', () => {
    const missingToolkitDir = join(mkRoot('missing'), 'toolkit')
    const r = runCoreSnippet(
      `let called = false; const result = core.runLabelIntentLens({ toolkitDir: ${JSON.stringify(missingToolkitDir)}, boardId: 'b1', execFileImpl: () => { called = true; return '' } }); console.log(JSON.stringify({ result, called }))`,
    )
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.result.ran).toBe(false)
    expect(parsed.called).toBe(false)
  })
})

// --- Layer 2: integration — the REAL hook file, spawned as a subprocess,
// against a fake-but-EXECUTABLE tsx + script under a temp toolkit dir. This
// is what proves an actual execFileSync happens (the card's own discriminant:
// a real tool_use/execution, not a mention). ---

function makeFakeToolkit(root: string, scriptBody: string): string {
  const toolkitDir = join(root, 'toolkit')
  mkdirSync(join(toolkitDir, 'node_modules', '.bin'), { recursive: true })
  mkdirSync(join(toolkitDir, 'scripts'), { recursive: true })

  const scriptPath = join(toolkitDir, 'scripts', 'label-intent-lens.ts')
  writeFileSync(scriptPath, scriptBody, 'utf8')

  // A fake tsx binary: a plain node script (registered as the "tsx" the hook
  // resolves) that just runs whatever .ts path it's given as plain JS —
  // fine here because the fixture "script" is deliberately plain JS syntax,
  // not real TypeScript.
  const tsxPath = join(toolkitDir, 'node_modules', '.bin', 'tsx')
  writeFileSync(
    tsxPath,
    `#!/usr/bin/env node\nconst path = process.argv[2];\nconst rest = process.argv.slice(3);\nprocess.argv = [process.argv[0], path, ...rest];\nawait import('file://' + path);\n`,
    'utf8',
  )
  chmodSync(tsxPath, 0o755)

  return toolkitDir
}

function runHook(payload: unknown, cwd: string): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, PATH: process.env.PATH },
    cwd,
  })
  return { stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim(), status: res.status }
}

const FAKE_LENS_CLEAN = `
console.log('label-intent-lens — board b1');
console.log('');
console.log('TOTAL: 0 finding(s), 0 advisory/advisories, 3 card(s)');
console.log('RESULT: PASS (exit 0)');
process.exit(0);
`

const FAKE_LENS_FINDINGS = `
console.log('label-intent-lens — board b1');
console.log('');
console.log('card c1');
console.log('  [priority] card body names P1 in prose but the label is missing');
console.log('    > P1 chore, effort:M');
console.log('');
console.log('TOTAL: 1 finding(s), 0 advisory/advisories, 3 card(s)');
console.log('RESULT: FAIL (exit 1)');
process.exit(1);
`

describe('wt-label-intent-producer-hook (integration — real execFileSync against a fake toolkit)', () => {
  it('silent on a non-get_board tool call', () => {
    const root = mkRoot('other-tool')
    const r = runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, cwd: root }, root)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('silent when no toolkit is vendored at cwd/toolkit', () => {
    const root = mkRoot('no-toolkit')
    const r = runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__planka__get_board', tool_input: { boardId: 'b1' }, cwd: root },
      root,
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('silent when the lens actually ran and the board is clean — no false noise', () => {
    const root = mkRoot('clean')
    makeFakeToolkit(root, FAKE_LENS_CLEAN)
    const r = runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__planka__get_board', tool_input: { boardId: 'b1' }, cwd: root },
      root,
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('RED, fixture on purpose: a real label mismatch produces a real additionalContext notice, never silence', () => {
    const root = mkRoot('findings')
    makeFakeToolkit(root, FAKE_LENS_FINDINGS)
    const r = runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__planka__get_board', tool_input: { boardId: 'b1' }, cwd: root },
      root,
    )
    expect(r.status).toBe(0)
    expect(r.stdout).not.toBe('')
    const payload = JSON.parse(r.stdout)
    expect(payload.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(payload.hookSpecificOutput.additionalContext).toContain('1 finding(s)')
    expect(payload.hookSpecificOutput.additionalContext).toContain('b1')
    // Requirement 3: reports, never acts — the notice must never instruct an
    // edit, only a report + the read-only command to see detail.
    expect(payload.hookSpecificOutput.additionalContext.toLowerCase()).toContain('do not change any label')
  })

  it('degrades to silence, not a crash, when tool_input.boardId is missing', () => {
    const root = mkRoot('no-board-id')
    makeFakeToolkit(root, FAKE_LENS_FINDINGS)
    const r = runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__planka__get_board', tool_input: {}, cwd: root },
      root,
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('degrades to silence, not a crash, on malformed stdin', () => {
    const root = mkRoot('malformed-stdin')
    const res = spawnSync(process.execPath, [HOOK], { input: '{not json', encoding: 'utf8', cwd: root })
    expect(res.status).toBe(0)
  })
})

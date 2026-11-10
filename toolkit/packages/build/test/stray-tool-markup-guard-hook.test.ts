import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(ROOT, 'plugin/bin/wt-stray-tool-markup-guard-hook.mjs')
const A = '| D11 | some row |\n</content>\n</invoke>\n'
const B = '## Section\nbody\n</content>\n</invoke>\n<parameter name="file_path">/tmp/x-section.md'
const roots: string[] = []
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'wt # stray-markup-'))
  roots.push(dir)
  return dir
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function run(payload: unknown, mode = 'enforce', extraEnv: Record<string, string> = {}) {
  const dir = scratch()
  const journal = join(dir, 'journal')
  const started = Date.now()
  const result = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8', input: typeof payload === 'string' ? payload : JSON.stringify(payload), maxBuffer: 1 << 28,
    env: { ...process.env, WT_GUARD_MODE: mode, WT_GUARD_JOURNAL_DIR: journal, WT_GUARD_JOURNAL_TEST_ORIGIN: '1', ...extraEnv },
  })
  const elapsedMs = Date.now() - started
  expect(result.status, result.stderr).toBe(0)
  const entries = (() => {
    try { return readdirSync(journal).flatMap((f) => readFileSync(join(journal, f), 'utf8').trim().split('\n').map((s) => JSON.parse(s))) }
    catch { return [] }
  })()
  expect(result.stdout).not.toContain('permissionDecision')
  expect(result.stdout).not.toContain('"deny"')
  return { ...result, entries, elapsedMs }
}
function write(content: unknown, extra = {}) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/target.md', content }, ...extra }
}
function context(stdout: string) { return JSON.parse(stdout).hookSpecificOutput.additionalContext as string }

function registerWriteWarningCases() {
  it('warns on the two-line real leak and gives the exact cleanup remedy', () => {
    const r = run(write(A))
    expect(context(r.stdout)).toContain('line 2 (content-close)')
    expect(context(r.stdout)).toContain('line 3 (invoke-close)')
    expect(context(r.stdout)).toContain('/tmp/target.md')
    expect(context(r.stdout)).toContain('NOT blocked')
    expect(context(r.stdout)).toContain('old_string')
    expect(context(r.stdout)).toContain('new_string')
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('PreToolUse')
  })
  it('journals counts and identifiers without content or target path', () => {
    const r = run(write(B, { tool_use_id: 'toolu_012345678901234567890123456789', session_id: 'session' }))
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ decision: 'warned', class: 'stray-tool-markup', evidence: {
      tool: 'Write', kinds: 'content-close,invoke-close,parameter-open', lines: '3', tail: 'yes',
      toolUseId: 'toolu_012345678901234567890123456789',
    } })
    expect(JSON.stringify(r.entries)).not.toMatch(/Section|file_path|target\.md|x-section/)
    expect(context(r.stdout)).toContain('line 5 (parameter-open)')
  })
}

function registerReplacementCases() {
  it.each(['Edit', 'MultiEdit'])('numbers %s new_string lines per edit', (tool) => {
    const tool_input = tool === 'Edit' ? { new_string: A } : { edits: [{ new_string: 'clean' }, { new_string: A }] }
    const r = run({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: '/tmp/edit.md', ...tool_input } })
    expect(context(r.stdout)).toContain(`line 2 of new_string (edit ${tool === 'Edit' ? 1 : 2})`)
  })
  it('reaches subagents and retains the event', () => {
    const r = run(write(A, { agent_id: 'child' }))
    expect(context(r.stdout)).toContain('line 2 (content-close)')
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('PreToolUse')
  })
  it.each(['</x:content>', '</invoke>', '</content>\r\n', '```xml\n</content>'])('warns for supported line forms: %j', (text) => {
    expect(context(run(write(text)).stdout)).toContain('line ')
  })
}

function registerRemedyAndScaleCases() {
  it('names the adjoining newline: after the line for a hit on line 1, before it otherwise', () => {
    const first = context(run(write('</content>\nbody')).stdout)
    expect(first).toContain('line 1 of the file')
    expect(first).toContain('newline AFTER')
    const later = context(run(write(A)).stdout)
    expect(later).toContain('newline before')
    expect(later).not.toContain('line 1 of the file')
  })
  it('processes 50,000 hit lines well inside the hook timeout and still warns', () => {
    const r = run(write('</content>\n'.repeat(50000) + 'a\nb\nc\nd'))
    expect(r.elapsedMs).toBeLessThan(2000)
    expect(context(r.stdout)).toContain('line 50000 (content-close)')
    expect(r.entries[0].evidence).toMatchObject({ lines: '50000', tail: 'no' })
  }, 30000)
  it('observe mode is silent but journals the detection', () => {
    const r = run(write(A), 'observe')
    expect(r.stdout).toBe('')
    expect(r.entries).toEqual([expect.objectContaining({ decision: 'silent', mode: 'observe' })])
  })
  it('records tail=no when every hit is earlier than the last three lines', () => {
    expect(run(write('</content>\na\nb\nc\nd')).entries[0].evidence.tail).toBe('no')
  })
  it.each([
    write('clean'), write(' </content>'), write('mention `</content>`'), write('```xml\n</content>\n```'),
    { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { new_string: '' } },
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { content: A } },
    { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { content: A } },
    '{malformed', null,
  ])('clean or irrelevant input stays silent: %j', (payload) => {
    const r = run(payload)
    expect(r.stdout).toBe('')
    expect(r.entries).toEqual([])
  })
}

describe('stray markup file hook', () => {
  registerWriteWarningCases()
  registerReplacementCases()
  registerRemedyAndScaleCases()
})

const detectionCases = [
  ['</content>', [{ line: 1, kind: 'content-close' }]],
  ['</invoke>', [{ line: 1, kind: 'invoke-close' }]],
  ['<parameter name="file_path">x', [{ line: 1, kind: 'parameter-open' }]],
  ['</x:content>\r\n</_x-1:invoke> \t\r\n<x:parameter name="p">', [
    { line: 1, kind: 'content-close' }, { line: 2, kind: 'invoke-close' }, { line: 3, kind: 'parameter-open' },
  ]],
  ['```xml\n</content>\n```\n</invoke>', [{ line: 4, kind: 'invoke-close' }]],
  ['  ~~~xml\n</content>\n  ~~~', []],
  ['```xml\n</content>', [{ line: 2, kind: 'content-close' }]],
  ['```\n</content>\n~~~', [{ line: 2, kind: 'content-close' }]],
  ['```\n</content>\n\t```', [{ line: 2, kind: 'content-close' }]],
  ['</content>\n```\n</invoke>\n```\n~~~\n<parameter name=x>', [
    { line: 1, kind: 'content-close' }, { line: 6, kind: 'parameter-open' },
  ]],
  [' </content>\n\t</invoke>\ninline </content>\n`</content>`\n</new_string>\n</content>x', []],
  ['</content>\v\n</invoke>\u00a0', []],
  ['```\n</content>\n```not-a-close', [{ line: 2, kind: 'content-close' }]],
  ['```\n```not-a-close\n</content>\n```', []],
  ['    ```\n</content>\n    ```', [{ line: 2, kind: 'content-close' }]],
  ['````\n</content>\n```\n</invoke>\n````', []],
  ['```\n</content>\n````', []],
  ['~~~\n</content>\n```', [{ line: 2, kind: 'content-close' }]],
  ['   ```\n</content>\n   ```  \t\r', []],
  [undefined, []], [42, []],
] as const
it.each(detectionCases)('pure detector: %j', async (text, expected) => {
  // @ts-expect-error Node ESM helper has no declarations
  const { findStrayToolMarkup } = await import('../../../../plugin/bin/lib/stray-tool-markup-core.mjs')
  expect(findStrayToolMarkup(text)).toEqual(expected)
})

function git(dir: string, args: string[], extra = {}) {
  const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra },
  })
  expect(r.status, r.stderr).toBe(0)
}
function repo(message: string, old = false, sub = '') {
  let dir = scratch()
  if (sub) { dir = join(dir, sub); mkdirSync(dir) }
  git(dir, ['init'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'user.email', 'test@example.invalid'])
  const file = join(dir, 'message')
  writeFileSync(file, message)
  git(dir, ['commit', '--allow-empty', '-F', file], old ? { GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z' } : {})
  return dir
}
function bash(cwd: string, command: string) {
  return { hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd, tool_input: { command } }
}
describe('stored commit message hook', () => {
  it.each(['git commit -F message', 'git -c k=v commit -m text', 'git commit -F - <<\'MSG\'\ntext\nMSG'])('checks stored message for %s', (command) => {
    const dir = repo(A)
    const r = run(bash(dir, command))
    expect(context(r.stdout)).toContain(`the HEAD commit in ${dir} (committed within the last 120 s)`)
    expect(context(r.stdout)).toContain('line 2 (content-close)')
    expect(context(r.stdout)).toContain('git commit --amend -F <corrected file>')
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('PostToolUse')
  })
  it('resolves quoted relative -C from input.cwd', () => {
    const dir = repo(B)
    const r = run(bash(dirname(dir), `git -C "${basename(dir)}" commit -F message`))
    expect(context(r.stdout)).toContain(`the HEAD commit in ${dir} (committed within the last 120 s)`)
    expect(r.entries[0].evidence.lines).toBe('3')
  })
  it('keeps a quoted -c value together before -C', () => {
    const dir = repo(A)
    const r = run(bash(dirname(dir), `git -c user.name="Test User" -C "${basename(dir)}" commit -m text`))
    expect(context(r.stdout)).toContain(`the HEAD commit in ${dir} (committed within the last 120 s)`)
  })
  it.each([
    'true && grep -F message', 'cat <<\'EOF\'\ngit commit -F message\nEOF',
    'echo "git commit -F message"', 'git status && grep -F commit',
    'echo ok # ; git commit -F message', '# git commit -F message',
  ])('does not read a dirty HEAD for a mere mention: %s', (command) => {
    const r = run(bash(repo(A), command))
    expect(r.stdout).toBe('')
    expect(r.entries).toEqual([])
  })
  it.each([
    'X=1 git commit -F message', 'env X=1 git commit -F message', '(git commit -F message)',
    'true && { git commit -F message; }', 'echo $(git commit -F message)', 'sudo git commit -F message',
  ])('recognises the commit form %s', (command) => {
    const dir = repo(A)
    expect(context(run(bash(dir, command)).stdout)).toContain('line 2 (content-close)')
  })
})

describe('stored commit message hook: -C resolution', () => {
  it('accepts an attached -C value', () => {
    const dir = repo(A)
    const r = run(bash(scratch(), `git -C"${dir}" commit -F message`))
    expect(context(r.stdout)).toContain(`the HEAD commit in ${dir} `)
  })
  it.each([
    ['git -C "re"po commit -F m'], ['git -C re\\po commit -F m'], ["git -C 're'po commit -F m"], ['git -C ./repo commit -F m'],
  ])('removes shell quoting from the -C word: %s', (command) => {
    const dir = repo(A, false, 'repo')
    const r = run(bash(dirname(dir), command))
    expect(context(r.stdout)).toContain(`the HEAD commit in ${dir} `)
  })
  it('expands a leading ~/ to the home directory', () => {
    const home = scratch()
    const dir = repo(A, false, 'proj')
    const link = join(home, 'proj')
    symlinkSync(dir, link)
    const r = run(bash(scratch(), 'git -C ~/proj commit -F m'), 'enforce', { HOME: home, USERPROFILE: home })
    expect(context(r.stdout)).toContain(`the HEAD commit in ${link} `)
  })
  it.each(['git -C $D commit -F m', 'git -C "$D/x" commit -F m', 'git -C `pwd` commit -F m', 'git -C re* commit -F m',
    'git -C ~other commit -F m', 'git -C {a,b} commit -F m'])('stays silent for an unresolvable -C: %s', (command) => {
    const dir = repo(A)
    const r = run(bash(dir, command))
    expect(r.stdout).toBe('')
    expect(r.entries).toEqual([])
  })
})

describe('stored commit message hook: several directories and dry runs', () => {
  it('checks every distinct commit directory, up to four', () => {
    const clean = repo('clean')
    const dirty = repo(A)
    const three = [repo('c1'), repo('c2'), repo('c3')]
    const at = (d: string) => `git -C ${JSON.stringify(d)} commit -F m`
    const repeated = [clean, clean, clean, clean, dirty].map(at).join('; ')
    expect(context(run(bash(scratch(), repeated)).stdout)).toContain(`the HEAD commit in ${dirty} `)
    expect(run(bash(scratch(), [...three, clean, dirty].map(at).join(' && '))).stdout).toBe('')
    expect(context(run(bash(scratch(), [...three, dirty].map(at).join(' && '))).stdout)).toContain(dirty)
  })
  it('reports two dirty directories in one notice and one journal entry', () => {
    const [one, two] = [repo(A), repo(A)]
    const r = run(bash(scratch(), `git -C ${JSON.stringify(one)} commit -m x; git -C ${JSON.stringify(two)} commit -m x`))
    expect(context(r.stdout)).toContain(one)
    expect(context(r.stdout)).toContain(two)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].evidence.lines).toBe('4')
  })
  it.each(['git commit --dry-run -F message', 'git commit -F message --dry-run', 'git commit --amend --dry-run'])(
    'skips a dry run that creates nothing: %s', (command) => {
      const r = run(bash(repo(A), command))
      expect(r.stdout).toBe('')
      expect(r.entries).toEqual([])
    })
})

describe('stored commit message hook: timeout and silence', () => {
  it('keeps the git read timeout inside the registered hook timeout with a margin', async () => {
    const helper = pathToFileURL(join(ROOT, 'plugin/bin/lib/host/stray-tool-markup-git.mjs')).href
    const { GIT_TIMEOUT_MS } = await import(/* @vite-ignore */ helper)
    const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8'))
    const entry = manifest.hooks.PostToolUse.find((e: { hooks: Array<{ command: string }> }) =>
      e.hooks.some((h) => h.command.includes('wt-stray-tool-markup-guard-hook.mjs')))
    expect(GIT_TIMEOUT_MS).toBeLessThanOrEqual(entry.hooks[0].timeout * 1000 - 1000)
  })
  it('ignores clean messages, old HEADs and non-repositories', () => {
    for (const dir of [repo('clean'), repo(A, true), scratch()]) {
      const r = run(bash(dir, 'git commit -F message'))
      expect(r.stdout).toBe('')
      expect(r.entries).toEqual([])
    }
  })
})

it('registers both events with bounded timeouts and stays out of fail-closed SDK writers', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8'))
  for (const [event, matcher] of [['PreToolUse', 'Write|Edit|MultiEdit'], ['PostToolUse', 'Bash']]) {
    const entries = manifest.hooks[event!].filter((entry: { hooks: Array<{ command: string }> }) =>
      entry.hooks.some((hook) => hook.command.includes('wt-stray-tool-markup-guard-hook.mjs')))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ matcher, hooks: [{ type: 'command', timeout: 5 }] })
  }
  expect(readFileSync(join(ROOT, 'plugin/bin/lib/sdk-role-profile.mjs'), 'utf8')).not.toContain('wt-stray-tool-markup-guard-hook.mjs')
})

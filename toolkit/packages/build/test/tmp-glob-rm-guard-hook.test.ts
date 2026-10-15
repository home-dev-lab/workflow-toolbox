import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
// Mutation proofs run copies, so the shipped detector never needs to be edited or restored.
const HOOK = process.env.WT_TMP_GLOB_RM_TEST_HOOK ?? join(REPO_ROOT, 'plugin/bin/wt-tmp-glob-rm-guard-hook.mjs')
let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-tmp-glob-guard-test-'))
  const storeDir = join(root, 'config/plugins/store')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(join(storeDir, 'wt-secret-guard.json'), JSON.stringify({ salt: 'fixture-salt', detections: { entries: [] } }))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function run(command: string, mode = 'enforce', fields: Record<string, unknown> = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...fields }),
    encoding: 'utf8',
    env: {
      ...process.env, WT_GUARD_MODE: mode, WT_GUARD_JOURNAL_DIR: root,
      WT_GUARD_JOURNAL_TEST_ORIGIN: '1', CLAUDE_CONFIG_DIR: join(root, 'config'),
    },
  })
}

const WARN = [
  'rm -rf /tmp/b8-*',
  'rm -rf /tmp/b5-* /tmp/b7-* /tmp/b8-*',
  'rm -f /tmp/*.log',
  'rm -rf /tmp/*',
  'cd x && rm -rf /tmp/b8-*',
  'rm -rf -- /tmp/b8-*',
  'sudo rm -rf /tmp/b8*',
  'rm -rf /tmp/[ab]8-*',
  'rm -f /tmp/b8-?.sh',
  'rm -rf $TMPDIR/b8-*',
  'rm -rf "$TMPDIR"/b8-*',
  'rm -rf "${TMPDIR:-/tmp}"/b8-*',
  'rm -rf /private/tmp/b8-*',
  'rm -rf /var/folders/ab/cd123/T/b8-*',
  'rm -rf /c/Users/me/AppData/Local/Temp/b8-*',
  'rm -rf $TEMP/b8-*',
  "bash -c 'rm -rf /tmp/b8-*'",
  'x=$(rm -rf /tmp/b8-*)',
  'rm -rf /tmp/b8-*/',
  'rm -rf /tmp//b8-*',
  'rm -rf /var/tmp/b8-*',
  'rm -rf /private/var/tmp/b8-*',
  'rm -rf /private/var/folders/ab/cd123/T/b8-*',
  'rm -rf /C/users/me/appdata/local/TEMP/b8-*',
  'rm -rf ${TMPDIR}/b8-*',
  'rm -rf ${TMPDIR:-/tmp}/b8-*',
  'rm -rf ${TMPDIR%/}/b8-*',
  'rm -rf "${TMPDIR%/}"/b8-*',
  'rm -rf $TMP/b8-*',
  'rm -rf "${TEMP}"/b8-*',
  'rm -rf /tmp/"b8-"*',
  'rm -rf "/tmp"/b8-*',
  'rm -rf /tmp/b8-\\**',
  'echo `rm -rf /tmp/b8-*`',
  "eval 'rm -rf /tmp/b8-*'",
  "bash -c 'bash -c \"rm -rf /tmp/b8-*\"'",
  'command /bin/rm -f /tmp/b8-* > /tmp/output.log',
  'cat <<EOF\n$(rm -rf /tmp/b8-*)\nEOF',
  'xargs rm -rf /tmp/b8-*',
  'printf x | xargs rm -rf /tmp/b8-*',
]

const SILENT = [
  'rm -rf "$T"',
  'rm -rf "${T:?}"',
  'rm -rf "${T:?}"/*',
  'rm -rf $T/*',
  'rm -f /tmp/literal-name.txt',
  'rm -rf /tmp/tmp.AbC123/*',
  'rm -rf "/tmp/b8-*"',
  'rm -f /tmp/b8-\\*',
  'ls /tmp/b8-*',
  'grep -r rm /tmp/*',
  'echo "rm -rf /tmp/b8-*"',
  'git commit -m "fix: rm -rf /tmp/b8-* was dangerous"',
  "cat <<'EOF'\nrm -rf /tmp/b8-*\nEOF",
  'T=$(mktemp -d); rm -rf "${T:?}"',
  "rm -rf '/tmp/b8-*'",
  'rm -rf "$TMPDIR/b8-*"',
  'rm -rf "${TMPDIR:-/tmp}/b8-*"',
  "rm -rf '$TMPDIR'/b8-*",
  'rm -rf \\$TMPDIR/b8-*',
  'rm -rf $TMPDIR/tmp.AbC123/*',
  'rm -rf $TEMP/owned/*',
  'rm -rf /var/folders/ab/cd123/T/owned/*',
  'rm -rf /c/Users/me/AppData/Local/Temp/owned/*',
  'rm -rf /tmpx/b8-*',
  'rm -rf /home/me/tmp/b8-*',
  'rm -rf $TMPDIRECTORY/b8-*',
  'rm -rf /tmp/b8-\\?.sh',
  'rm -rf /tmp/\\[ab]8-literal',
  'rm -rf /tmp/"[ab]8-*"',
  'rm -rf /tmp/literal > /tmp/b8-*',
  'echo rm -rf /tmp/b8-*',
  '# rm -rf /tmp/b8-*',
  'cat <<EOF\nrm -rf /tmp/b8-*\nEOF',
  "cat <<'EOF'\n$(rm -rf /tmp/b8-*)\nEOF",
  "find /tmp -name 'b8-*' -delete",
  'find /tmp -type f | xargs rm -f',
  'F=/tmp/b8-*; rm $F',
  'rmdir /tmp/b8-*',
  'rm -rf /tmp/$F*',
  'rm -rf /tmp/$TMPDIR*',
  'rm -rf "/tm\\p"/b8-*',
]

const TEMP_NAMES = ['TMPDIR', 'TMP', 'TEMP']
const ASSIGNED_TEMP = [
  ...TEMP_NAMES.flatMap((name) => ['', 'export ', 'local ', 'declare '].map((prefix) =>
    `${prefix}${name}=$(mktemp -d); rm -rf "$${name}"/*`)),
  'export TMP=$(mktemp -d) && rm -f $TMP/*.log',
  'TMPDIR=$(mktemp -d); rm -rf "${TMPDIR:?}"/*',
]
const BRACKET_LITERALS = [
  'rm -f /tmp/report[1',
  'rm -f /tmp/report[1\\]',
  'rm -f /tmp/report[1"]"',
  'rm -f /tmp/report[1/owned]',
]
const REQUIRED_TEMP = TEMP_NAMES.flatMap((name) => [
  `rm -rf "\${${name}:?}"/b8-*`,
  `rm -rf \${${name}:?unset}/b8-*`,
])
const DEFAULT_TEMP = TEMP_NAMES.flatMap((name) => [':-', '-'].flatMap((operator) => [
  `rm -rf \${${name}${operator}"/tmp"}/b8-*`,
  `rm -rf "\${${name}${operator}'/tmp'}"/b8-*`,
  `rm -rf \${${name}${operator}/tmp}/b8-*`,
]))

describe('warn-only temp-root rm glob guard', () => {
  it.each(WARN)('WARN: %s', (command) => {
    const result = run(command)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('additionalContext')
    const output = JSON.parse(result.stdout).hookSpecificOutput
    expect(output.additionalContext).toContain('tmp-glob-rm guard')
    expect(output.permissionDecision).toBeUndefined()
  })

  it.each(SILENT)('SILENT: %s', (command) => {
    const result = run(command)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.each(ASSIGNED_TEMP)('F1 SILENT assigned temp name: %s', (command) => {
    const result = run(command)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.each([
    'X=1; rm -rf $TMPDIR/b8-*',
    'TMPDIRECTORY=$(mktemp -d); rm -rf $TMPDIR/b8-*',
    'TMP=$(mktemp -d); rm -rf $TMPDIR/b8-*',
    'TMPDIR=$(mktemp -d); rm -rf /tmp/b8-*',
    'rm -rf $TEMP/*; TEMP=$(mktemp -d)',
  ])('F1 WARN unaffected temp root: %s', (command) => {
    const result = run(command)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('additionalContext')
  })

  it.each(BRACKET_LITERALS)('F2 SILENT unmatched active bracket: %s', (command) => {
    const result = run(command)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.each(['rm -rf /tmp/[ab]8-*', 'rm -f /tmp/x[0-9].log', 'rm -f /tmp/[ab]8'])('F2 WARN closed active bracket: %s', (command) => {
    const result = run(command)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('additionalContext')
  })

  it.each(REQUIRED_TEMP)('F3 WARN required temp reference: %s', (command) => {
    const result = run(command)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('additionalContext')
  })

  it.each(DEFAULT_TEMP)('F4 WARN literal temp default: %s', (command) => {
    const result = run(command)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('additionalContext')
  })

  it.each([
    'rm -rf "${TMPDIR:?}/b8-*"',
    'rm -rf "${TMPDIR:-\'/tmp\'}/b8-*"',
    'rm -rf ${TMPDIR:-"/owned"}/b8-*',
    "rm -rf '${TMPDIR:-/tmp}'/b8-*",
  ])('SILENT quoted glob or non-temp expansion: %s', (command) => {
    const result = run(command)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('names every offending target as written and gives the usable remedy and probation exit', () => {
    const output = JSON.parse(run('rm -rf /tmp/b5-* /tmp/b7-* "$TMPDIR"/b8-*').stdout).hookSpecificOutput.additionalContext
    for (const text of ['/tmp/b5-*', '/tmp/b7-*', '"$TMPDIR"/b8-*', 'same short prefixes', 'mutation backups', 'T=$(mktemp -d)', 'rm -rf "${T:?}"', 'Warn-only', '20 live firings', 'wt-guard-journal-scan.mjs']) {
      expect(output).toContain(text)
    }
    expect(output.length).toBeLessThan(900)
  })

  it.each(['enforce', 'observe', 'unknown'])('never denies in %s mode', (mode) => {
    const result = run('rm -rf /tmp/b8-*', mode)
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('permissionDecision')
    if (mode === 'observe') expect(result.stdout).toBe('')
    else expect(result.stdout).toContain('additionalContext')
  })

  it('delivers the warning to a subagent, the agents that share temp prefixes', () => {
    const result = run('rm -rf /tmp/b8-*', 'enforce', { agent_id: 'tmpglob-subagent' })
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout).hookSpecificOutput
    expect(output.additionalContext).toContain('tmp-glob-rm guard')
    expect(output.permissionDecision).toBeUndefined()
  })

  it('journals warned shape-only evidence, without raw targets or command text', () => {
    run('rm -rf /tmp/private-target-*', 'enforce', { session_id: 'tmpglob-session', agent_id: 'tmpglob-agent' })
    const journal = readdirSync(root).filter((f) => f.endsWith('.ndjson')).map((f) => readFileSync(join(root, f), 'utf8')).join('')
    const entries = journal.trim().split('\n').map((line) => JSON.parse(line))
    const entry = entries.find((e) => e.session === 'tmpglob-session')
    expect(entry).toMatchObject({ guard: 'wt-tmp-glob-rm-guard-hook.mjs', decision: 'warned', mode: 'enforce', class: 'temp-root-glob', agent: 'tmpglob-agent', evidence: { shape: 'first-segment-glob', targets: '1' } })
    expect(journal).not.toContain('private-target')
    expect(journal).not.toContain('rm -rf')
  })

  it.each([
    { hook_event_name: 'PostToolUse' }, { tool_name: 'Read' }, { tool_input: {} }, { tool_input: { command: 123 } },
  ])('ignores an irrelevant or malformed payload: %j', (fields) => {
    const result = run('rm -rf /tmp/b8-*', 'enforce', fields)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('fails open on invalid JSON', () => {
    const result = spawnSync(process.execPath, [HOOK], { input: '{', encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('is wired to PreToolUse Bash in the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8'))
    const hooks = manifest.hooks.PreToolUse.filter((e: { matcher: string }) => e.matcher === 'Bash').flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks)
    expect(hooks.some((h: { command: string }) => h.command.includes('wt-tmp-glob-rm-guard-hook.mjs'))).toBe(true)
  })
})

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(ROOT, 'plugin/bin/wt-duplicate-pilot-guard-hook.mjs')
const OUTBOUND = join(ROOT, 'plugin/bin/wt-outbound-guard-hook.mjs')
const SCAN = join(ROOT, 'plugin/bin/wt-spawn-registry-scan.mjs')
const PARSER = join(ROOT, 'plugin/bin/lib/pilot-card-ids.mjs')
const JOURNAL_READER = join(ROOT, 'plugin/bin/lib/guard-journal-read.mjs')
const OWNERSHIP_FILES = join(ROOT, 'plugin/bin/lib/host/duplicate-pilot-files.mjs')
const GUARD = 'wt-duplicate-pilot-guard-hook.mjs'
const CARD = '9000000000000000001'
const OTHER = '9000000000000000002'
const OWNER = 'a0123456789abcdef'
const SECOND = 'afedcba9876543210'
const NOW = '2026-10-03T12:00:00.000Z'
const OLD = '2026-10-01T12:00:00.000Z'
let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-duplicate-pilot-'))
  for (const name of ['home', 'live', 'registry', 'journal', 'config']) mkdirSync(join(root, name))
  env = {
    ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_PLUGIN_DATA: '', WT_GUARD_MODE: 'enforce',
    WT_LIVENESS_DIR: join(root, 'live'), WT_OUTBOUND_GUARD_DIR: join(root, 'registry'),
    WT_GUARD_JOURNAL_DIR: join(root, 'journal'), WT_GUARD_JOURNAL_TEST_ORIGIN: '1',
    WT_GUARD_JOURNAL_NOW: NOW, WT_DUPLICATE_PILOT_HORIZON_H: '12',
    WT_FAIL_OPEN_TRACE_SELF_TEST: '', WT_SDK_ROLE_GUARD_FAILURE: '',
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// A synchronous read of a FIFO never returns, and a test timeout cannot interrupt a synchronous
// child wait, so the special-file tests bound the hook themselves. A healthy hook returns in well
// under a second; the bound only turns a hang into a failure.
const HANG_BOUND_MS = 30_000
function run(script: string, payload: unknown = '', args: string[] = []) {
  const r = spawnSync(process.execPath, [script, ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', env,
  })
  return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() }
}
function pre(prompt = `PILOT-CARD: ${CARD}`, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 'session-demo', tool_use_id: 'spawn-second',
    cwd: root, tool_input: { subagent_type: 'pilot', prompt }, ...extra,
  }
}
function spawn(child = OWNER, card = CARD, extra: Record<string, unknown> = {}) {
  return { t: 'spawn', child, subagentType: 'pilot', cardIds: [card], at: NOW, ...extra }
}
function registry(records: unknown[], name = 'session-demo') {
  writeFileSync(join(root, 'registry', `${name}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n')
}
function live(extra: Record<string, unknown> = {}, key = OWNER) {
  writeFileSync(join(root, 'live', `${key}.json`), JSON.stringify({
    agentId: OWNER, scope: `card:${CARD}`, complete: false, updatedAt: NOW, ...extra,
  }))
}
function journal() {
  return readdirSync(join(root, 'journal')).filter(f => /^\d{4}-W\d{2}\.ndjson$/.test(f))
    .flatMap(f => readFileSync(join(root, 'journal', f), 'utf8').trim().split('\n').map(l => JSON.parse(l)))
}
function seedReviews(count: number, origin = 'real', falseCount = 0) {
  const events = Array.from({ length: count + falseCount }, (_, i) => ({
    guard: GUARD, class: 'duplicate-pilot', decision: 'warned', origin, ts: NOW,
    evidence: { fid: i.toString(16).padStart(16, '0'), version: 'v2', card: CARD, owner: '0123456789abcdef' },
  }))
  writeFileSync(join(root, 'journal', '2026-W39.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
  for (let i = 0; i < events.length; i++) {
    expect(run(HOOK, '', ['review', '--mark', events[i]!.evidence.fid, i < count ? 'true' : 'false']).code).toBe(0)
  }
  return events
}
function notice(payload: Record<string, unknown> = pre()) {
  const r = run(HOOK, payload)
  expect(r.code).toBe(0)
  expect(r.stdout, 'a duplicate owner must produce hook stdout').not.toBe('')
  return JSON.parse(r.stdout).hookSpecificOutput
}
function silent(payload = pre()) {
  const r = run(HOOK, payload)
  expect(r.code).toBe(0)
  expect(r.stdout, 'an allowed spawn must be silent').toBe('')
}
function moduleValue(file: string, expression: string) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); console.log(JSON.stringify(${expression}))`,
  ], { encoding: 'utf8', env })
  expect(r.status).toBe(0)
  return JSON.parse(r.stdout)
}
function parse(prompt: string, fn = 'pilotCardIds') {
  return moduleValue(PARSER, `m[${JSON.stringify(fn)}](${JSON.stringify(prompt)})`)
}

describe('duplicate pilot spawn guard', () => {
  it('replays the real writer then warns and denies the sequential retry after review', () => {
    const prompt = `You are the pilot for ONE Planka card: ${CARD} — implement the brief.`
    const first = run(OUTBOUND, {
      hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 'session-demo',
      tool_input: { subagent_type: 'pilot', prompt }, tool_response: { agentId: OWNER },
    })
    expect(first.code).toBe(0)
    const warning = notice(pre(prompt))
    expect(warning.hookEventName).toBe('PreToolUse')
    expect(warning.additionalContext).toContain(OWNER)
    expect(warning.additionalContext).toContain(CARD)
    expect(warning.additionalContext).toContain('session-demo.jsonl')
    expect(warning.additionalContext).toContain('spawned at')
    expect(warning.additionalContext).toContain(`RESPAWN-OF: ${OWNER}`)
    expect(warning.additionalContext).toContain('delegated work stopped')
    expect(warning.additionalContext).toContain('description, never position')
    seedReviews(20)
    const denied = notice(pre(prompt))
    expect(denied.permissionDecision).toBe('deny')
    expect(denied.permissionDecisionReason).toContain(OWNER)
  })
  it('finds fresh card-scoped liveness and names its file', () => {
    live()
    expect(notice().additionalContext).toContain(`${OWNER}.json`)
  })
  it('ignores mission scopes mentioning a card', () => {
    live({ scope: `mission: coordinate card:${CARD}` })
    silent()
  })
  it('allows RESPAWN-OF covering all owners and journals the override', () => {
    registry([spawn(), spawn(SECOND)])
    silent(pre(`PILOT-CARD: ${CARD}\nRESPAWN-OF: ${OWNER}, ${SECOND}`))
    expect(journal().at(-1)).toMatchObject({ decision: 'silent', class: 'respawn-of' })
  })
  it.each([OWNER, 'wrong-owner'])('fires for partial or wrong override %s', override => {
    registry([spawn(), spawn(SECOND)])
    const text = notice(pre(`PILOT-CARD: ${CARD}\nRESPAWN-OF: ${override}`)).additionalContext
    expect(text).toContain(SECOND)
    expect(text).toContain(`RESPAWN-OF: ${OWNER}, ${SECOND}`)
    expect(text).toContain(override)
  })
  it('ignores RESPAWN-OF inside a fenced example', () => {
    registry([spawn()])
    expect(notice(pre(`PILOT-CARD: ${CARD}\n\`\`\`text\nRESPAWN-OF: ${OWNER}\n\`\`\``)).additionalContext).toContain(OWNER)
  })
  it('allows a different card', () => { registry([spawn()]); silent(pre(`PILOT-CARD: ${OTHER}`)) })
  it('matches every owned card in a multi-card assignment', () => {
    registry([spawn(OWNER, OTHER)])
    expect(notice(pre(`PILOT-CARD: ${CARD}, ${OTHER}`)).additionalContext).toContain(OTHER)
  })
  it('applies a raw-id ack across registry and fresh liveness', () => {
    registry([spawn(OWNER, CARD, { at: '2026-10-03T11:00:00Z' })])
    expect(run(SCAN, '', ['--ack', OWNER, '--session', 'session-demo']).code).toBe(0)
    live()
    silent()
  })
  it('joins raw-id acks across registry files while retaining the named-ack session boundary', () => {
    registry([spawn(OWNER, CARD, { at: '2026-10-03T11:00:00Z' })])
    registry([{ t: 'ack', name: OWNER, at: NOW }], 'ack-session')
    live(); silent()
  })
  it('applies completed liveness across both sources', () => {
    registry([spawn()]); live({ complete: true }); silent()
  })
  it('ignores registry and liveness activity older than the horizon despite fresh mtime', () => {
    registry([spawn(OWNER, CARD, { at: OLD })]); live({ updatedAt: OLD }); silent()
  })
  it('ignores registry files older than the horizon', () => {
    registry([spawn()])
    utimesSync(join(root, 'registry', 'session-demo.jsonl'), new Date(OLD), new Date(OLD))
    silent()
  })
  it.skipIf(process.platform === 'win32')('never opens registry files older than the horizon', () => {
    // A FIFO blocks any reader forever: the hook finishes only if it skips the stale file before reading it.
    registry([spawn()])
    const stale = join(root, 'registry', 'stale-session.jsonl')
    expect(spawnSync('mkfifo', [stale]).status).toBe(0)
    utimesSync(stale, new Date(OLD), new Date(OLD))
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(pre()), encoding: 'utf8', env, timeout: HANG_BOUND_MS })
    expect(r.error, 'the hook must not block on a stale registry file').toBeUndefined()
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain(OWNER)
  })
  it('never reads a registry file last written before the horizon', () => {
    registry([spawn()], 'stale-session')
    utimesSync(join(root, 'registry', 'stale-session.jsonl'), new Date(OLD), new Date(OLD))
    registry([spawn()])
    const files = moduleValue(OWNERSHIP_FILES,
      `m.pilotOwnershipSnapshot(${JSON.stringify(join(root, 'live'))}, ${JSON.stringify(join(root, 'registry'))}, Date.parse(${JSON.stringify(NOW)}) - 12 * 3600_000).registries.map(r => r.file)`)
    expect(files).toEqual([join(root, 'registry', 'session-demo.jsonl')])
  })
  it('scans a large live registry in linear time', () => {
    // 40k ELIGIBLE pilot spawns (another card) + 40k activity records: a per-spawn rescan of the
    // file costs ~3e9 steps (measured 10 s on a loaded machine); one indexing pass stays well under a second.
    const records: unknown[] = [spawn()]
    for (let i = 0; i < 40_000; i++) {
      const child = `a${i.toString(16).padStart(16, '0')}`
      records.push(spawn(child, OTHER), { t: 'out', agentId: child, at: NOW })
    }
    registry(records)
    const started = Date.now()
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(pre()), encoding: 'utf8', env, timeout: 30_000 })
    expect(r.error, 'the hook must finish').toBeUndefined()
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain(OWNER)
    expect(Date.now() - started, 'registry scan must not rescan the file per spawn').toBeLessThan(5_000)
  })
  it('does not exclude an owning pilot caller', () => {
    live(); expect(notice(pre(undefined, { agent_id: OWNER })).additionalContext).toContain(OWNER)
  })
  it('prints warnings for a subagent spawner', () => {
    registry([spawn()]); expect(notice(pre(undefined, { agent_id: 'orchestrator-demo' })).additionalContext).toContain(OWNER)
  })
  it.each(['pilot', 'workflow-toolbox:pilot', 'workflow-toolbox:pilot-lean'])('guards Task and pilot type %s', subagent_type => {
    registry([spawn()])
    expect(notice(pre(undefined, { tool_name: 'Task', tool_input: { subagent_type, prompt: `PILOT-CARD: ${CARD}` } })).additionalContext).toContain(OWNER)
  })
  it.each(['pilot-orchestrator', 'pilot-watchdog', 'general-purpose'])('allows non-pilot type %s', subagent_type => {
    registry([spawn()]); silent(pre(undefined, { tool_input: { subagent_type, prompt: `PILOT-CARD: ${CARD}` } }))
  })
  it('ignores prompts without ownership metadata and non-spawn events', () => {
    registry([spawn()]); silent(pre(`Dependency card: ${CARD}`)); silent(pre(undefined, { tool_name: 'Bash' }))
    silent(pre(undefined, { hook_event_name: 'PostToolUse' }))
  })
  it('keeps valid owners beside malformed liveness and registry records', () => {
    registry([null, {}, spawn()])
    writeFileSync(join(root, 'registry', 'bad.jsonl'), '{broken\nnull\n')
    writeFileSync(join(root, 'live', 'bad.json'), '{broken')
    live({ agentId: SECOND }, SECOND)
    const text = notice().additionalContext
    expect(text).toContain(OWNER); expect(text).toContain(SECOND)
  })
  it('passes garbage stdin and internal failures with empty stdout', () => {
    expect(run(HOOK, '{garbage')).toMatchObject({ code: 0, stdout: '' })
    registry([spawn()])
    env.WT_FAIL_OPEN_TRACE_SELF_TEST = GUARD
    env.WT_SDK_ROLE_GUARD_FAILURE = 'closed'
    const r = run(HOOK, pre())
    expect(r).toMatchObject({ code: 0, stdout: '' })
    expect(r.stderr).toContain('FAILED OPEN')
  })
  it('observes silently and journals silent even after promotion', () => {
    registry([spawn()]); seedReviews(20); env.WT_GUARD_MODE = 'observe'; silent()
    expect(journal().at(-1)).toMatchObject({ decision: 'silent', class: 'duplicate-pilot', origin: 'test' })
  })
  it('warns at nineteen true reviews', () => {
    registry([spawn()]); seedReviews(19)
    const warning = notice()
    expect(warning.permissionDecision).toBeUndefined()
    expect(warning.additionalContext).toContain('19/20 reviewed true')
  })
  it('halts probation when a real firing is reviewed false', () => {
    registry([spawn()]); seedReviews(20, 'real', 1)
    const warning = notice()
    expect(warning.additionalContext).toContain('probation halted')
    expect(warning.permissionDecision, 'a false review must keep the guard warn-only').toBeUndefined()
  })
  it('never promotes when part of the probation journal cannot be read', () => {
    registry([spawn()]); seedReviews(20, 'real', 1)
    // The false-reviewed firing (index 20) moves to its own week file and is truncated there, so
    // its verdict is orphaned: read naively, the journal shows 20 true firings and no false one.
    const week = join(root, 'journal', '2026-W39.ndjson')
    const lines = readFileSync(week, 'utf8').trim().split('\n')
    writeFileSync(week, lines.slice(0, 20).join('\n') + '\n')
    writeFileSync(join(root, 'journal', '2026-W40.ndjson'), lines[20]!.slice(0, 40) + '\n')
    const warning = notice()
    expect(warning.permissionDecision, 'incomplete probation evidence must never deny').toBeUndefined()
    expect(warning.additionalContext).toContain('probation evidence incomplete')
  })
  it('lets a resume of an existing pilot through, even after promotion', () => {
    registry([spawn()]); seedReviews(20)
    silent(pre(undefined, { tool_input: { subagent_type: 'pilot', prompt: `PILOT-CARD: ${CARD}`, resume: OWNER } }))
  })
  it.skipIf(process.platform === 'win32')('never blocks on a fresh FIFO in the registry, liveness or journal', () => {
    registry([spawn()])
    for (const file of ['registry/stuck.jsonl', 'live/stuck.json', 'journal/2026-W41.ndjson']) {
      expect(spawnSync('mkfifo', [join(root, file)]).status).toBe(0)
    }
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(pre()), encoding: 'utf8', env, timeout: HANG_BOUND_MS })
    expect(r.error, 'the hook must not block on a special file').toBeUndefined()
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain(OWNER)
  })
  it('applies a same-session NAMED ack to the liveness of the acked raw id too', () => {
    registry([spawn(OWNER, CARD, { childName: 'pilot-demo', at: '2026-10-03T11:00:00Z' }), { t: 'ack', name: 'pilot-demo', at: NOW }])
    live(); silent()
  })
  it('does not read an ack of an agent NAMED like a raw id as an ack of that raw id', () => {
    registry([spawn(OWNER, CARD, { at: '2026-10-03T11:00:00Z' })])
    registry([spawn('a9999999999999999', OTHER, { childName: OWNER, name: OWNER, at: '2026-10-03T11:00:00Z' }), { t: 'ack', name: OWNER, at: NOW }], 'other-session')
    expect(notice().additionalContext).toContain(OWNER)
  })
  it('journals a firing without a tool_use_id as unreviewable', () => {
    registry([spawn()])
    const payload: Record<string, unknown> = pre(); delete payload.tool_use_id
    notice(payload)
    expect(journal().at(-1).evidence.fid).toBeUndefined()
  })
  it.each(['test', 'unknown'])('does not count reviewed %s-origin firings', origin => {
    registry([spawn()]); seedReviews(20, origin)
    expect(notice().additionalContext).toContain('0/20 reviewed true')
  })
  it('does not promote twenty real-origin firings without human verdicts', () => {
    registry([spawn()]); seedReviews(20)
    rmSync(join(root, 'journal', 'wt-duplicate-pilot-guard-reviews.ndjson'))
    expect(notice().additionalContext).toContain('0/20 reviewed true')
  })
  it('reports a failed review append instead of acknowledging an unpersisted verdict', () => {
    const events = seedReviews(1)
    const reviews = join(root, 'journal', 'wt-duplicate-pilot-guard-reviews.ndjson')
    rmSync(reviews); mkdirSync(reviews)
    const r = run(HOOK, '', ['review', '--mark', events[0]!.evidence.fid, 'true'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('FAILED OPEN')
  })
  it('keeps review verdicts out of the shared weekly journal window', () => {
    seedReviews(1)
    const summary = moduleValue(JOURNAL_READER, 'm.readGuardJournal({ baseDir: process.env.WT_GUARD_JOURNAL_DIR })')
    expect(summary.weekFiles).toEqual(['2026-W39.ndjson'])
    expect(summary.rows).toEqual([expect.objectContaining({ guard: GUARD, total: 1 })])
  })
  it('deduplicates firings and repeated reviews and uses the latest verdict', () => {
    registry([spawn()]); const events = seedReviews(19)
    writeFileSync(join(root, 'journal', '2026-W40.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
    const fid = events[0]!.evidence.fid
    run(HOOK, '', ['review', '--mark', fid, 'false'])
    expect(notice().additionalContext).toContain('probation halted')
    run(HOOK, '', ['review', '--mark', fid, 'true'])
    run(HOOK, '', ['review', '--mark', fid, 'true'])
    expect(notice().additionalContext).toContain('19/20 reviewed true')
    const listed = run(HOOK, '', ['review', '--list'])
    expect(listed.code).toBe(0)
    expect(listed.stdout.split('\n').map(l => JSON.parse(l)).filter(event => event.fid === fid)).toHaveLength(1)
  })
  it('never counts pending, unrelated, or override events and rejects unknown review ids', () => {
    registry([spawn()])
    const events = seedReviews(20)
    const unrelated = events.map((event, index) => ({ ...event,
      ...(index < 7 ? { guard: 'other-guard.mjs' } : index < 14 ? { class: 'respawn-of' } : { evidence: { ...event.evidence, version: 'v1' } }),
    }))
    writeFileSync(join(root, 'journal', '2026-W39.ndjson'), unrelated.map(e => JSON.stringify(e)).join('\n') + '\n')
    const r = run(HOOK, '', ['review', '--mark', 'ffffffffffffffff', 'true'])
    expect(r.code).toBe(1)
    expect(notice().additionalContext).toContain('0/20 reviewed true')
  })
  it('keeps name acks scoped to their registry file', () => {
    registry([spawn(OWNER, CARD, { childName: 'pilot-demo', at: '2026-10-03T11:00:00Z' })])
    registry([{ t: 'ack', name: 'pilot-demo', at: NOW }], 'other-session')
    expect(notice().additionalContext).toContain(OWNER)
    registry([spawn(OWNER, CARD, { childName: 'pilot-demo', at: '2026-10-03T11:00:00Z' }), { t: 'ack', name: 'pilot-demo', at: NOW }])
    silent()
  })
  it('ignores stop as completion and renews registry activity by raw id', () => {
    registry([spawn(OWNER, CARD, { at: OLD }), { t: 'stop', agentId: OWNER, at: NOW }])
    expect(notice().additionalContext).toContain(OWNER)
  })
  it.each(['NaN', '0', '-1', 'Infinity', '1e308'])('defaults an invalid horizon %s to twelve hours', horizon => {
    env.WT_DUPLICATE_PILOT_HORIZON_H = horizon
    live({ updatedAt: '2026-10-03T11:00:00Z' })
    expect(notice().additionalContext).toContain(OWNER)
    live({ updatedAt: OLD }); silent()
  })
  it('rejects unparseable freshness, clamps future time, and honors the horizon boundary', () => {
    live({ updatedAt: 'invalid' }); silent()
    live({ updatedAt: '2027-01-01T00:00:00Z' }); expect(notice().additionalContext).toContain(OWNER)
    live({ updatedAt: '2026-10-03T00:00:00Z' }); expect(notice().additionalContext).toContain(OWNER)
    env.WT_DUPLICATE_PILOT_HORIZON_H = '1'; silent()
  })
  it('uses short digest evidence without leaking raw owner identities into evidence', () => {
    registry([spawn()]); notice()
    const event = journal().at(-1)
    expect(event.evidence.fid).toMatch(/^[a-f0-9]{16}$/)
    expect(event.evidence.owner).toMatch(/^[a-f0-9]{16}$/)
    expect(event.evidence.owner).not.toBe(OWNER)
    expect(event.cwd).toBe(root)
  })
  it('requires both unresolved name and raw-id owners and retains both source references', () => {
    registry([spawn()]); live({ agentId: 'named-pilot', agentIdSource: 'name' }, 'named-pilot')
    const text = notice(pre(`PILOT-CARD: ${CARD}\nRESPAWN-OF: ${OWNER}`)).additionalContext
    expect(text).toContain('named-pilot')
    expect(text).toContain('named-pilot.json')
    silent(pre(`PILOT-CARD: ${CARD}\nRESPAWN-OF: ${OWNER}, named-pilot`))
  })
  it('deduplicates one owner across sources without modifying ownership state', () => {
    registry([spawn()]); live()
    const before = ['registry/session-demo.jsonl', `live/${OWNER}.json`].map(file => readFileSync(join(root, file), 'utf8'))
    const text = notice().additionalContext
    expect(text).toContain('liveness')
    expect(text).toContain('registry')
    expect(text).toContain(`RESPAWN-OF: ${OWNER}\n`)
    expect(['registry/session-demo.jsonl', `live/${OWNER}.json`].map(file => readFileSync(join(root, file), 'utf8'))).toEqual(before)
    expect(readdirSync(join(root, 'live'))).toEqual([`${OWNER}.json`])
    expect(readdirSync(join(root, 'registry'))).toEqual(['session-demo.jsonl'])
  })
  it('passes unreadable ownership sources and still prints when the journal cannot append', () => {
    env.WT_LIVENESS_DIR = join(root, 'absent-live')
    env.WT_OUTBOUND_GUARD_DIR = join(root, 'absent-registry')
    silent()
    env.WT_OUTBOUND_GUARD_DIR = join(root, 'registry'); registry([spawn()])
    const file = join(root, 'not-a-directory'); writeFileSync(file, '')
    env.WT_GUARD_JOURNAL_DIR = file
    expect(notice().additionalContext).toContain(OWNER)
  })
})

describe('pilot ownership declarations', () => {
  it('prefers explicit lines to assignment and dependency ids and deduplicates', () => {
    expect(parse(`You are the pilot for card: ${OTHER}\nPILOT-CARD: ${CARD}\nPILOT-CARDS: ${CARD}, ${OTHER}`)).toEqual([CARD, OTHER])
    expect(parse(`PILOT-CARDS: ${OTHER}\nPILOT-CARD: ${CARD}`)).toEqual([OTHER, CARD])
  })
  it('recognizes the assignment sentence only within its compatibility window', () => {
    expect(parse(`You are the pilot for ONE Planka card: ${CARD}.`)).toEqual([CARD])
    expect(parse(`Dependency card: ${OTHER}\n\nAn unrelated brief cites ${CARD}`)).toEqual([])
    expect(parse(`${'x'.repeat(401)} pilot for card: ${CARD}`)).toEqual([])
  })
  it('does not open a fence on an indented line or a backtick run that closes on the same line', () => {
    expect(parse(`    \`\`\`example\`\`\`\nPILOT-CARD: ${CARD}`)).toEqual([CARD])
    expect(parse(`\`\`\`example\`\`\`\nPILOT-CARD: ${CARD}`)).toEqual([CARD])
  })
  it('ignores fenced or indented declarations and partial numeric ids', () => {
    expect(parse(`\`\`\`\nPILOT-CARD: ${CARD}\n\`\`\`\n PILOT-CARD: ${OTHER}`)).toEqual([])
    expect(parse(`PILOT-CARD: 1${CARD}2`)).toEqual([])
  })
  it('parses raw override tokens outside fences at column zero', () => {
    expect(parse(`RESPAWN-OF: ${OWNER}, ${SECOND}\n\`\`\`\nRESPAWN-OF: ignored\n\`\`\`\n RESPAWN-OF: ignored`, 'respawnOf')).toEqual([OWNER, SECOND])
  })
  it('does not close a fence on a language-tagged marker inside its contents', () => {
    expect(parse(`\`\`\`text\n\`\`\`js\nRESPAWN-OF: ${OWNER}\n\`\`\``, 'respawnOf')).toEqual([])
  })
})

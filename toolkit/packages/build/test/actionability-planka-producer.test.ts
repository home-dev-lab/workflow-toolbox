import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PRODUCER_HOOK = join(REPO_ROOT, 'plugin/bin/wt-actionable-snapshot-producer-hook.mjs')
const CORE = join(REPO_ROOT, 'plugin/bin/lib/actionability-planka-producer-core.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wt-actionable-producer-${tag}-`))
  roots.push(root)
  return root
}

function slug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}

// A byte-identical copy of the REAL project parser's algorithm — deliberately
// hand-authored here, not imported, so the fixture stays independent of the
// project file the hook shells out to at runtime. Card 1835336444730672310's
// lesson (a prose restatement under-covers) is about NOT re-deriving the rule
// inside the pilot/skill layer; a test fixture exercising the real subprocess
// contract is a different concern and is what the integration tests below do.
const FAKE_DEPENDS_ON_PARSER = `
function parseDependsOn(description) {
  const text = String(description || '')
  const ids = new Set()
  const unparseable = []
  for (const line of text.split(/\\r?\\n/)) {
    const trimmed = line.trim()
    const stripped = trimmed.replace(/^[\`*_>#-]+\\s*/, '')
    if (!/^depends-on:/i.test(stripped)) continue
    const remainder = stripped.slice('Depends-on:'.length).trim()
    if (/^none\\b/i.test(remainder)) continue
    let found = false
    for (const raw of remainder.split(',')) {
      const seg = raw.trim()
      if (!seg) continue
      const m = seg.match(/(\\d{4,})/)
      if (m) { ids.add(m[1]); found = true }
    }
    if (!found) unparseable.push(trimmed)
  }
  return { ids: [...ids], unparseable }
}
let chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify(parseDependsOn(Buffer.concat(chunks).toString('utf8'))))
})
`

function scaffoldProject(tag: string, opts: { withParser: boolean; withBoardPointer?: boolean }) {
  const root = mkRoot(tag)
  const home = join(root, 'home')
  const state = join(root, 'state')
  const cwd = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(state, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  if (opts.withBoardPointer !== false) {
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude/planka.json'), JSON.stringify({ boardId: 'b1' }), 'utf8')
  }
  if (opts.withParser) {
    const parserDir = join(cwd, '.claude/scripts/lib')
    mkdirSync(parserDir, { recursive: true })
    writeFileSync(join(parserDir, 'depends-on-parser.mjs'), FAKE_DEPENDS_ON_PARSER, 'utf8')
  }
  return {
    root,
    cwd,
    stateDir: join(state, 'wt-actionable'),
    env: { ...process.env, HOME: home, XDG_STATE_HOME: state },
  }
}

function runProducerHook(payload: unknown, env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const res = spawnSync(process.execPath, [PRODUCER_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env })
  return { status: res.status, stderr: (res.stderr ?? '').trim() }
}

function boardResponse(lists: Array<{ name: string; cards: Array<{ id: string; name: string; description?: string; position?: number }> }>) {
  return { content: [{ type: 'text', text: JSON.stringify({ id: 'board-1', lists }) }] }
}

function findCardsResponse(cards: Array<{ id: string; name: string; description?: string; listName: string; position?: number }>) {
  return { content: [{ type: 'text', text: JSON.stringify(cards) }] }
}

function spilledResponse(path: string) {
  return {
    content: [{
      type: 'text',
      text: `Error: result (3,281,608 characters across 20,000 lines) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text`,
    }],
  }
}

function readSnapshot(stateDir: string, cwd: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, `${slug(cwd)}.json`), 'utf8'))
  } catch {
    return null
  }
}

function readFailureRecords(stateDir: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(stateDir, 'actionable-producer-journal.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

describe('actionability-planka-producer-core', () => {
  it('extractCards: get_board with a full lists[] array is accepted', () => {
    const script = [
      `import { extractCards } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `const r = extractCards({ toolName: 'mcp__planka__get_board', toolInput: {}, toolResponse: ${JSON.stringify(
        boardResponse([{ name: 'Next', cards: [{ id: '1', name: 'A', position: 1 }] }]),
      )} })`,
      'process.stdout.write(JSON.stringify(r))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.cards).toHaveLength(1)
  })

  it('extractCards: a FILTERED find_cards call is refused, not treated as complete', () => {
    const script = [
      `import { extractCards } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `const r = extractCards({ toolName: 'mcp__planka__find_cards', toolInput: { list: 'Next' }, toolResponse: ${JSON.stringify(
        findCardsResponse([{ id: '1', name: 'A', listName: 'Next' }]),
      )} })`,
      'process.stdout.write(JSON.stringify(r))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    const parsed = JSON.parse(res.stdout)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('find_cards called with a filter — result is a subset, not the whole board')
  })

  it('resolveBoardProjectDir: a cwd below a project resolves to the nearest ancestor with a board pointer', () => {
    const root = mkRoot('core-ancestor')
    const project = join(root, 'project')
    const nested = join(project, 'packages/app')
    mkdirSync(join(project, '.claude'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(project, '.claude/planka.json'), '{}', 'utf8')
    const script = [
      `import { existsSync } from 'node:fs'`,
      `import { resolveBoardProjectDir } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `process.stdout.write(resolveBoardProjectDir(${JSON.stringify(nested)}, existsSync) ?? '')`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe(project)
  })

  it('resolveBoardProjectDir: a cwd with no pointer-bearing ancestor returns null', () => {
    const root = mkRoot('core-no-ancestor')
    const nested = join(root, 'project/packages/app')
    mkdirSync(nested, { recursive: true })
    const script = [
      `import { existsSync } from 'node:fs'`,
      `import { resolveBoardProjectDir } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `process.stdout.write(JSON.stringify(resolveBoardProjectDir(${JSON.stringify(nested)}, existsSync)))`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout)).toBeNull()
  })

  it('extractCards: a get_board LIST WITH NO cards[] ARRAY is refused (truncated, not "empty") — review finding 1', () => {
    const script = [
      `import { extractCards } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `const r = extractCards({ toolName: 'mcp__planka__get_board', toolInput: {}, toolResponse: ${JSON.stringify(
        { content: [{ type: 'text', text: JSON.stringify({ id: 'b1', lists: [{ name: 'Next' }] }) }] },
      )} })`,
      'process.stdout.write(JSON.stringify(r))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    const parsed = JSON.parse(res.stdout)
    expect(parsed.ok).toBe(false)
  })

  it('extractCards: an UNREADABLE CARD (no id) makes the whole extraction fail, never a silently-shrunk set — review finding 2', () => {
    const script = [
      `import { extractCards } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `const r = extractCards({ toolName: 'mcp__planka__get_board', toolInput: {}, toolResponse: ${JSON.stringify(
        boardResponse([{ name: 'Done', cards: [{ id: '', name: 'no id here', position: 0 }] }]),
      )} })`,
      'process.stdout.write(JSON.stringify(r))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    const parsed = JSON.parse(res.stdout)
    expect(parsed.ok).toBe(false)
  })

  it('extractCards: an UNFILTERED find_cards call is accepted', () => {
    const script = [
      `import { extractCards } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `const r = extractCards({ toolName: 'mcp__planka__find_cards', toolInput: {}, toolResponse: ${JSON.stringify(
        findCardsResponse([{ id: '1', name: 'A', listName: 'Next' }]),
      )} })`,
      'process.stdout.write(JSON.stringify(r))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    const parsed = JSON.parse(res.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.cards).toHaveLength(1)
  })

  it('computeSnapshot: counts a card actionable only when every dependency resolves to Done, and names its scope', () => {
    const cards = [
      { id: '10', name: 'Done dep', description: '', listName: 'Done', position: 0 },
      { id: '20', name: 'Ready card', description: 'Depends-on: #10', listName: 'Next', position: 1 },
      { id: '21', name: 'Blocked card', description: 'Depends-on: #999', listName: 'Next', position: 2 },
      { id: '22', name: 'No deps', description: '', listName: 'Backlog', position: 3 },
      { id: '23', name: 'Unparseable', description: 'Depends-on: the other thing', listName: 'Backlog', position: 4 },
    ]
    const script = [
      `import { computeSnapshot } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `const parseDependsOn = (d) => {`,
      `  const ids = []; const un = []`,
      `  const m = /Depends-on:\\s*#(\\d+)/.exec(d)`,
      `  if (/Depends-on:/.test(d) && !m) un.push(d)`,
      `  if (m) ids.push(m[1])`,
      `  return { ids, unparseable: un }`,
      `}`,
      `const r = computeSnapshot({ cards: ${JSON.stringify(cards)}, resolveDeps: parseDependsOn, boardId: 'b1', now: 1000 })`,
      'process.stdout.write(JSON.stringify(r))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    const r = JSON.parse(res.stdout)
    // startable = Next(20,21) + Backlog(22,23) = 4 cards; actionable = 20 and 22 = 2
    expect(r.actionable).toBe(2)
    expect(r.next).toBe('#20 Ready card')
    expect(r.countedScope).toMatch(/4 scanned/)
    expect(r.countedScope).toMatch(/2 with every Depends-on resolved/)
    expect(r.countedScope).toMatch(/2 unresolved/)
  })
})

describe('wt-actionable-snapshot-producer-hook (integration)', () => {
  it('records distinct failure reasons and records success too', () => {
    const diverted = scaffoldProject('diverted', { withParser: true })
    const divertedResult = runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: { boardId: 'b1' },
      cwd: diverted.cwd,
    }, diverted.env)
    expect(divertedResult.status).toBe(0)
    const divertedRecords = readFailureRecords(diverted.stateDir)
    expect(divertedRecords).toHaveLength(1)
    expect(divertedRecords[0]).toMatchObject({ ok: false, reason: 'payload-diverted-or-too-large' })

    const unparseable = scaffoldProject('unparseable', { withParser: true })
    const unparseableResult = runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: { boardId: 'b1' },
      tool_response: { content: [{ type: 'text', text: 'not JSON' }] },
      cwd: unparseable.cwd,
    }, unparseable.env)
    expect(unparseableResult.status).toBe(0)
    const unparseableRecords = readFailureRecords(unparseable.stateDir)
    expect(unparseableRecords).toHaveLength(1)
    expect(unparseableRecords[0]).toMatchObject({ ok: false, reason: 'payload-unparseable' })
    expect(unparseableRecords[0]!.reason).not.toBe(divertedRecords[0]!.reason)

    const noBoard = scaffoldProject('no-board', { withParser: false, withBoardPointer: false })
    expect(runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: {},
      cwd: noBoard.cwd,
    }, noBoard.env).status).toBe(0)
    expect(readFailureRecords(noBoard.stateDir)[0]).toMatchObject({ ok: false, reason: 'no-board-pointer' })

    const success = scaffoldProject('journal-success', { withParser: true })
    expect(runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([{ name: 'Next', cards: [] }]),
      cwd: success.cwd,
    }, success.env).status).toBe(0)
    expect(readSnapshot(success.stateDir, success.cwd)).not.toBeNull()
    expect(readFailureRecords(success.stateDir)).toEqual([
      expect.objectContaining({ ok: true, reason: 'snapshot-written', projectDir: success.cwd }),
    ])
  })

  it('writes a snapshot from the complete JSON in an oversized-result spill file', () => {
    const project = scaffoldProject('spilled', { withParser: true })
    const spillPath = join(project.root, 'spilled-board.txt')
    writeFileSync(spillPath, JSON.stringify({
      id: 'board-1',
      lists: [{ name: 'Next', cards: [{ id: '100020', name: 'Ready', position: 1 }] }],
    }), 'utf8')
    const res = runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: spilledResponse(spillPath),
      cwd: project.cwd,
    }, project.env)
    expect(res.status).toBe(0)
    expect(readSnapshot(project.stateDir, project.cwd)).toMatchObject({ actionable: 1 })
  })

  it('refuses an oversized-result spill path that does not exist without throwing', () => {
    const project = scaffoldProject('missing-spill', { withParser: true })
    const missingPath = join(project.root, 'does-not-exist.txt')
    const res = runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: spilledResponse(missingPath),
      cwd: project.cwd,
    }, project.env)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe('')
    expect(readSnapshot(project.stateDir, project.cwd)).toBeNull()
    expect(readFailureRecords(project.stateDir)).toEqual([
      expect.objectContaining({ ok: false, reason: 'payload-unparseable' }),
    ])
  })

  it('refuses a relative oversized-result spill path even when that file exists', () => {
    const project = scaffoldProject('relative-spill', { withParser: true })
    writeFileSync(join(project.cwd, 'relative-board.txt'), JSON.stringify({ lists: [] }), 'utf8')
    const res = runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: spilledResponse('relative-board.txt'),
      cwd: project.cwd,
    }, project.env)
    expect(res.status).toBe(0)
    expect(readSnapshot(project.stateDir, project.cwd)).toBeNull()
    expect(readFailureRecords(project.stateDir)).toEqual([
      expect.objectContaining({ ok: false, reason: 'payload-unparseable' }),
    ])
  })

  it('uses the pointer-bearing project ancestor as the snapshot key', () => {
    const project = scaffoldProject('nested-cwd', { withParser: true })
    const nested = join(project.cwd, 'worktrees/card/toolkit')
    mkdirSync(nested, { recursive: true })
    expect(runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([{ name: 'Next', cards: [] }]),
      cwd: nested,
    }, project.env).status).toBe(0)
    expect(readSnapshot(project.stateDir, project.cwd)).not.toBeNull()
    expect(readSnapshot(project.stateDir, nested)).toBeNull()
  })

  it('never throws on malformed hook input', () => {
    const { env } = scaffoldProject('malformed', { withParser: true })
    for (const payload of [null, [], 'broken', 42, { hook_event_name: 'PostToolUse' }]) {
      expect(runProducerHook(payload, env).status).toBe(0)
    }
    const raw = spawnSync(process.execPath, [PRODUCER_HOOK], { input: '{', encoding: 'utf8', env })
    expect(raw.status).toBe(0)
  })

  it('bounds the failure journal to the latest 100 records', () => {
    const project = scaffoldProject('bounded-journal', { withParser: true })
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: { boardId: 'b1' },
      cwd: project.cwd,
    }
    for (let i = 0; i < 105; i += 1) expect(runProducerHook(payload, project.env).status).toBe(0)
    expect(readFailureRecords(project.stateDir)).toHaveLength(100)
  })

  it('writes a snapshot from a real get_board response, using the real (fixture) dependency parser subprocess', () => {
    const { cwd, stateDir, env } = scaffoldProject('write', { withParser: true })
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([
        // Real Planka card ids are long numeric strings; the project's real dependency
        // parser only matches \d{4,} — short ids like "10" would silently fail to parse
        // as a dependency, which is a fixture bug, not a producer bug. Use realistic ids.
        { name: 'Done', cards: [{ id: '100010', name: 'Done dep', position: 0 }] },
        { name: 'Next', cards: [{ id: '100020', name: 'Ready', description: 'Depends-on: #100010', position: 1 }] },
        { name: 'Backlog', cards: [{ id: '100030', name: 'Also ready', position: 2 }] },
      ]),
      cwd,
    }
    const res = runProducerHook(payload, env)
    expect(res.status).toBe(0)
    const snap = readSnapshot(stateDir, cwd)
    expect(snap).not.toBeNull()
    expect(snap!.actionable).toBe(2)
    expect(typeof snap!.at).toBe('number')
    expect(snap!.workPossible).toBe(true)
    expect(snap!.blockedUntil).toBeNull()
    expect(typeof snap!.countedScope).toBe('string')
    expect(String(snap!.countedScope)).toMatch(/2 scanned/)
  })

  it('writes NOTHING when the dependency-parser convention does not exist in this project (no wrong count)', () => {
    const { cwd, stateDir, env } = scaffoldProject('noparser', { withParser: false })
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([{ name: 'Next', cards: [{ id: '20', name: 'Ready', position: 1 }] }]),
      cwd,
    }
    const res = runProducerHook(payload, env)
    expect(res.status).toBe(0)
    expect(readSnapshot(stateDir, cwd)).toBeNull()
  })

  it('writes NOTHING on a filtered find_cards call, even though real card data was in the payload', () => {
    const { cwd, stateDir, env } = scaffoldProject('filtered', { withParser: true })
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: { boardId: 'b1', list: 'Next' },
      tool_response: findCardsResponse([{ id: '20', name: 'Ready', listName: 'Next', position: 1 }]),
      cwd,
    }
    const res = runProducerHook(payload, env)
    expect(res.status).toBe(0)
    expect(readSnapshot(stateDir, cwd)).toBeNull()
  })

  it('writes NOTHING when the dependency-parser replies with non-array ids/unparseable — review finding 3', () => {
    const { cwd, stateDir, env } = scaffoldProject('badparser', { withParser: false })
    const parserDir = join(cwd, '.claude/scripts/lib')
    mkdirSync(parserDir, { recursive: true })
    // A parser that replies with a STRUCTURALLY WRONG (but syntactically valid JSON) shape.
    // Before the fix this coerced to {ids:[], unparseable:[]} — "no dependency" — and made
    // every card on the board falsely actionable. Now it must abort the whole write.
    writeFileSync(join(parserDir, 'depends-on-parser.mjs'), "process.stdout.write(JSON.stringify({ids: 'not-an-array', unparseable: []}))", 'utf8')
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([{ name: 'Next', cards: [{ id: '100020', name: 'Ready', description: 'Depends-on: #100010', position: 1 }] }]),
      cwd,
    }
    const res = runProducerHook(payload, env)
    expect(res.status).toBe(0)
    expect(readSnapshot(stateDir, cwd)).toBeNull()
  })

  it('a RELATIVE cwd in the hook payload is resolved before writing — matches the consumer\'s own resolve() — review finding 4', () => {
    const { cwd, stateDir, env } = scaffoldProject('relcwd', { withParser: true })
    const parentDir = dirname(cwd)
    const baseName = cwd.slice(parentDir.length + 1)
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([{ name: 'Next', cards: [] }]),
      cwd: baseName, // relative, resolved against the CHILD PROCESS's own cwd below
    }
    const res = spawnSync(process.execPath, [PRODUCER_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, cwd: parentDir })
    expect(res.status).toBe(0)
    // Must land at the slug for the RESOLVED absolute cwd (what the consumer reads), never
    // at a slug derived from the raw relative string.
    expect(readSnapshot(stateDir, cwd)).not.toBeNull()
  })

  it('MUTATION LOCK: reverting the filter check makes the hook write a wrong snapshot from a partial read', () => {
    // Proves the "never write from a filtered call" test above actually exercises real
    // code, not a fixture that would pass either way: run the SAME filtered-call payload
    // against a deliberately mutated copy of the core file with the filter guard removed,
    // and confirm it now (wrongly) writes a snapshot claiming full-board knowledge.
    const { cwd, stateDir, env } = scaffoldProject('mutated', { withParser: true })
    const mutatedRoot = mkRoot('mutated-core')
    const mutatedBinDir = join(mutatedRoot, 'bin')
    const mutatedLibDir = join(mutatedBinDir, 'lib')
    mkdirSync(mutatedLibDir, { recursive: true })

    const coreSrc = readFileSync(CORE, 'utf8')
    const mutatedCore = coreSrc.replace(
      "if (filtered) return { ok: false, reason: 'find_cards called with a filter — result is a subset, not the whole board' }",
      '// MUTATED: filter guard removed',
    )
    expect(mutatedCore).not.toBe(coreSrc) // the replace must actually have matched
    writeFileSync(join(mutatedLibDir, 'actionability-planka-producer-core.mjs'), mutatedCore, 'utf8')
    writeFileSync(join(mutatedLibDir, 'fail-open-trace.mjs'), readFileSync(join(REPO_ROOT, 'plugin/bin/lib/fail-open-trace.mjs'), 'utf8'), 'utf8')
    writeFileSync(
      join(mutatedLibDir, 'actionability-state-paths.mjs'),
      readFileSync(join(REPO_ROOT, 'plugin/bin/lib/actionability-state-paths.mjs'), 'utf8'),
      'utf8',
    )
    const hookSrc = readFileSync(PRODUCER_HOOK, 'utf8')
    writeFileSync(join(mutatedBinDir, 'wt-actionable-snapshot-producer-hook.mjs'), hookSrc, 'utf8')

    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: { boardId: 'b1', list: 'Next' },
      tool_response: findCardsResponse([{ id: '20', name: 'Ready', listName: 'Next', position: 1 }]),
      cwd,
    }
    const res = spawnSync(process.execPath, [join(mutatedBinDir, 'wt-actionable-snapshot-producer-hook.mjs')], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env,
    })
    expect(res.status).toBe(0)
    // The mutated (unguarded) version DOES write from the partial read — proving the real
    // guard in the unmutated file is what makes the "writes NOTHING" test above meaningful.
    expect(readSnapshot(stateDir, cwd)).not.toBeNull()
  })
})

describe('producer output is consumable by the real consumer decide()', () => {
  function runDecide(input: unknown): Record<string, unknown> {
    const script = [
      `import { decide } from ${JSON.stringify(new URL(join(REPO_ROOT, 'plugin/bin/lib/actionability-core.mjs'), 'file://').href)}`,
      `const result = decide(${JSON.stringify(input)})`,
      'process.stdout.write(JSON.stringify(result))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    if (res.status !== 0) throw new Error(res.stderr || 'runDecide failed')
    return JSON.parse(res.stdout)
  }

  it('a fresh producer snapshot with actionable>0 makes the consumer hold (block)', () => {
    const { cwd, stateDir, env } = scaffoldProject('e2e-hold', { withParser: true })
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([{ name: 'Next', cards: [{ id: '20', name: 'Ready', position: 1 }] }]),
      cwd,
    }
    expect(runProducerHook(payload, env).status).toBe(0)
    const snap = readSnapshot(stateDir, cwd) as { at: number; actionable: number; next: string; workPossible: boolean; reason: string; blockedUntil: null; inFlightUntil: null }
    const decision = runDecide({ snapshot: { status: 'present', ...snap }, now: snap.at + 1000, staleAfterMs: 2 * 60 * 60 * 1000, consecutiveBlocks: 0, blockMax: 3 })
    expect(decision.block).toBe(true)
    expect(decision.reason).toBe('actionable-work-remains')
  })

  it('a fresh producer snapshot with actionable=0 makes the consumer pass', () => {
    const { cwd, stateDir, env } = scaffoldProject('e2e-pass', { withParser: true })
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([{ name: 'Next', cards: [] }]),
      cwd,
    }
    expect(runProducerHook(payload, env).status).toBe(0)
    const snap = readSnapshot(stateDir, cwd) as { at: number; actionable: number; next: string; workPossible: boolean; reason: string; blockedUntil: null; inFlightUntil: null }
    const decision = runDecide({ snapshot: { status: 'present', ...snap }, now: snap.at + 1000, staleAfterMs: 2 * 60 * 60 * 1000, consecutiveBlocks: 0, blockMax: 3 })
    expect(decision.block).toBe(false)
  })
})

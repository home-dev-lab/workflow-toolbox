import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PRODUCER_HOOK = join(REPO_ROOT, 'plugin/bin/wt-actionable-snapshot-producer-hook.mjs')
const GATE_HOOK = join(REPO_ROOT, 'plugin/bin/wt-actionable-gate-hook.mjs')
const CORE = join(REPO_ROOT, 'plugin/bin/lib/actionability-planka-producer-core.mjs')
const REFRESH_CLI = join(REPO_ROOT, 'plugin/bin/wt-actionable-snapshot-refresh.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wt-actionable-producer-${tag}-`)))
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
  const configDir = join(root, 'claude-config')
  const hookTmp = join(root, 'hook-tmp')
  const cwd = join(root, 'project')
  const mandateDir = join(state, 'wt-queue-gate')
  mkdirSync(home, { recursive: true })
  mkdirSync(state, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(hookTmp, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(mandateDir, { recursive: true })
  writeFileSync(
    join(mandateDir, `engine-${slug(cwd)}.json`),
    JSON.stringify({ declaredAtMs: Date.now(), sessionId: `sess-${tag}` }),
    'utf8',
  )
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
    configDir,
    stateDir: join(state, 'wt-actionable'),
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: undefined,
      HOME: home,
      XDG_STATE_HOME: state,
      CLAUDE_CONFIG_DIR: configDir,
      TMPDIR: hookTmp,
      TEMP: hookTmp,
      TMP: hookTmp,
      WT_AUTONOMY_WATCH_MANDATE_DIR: mandateDir,
    },
  }
}

function runProducerHook(payload: unknown, env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const res = spawnSync(process.execPath, [PRODUCER_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env })
  return { status: res.status, stderr: (res.stderr ?? '').trim() }
}

function runGateHook(payload: unknown, env: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
  const res = spawnSync(process.execPath, [GATE_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env })
  return { status: res.status, stdout: (res.stdout ?? '').trim() }
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

function readProjectState(stateDir: string, cwd: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, `${slug(cwd)}.project-state.json`), 'utf8'))
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
      `import { extractCards } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
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
      `import { extractCards } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
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
      `import { resolveBoardProjectDir } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
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
      `import { resolveBoardProjectDir } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
      `process.stdout.write(JSON.stringify(resolveBoardProjectDir(${JSON.stringify(nested)}, existsSync)))`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout)).toBeNull()
  })

  it('extractCards: a get_board LIST WITH NO cards[] ARRAY is refused (truncated, not "empty") — review finding 1', () => {
    const script = [
      `import { extractCards } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
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
      `import { extractCards } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
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
      `import { extractCards } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
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

  it('extractCards: a complete paginated find_cards response is accepted', () => {
    const response = {
      total: 1,
      offset: 0,
      limit: 10,
      cards: [{ id: '1', name: 'A', description: 'Depends-on: none', listName: 'Next' }],
    }
    const script = [
      `import { extractCards } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
      `const r = extractCards({ toolName: 'mcp__planka__find_cards', toolInput: { limit: 10, offset: 0, includeDescription: true }, toolResponse: { content: [{ type: 'text', text: ${JSON.stringify(JSON.stringify(response))} }] } })`,
      'process.stdout.write(JSON.stringify(r))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, cards: [{ id: '1', description: 'Depends-on: none' }] })
  })

  it('extractCards: a partial paginated find_cards response is refused with its measured extent', () => {
    const response = {
      total: 1162,
      offset: 0,
      limit: 10,
      cards: Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1), name: `Card ${index + 1}`, description: 'x'.repeat(100), listName: 'Done' })),
    }
    const script = [
      `import { extractCards } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
      `const r = extractCards({ toolName: 'mcp__planka__find_cards', toolInput: { limit: 10, offset: 0, includeDescription: true }, toolResponse: { content: [{ type: 'text', text: ${JSON.stringify(JSON.stringify(response))} }] } })`,
      'process.stdout.write(JSON.stringify(r))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(JSON.parse(res.stdout)).toEqual({
      ok: false,
      reason: 'find_cards page contains 10 of 1162 cards at offset 0 — result is a subset, not the whole board',
    })
  })

  it('collectCompleteCards: consumes an oversized board in bounded complete pages', () => {
    const script = [
      `import { collectCompleteCards } from ${JSON.stringify(pathToFileURL(REFRESH_CLI).href)}`,
      `const source = Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), description: 'x'.repeat(20_000) }))`,
      'const offsets = []',
      'const cards = await collectCompleteCards(async (offset, limit) => { offsets.push(offset); return { total: source.length, offset, limit, cards: source.slice(offset, offset + limit) } })',
      'process.stdout.write(JSON.stringify({ count: cards.length, offsets }))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({ count: 12, offsets: [0, 10] })
  })

  it('computeSnapshot: counts a card actionable only when every dependency resolves to Done, and names its scope', () => {
    const cards = [
      { id: '10', name: 'Done dep', description: '', listName: 'Done', position: 0 },
      { id: '20', name: 'Ready card', description: 'Depends-on: #10', listName: 'Next', position: 1 },
      { id: '21', name: 'Blocked card', description: 'Depends-on: #999', listName: 'Next', position: 2 },
      { id: '22', name: 'No deps', description: 'Depends-on: none', listName: 'Backlog', position: 3 },
      { id: '23', name: 'Unparseable', description: 'Depends-on: the other thing', listName: 'Backlog', position: 4 },
    ]
    const script = [
      `import { computeSnapshot } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
      `const parseDependsOn = (d) => {`,
      `  const ids = []; const un = []`,
      `  const m = /Depends-on:\\s*#(\\d+)/.exec(d)`,
      `  if (/Depends-on:/.test(d) && !m && !/Depends-on:\\s*none/i.test(d)) un.push(d)`,
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

  // The description check runs AFTER extraction, not inside it: the prior-art title index needs
  // only id/name/list and must keep being written from a summary read (prior-art-index.test.ts).
  function extractGetBoard(toolInput: unknown, lists: unknown[]): { ok: boolean; reason?: string; cards?: unknown[] } {
    const script = [
      `import { extractCards, checkDescriptionsPresent } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
      `const e = extractCards({ toolName: 'mcp__planka__get_board', toolInput: ${JSON.stringify(toolInput)}, toolResponse: ${JSON.stringify(
        { content: [{ type: 'text', text: JSON.stringify({ id: 'board-1', lists }) }] },
      )} })`,
      `if (!e.ok) throw new Error('extraction itself failed: ' + e.reason)`,
      `const c = checkDescriptionsPresent({ toolName: 'mcp__planka__get_board', toolInput: ${JSON.stringify(toolInput)}, extraction: e })`,
      'const r = c.ok ? { ok: true, cards: e.cards } : c',
      'process.stdout.write(JSON.stringify(r))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    if (res.status !== 0) throw new Error(res.stderr || 'extractGetBoard failed')
    return JSON.parse(res.stdout)
  }

  it('F4: a get_board summary read is refused, because descriptions are missing', () => {
    const r = extractGetBoard({ boardId: 'b1', cardsSummary: true },
      [{ name: 'Next', cards: [{ id: '1', name: 'A', description: 'Depends-on: none' }] }])
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('descriptions are missing')
  })

  it('F4: a get_board read where no card carries a description key is refused', () => {
    const r = extractGetBoard({ boardId: 'b1' },
      [{ name: 'Next', cards: [{ id: '1', name: 'A' }] }, { name: 'Done', cards: [{ id: '2', name: 'B' }] }])
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('descriptions are missing')
  })

  it('F4: a null or empty description stays readable, and an empty board is not refused', () => {
    const r = extractGetBoard({ boardId: 'b1' },
      [{ name: 'Next', cards: [{ id: '1', name: 'A', description: null }, { id: '2', name: 'B', description: '' }] }])
    expect(r.ok).toBe(true)
    expect(r.cards).toHaveLength(2)
    expect(extractGetBoard({ boardId: 'b1' }, [{ name: 'Next', cards: [] }]).ok).toBe(true)
  })

  it('C1: a get_board read where ONE card lacks the description key is refused', () => {
    const r = extractGetBoard({ boardId: 'b1' }, [{ name: 'Next', cards: [
      { id: '1', name: 'A', description: 'Depends-on: none' },
      { id: '2', name: 'B' },
    ] }])
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('descriptions are missing')
  })

  it('C1: a complete find_cards page whose cards carry no description key is refused', () => {
    const toolInput = { boardId: 'b1', limit: 10, offset: 0 }
    const page = { total: 2, offset: 0, cards: [{ id: '1', name: 'A', listName: 'Next' }, { id: '2', name: 'B', listName: 'Done' }] }
    const script = [
      `import { extractCards, checkDescriptionsPresent } from ${JSON.stringify(pathToFileURL(CORE).href)}`,
      `const e = extractCards({ toolName: 'mcp__planka__find_cards', toolInput: ${JSON.stringify(toolInput)}, toolResponse: ${JSON.stringify(
        { content: [{ type: 'text', text: JSON.stringify(page) }] },
      )} })`,
      `if (!e.ok) throw new Error('extraction itself failed: ' + e.reason)`,
      `process.stdout.write(JSON.stringify(checkDescriptionsPresent({ toolName: 'mcp__planka__find_cards', toolInput: ${JSON.stringify(toolInput)}, extraction: e })))`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    const r = JSON.parse(res.stdout)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('descriptions are missing')
  })
})

describe('wt-actionable-snapshot-producer-hook (integration)', () => {
  it('declares a heartbeat when an opted-in producer cannot read the board', () => {
    const project = scaffoldProject('producer-heartbeat', { withParser: true })
    const result = runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: { boardId: 'b1' },
      tool_response: { content: [{ type: 'text', text: 'tracker unavailable' }] },
      cwd: project.cwd,
    }, project.env)

    expect(result.status).toBe(0)
    expect(readSnapshot(project.stateDir, project.cwd)).toBeNull()
    expect(readProjectState(project.stateDir, project.cwd)).toMatchObject({
      optedIn: true,
      lastOutcome: 'unreachable',
    })
    expect(readProjectState(project.stateDir, project.cwd)?.heartbeatAt).toEqual(expect.any(Number))
  })

  it('an oversized tool response records the bounded refresh command instead of requiring another board dump', () => {
    const project = scaffoldProject('oversized-remedy', { withParser: true })
    const result = runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: {
        content: [{
          type: 'text',
          text: 'Error: result (1,791,632 characters across 50,527 lines) exceeds maximum allowed tokens.',
        }],
      },
      cwd: project.cwd,
    }, project.env)

    expect(result.status).toBe(0)
    expect(readSnapshot(project.stateDir, project.cwd)).toBeNull()
    expect(readFailureRecords(project.stateDir)).toEqual([
      expect.objectContaining({
        ok: false,
        reason: 'payload-diverted-or-too-large',
        detail: `Run exactly: node "${REFRESH_CLI}"`,
      }),
    ])
  })

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
    // Under an ALLOWED spill root (the active config dir's projects/ tree), which is
    // where the harness actually spills. A path outside those roots is refused by
    // design and has its own test below — this one is about reading a real spill.
    const spillDir = join(project.configDir, 'projects', 'project-slug', 'session-id', 'tool-results')
    mkdirSync(spillDir, { recursive: true })
    const spillPath = join(spillDir, 'spilled-board.txt')
    writeFileSync(spillPath, JSON.stringify({
      id: 'board-1',
      lists: [{ name: 'Next', cards: [{ id: '100020', name: 'Ready', description: 'Depends-on: none', position: 1 }] }],
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
    // Inside an allowed root, so the refusal this test names is the one it gets.
    const missingPath = join(project.configDir, 'projects', 'does-not-exist.txt')
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
    // TWO records, and both are wanted: the hook names WHY it refused to read the
    // path, then the extraction reports that it had no payload. Either alone leaves
    // a reader guessing which half failed.
    expect(readFailureRecords(project.stateDir)).toEqual([
      expect.objectContaining({ ok: false, reason: 'spill-payload-refused' }),
      expect.objectContaining({ ok: false, reason: 'payload-unparseable' }),
    ])
    expect(readProjectState(project.stateDir, project.cwd)?.lastReason).toBe('spill-payload-refused')
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

  // Card 1860387857: exercise the journal bound in-process instead of paying for
  // 105 synchronous hook spawns inside Vitest's fixed timeout.
  it('bounds the failure journal to the latest 100 records', async () => {
    const project = scaffoldProject('bounded-journal', { withParser: true })
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: { boardId: 'b1' },
      cwd: project.cwd,
    }
    expect(runProducerHook(payload, project.env).status).toBe(0)
    // Node 24's native ESM require avoids Vite transforming this repository-root module.
    const hookModule = createRequire(pathToFileURL(PRODUCER_HOOK).href)(PRODUCER_HOOK)
    for (let i = 0; i < 104; i += 1) {
      hookModule.writeJournalEntry(project.stateDir, project.cwd, false, 'bound-probe', 'seam-exercised record')
    }
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
        { name: 'Done', cards: [{ id: '100010', name: 'Done dep', description: '', position: 0 }] },
        { name: 'Next', cards: [{ id: '100020', name: 'Ready', description: 'Depends-on: #100010', position: 1 }] },
        { name: 'Backlog', cards: [{ id: '100030', name: 'Also ready', description: 'Depends-on: none', position: 2 }] },
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

  it('writes a snapshot when the harness spills the board payload under the active config dir tool-results path', () => {
    const { cwd, stateDir, env, configDir } = scaffoldProject('spilled', { withParser: true })
    const spillPath = join(configDir, 'projects', 'project-slug', 'session-id', 'tool-results', 'planka-board.json')
    mkdirSync(dirname(spillPath), { recursive: true })
    writeFileSync(spillPath, JSON.stringify({
      id: 'board-1',
      lists: [
        { name: 'Done', cards: [{ id: '100010', name: 'Done dep', description: '', position: 0 }] },
        { name: 'Next', cards: [{ id: '100020', name: 'Ready', description: 'Depends-on: #100010', position: 1 }] },
      ],
    }), 'utf8')
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: spilledResponse(spillPath),
      cwd,
    }
    const res = runProducerHook(payload, env)
    expect(res.status).toBe(0)
    const snap = readSnapshot(stateDir, cwd)
    expect(snap).not.toBeNull()
    expect(snap!.actionable).toBe(1)
  })

  it('writes a snapshot using the shipped parser when the project has no parser', () => {
    const { cwd, stateDir, env } = scaffoldProject('noparser', { withParser: false })
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([{ name: 'Next', cards: [{ id: '20', name: 'Ready', description: 'Depends-on: none', position: 1 }] }]),
      cwd,
    }
    const res = runProducerHook(payload, env)
    expect(res.status).toBe(0)
    expect(readSnapshot(stateDir, cwd)).toMatchObject({ actionable: 1, undeclared: 0 })
    expect(readSnapshot(stateDir, cwd)?.countedScope).toContain('shipped parser')
  })

  it('writes NOTHING on a filtered find_cards call, even though real card data was in the payload', () => {
    const { cwd, stateDir, env } = scaffoldProject('filtered', { withParser: true })
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: { boardId: 'b1', list: 'Next' },
      tool_response: findCardsResponse([{ id: '20', name: 'Ready', description: 'Depends-on: none', listName: 'Next', position: 1 }]),
      cwd,
    }
    const res = runProducerHook(payload, env)
    expect(res.status).toBe(0)
    expect(readSnapshot(stateDir, cwd)).toBeNull()
  })

  it('writes NOTHING when a placeholder names a missing spill file in the temp/state area, and journals why', () => {
    const { cwd, stateDir, env, root } = scaffoldProject('spilled-missing', { withParser: true })
    const spillPath = join(root, 'spill', 'missing-board.json')
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: spilledResponse(spillPath),
      cwd,
    }
    const res = runProducerHook(payload, env)
    expect(res.status).toBe(0)
    expect(readSnapshot(stateDir, cwd)).toBeNull()
    expect(readFailureRecords(stateDir)[0]).toMatchObject({ ok: false })
    expect(String(readFailureRecords(stateDir)[0]!.detail)).toMatch(/spill/i)
  })

  it('journals a containment refusal distinctly from an unparseable payload', () => {
    const { cwd, stateDir, env, root } = scaffoldProject('spilled-invalid-path', { withParser: true })
    const spillPath = join(root, 'outside-every-allowed-root', 'planka-board.json')
    mkdirSync(dirname(spillPath), { recursive: true })
    writeFileSync(spillPath, JSON.stringify({ id: 'board-1', lists: [] }), 'utf8')
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: spilledResponse(spillPath),
      cwd,
    }
    const res = runProducerHook(payload, env)
    expect(res.status).toBe(0)
    expect(readSnapshot(stateDir, cwd)).toBeNull()
    expect(readFailureRecords(stateDir)[0]).toMatchObject({ ok: false, reason: 'spill-payload-refused' })
    expect(String(readFailureRecords(stateDir)[0]!.detail)).toMatch(/validation/i)
  })

  it('enforces the spill size cap for a tool-results path under the active config dir', () => {
    const { cwd, stateDir, env, configDir } = scaffoldProject('spilled-too-large', { withParser: true })
    const spillPath = join(configDir, 'projects', 'project-slug', 'session-id', 'tool-results', 'planka-board.json')
    mkdirSync(dirname(spillPath), { recursive: true })
    writeFileSync(spillPath, JSON.stringify({ id: 'board-1', lists: [], padding: 'x'.repeat(100) }), 'utf8')
    const res = runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: spilledResponse(spillPath),
      cwd,
    }, { ...env, TMPDIR: join(configDir, 'projects'), WT_ACTIONABLE_MAX_SPILL_BYTES: '32' })
    expect(res.status).toBe(0)
    expect(readSnapshot(stateDir, cwd)).toBeNull()
    expect(readFailureRecords(stateDir)[0]).toMatchObject({ ok: false })
    expect(String(readFailureRecords(stateDir)[0]!.detail)).toMatch(/too large/i)
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
    mkdirSync(join(mutatedRoot, '.claude-plugin'), { recursive: true })
    writeFileSync(join(mutatedRoot, '.claude-plugin', 'plugin.json'), readFileSync(PLUGIN_MANIFEST, 'utf8'))

    // ⚠ Copy the WHOLE lib directory, never a hand-written list of the modules the hook
    // happens to import today. An enumeration here fails SILENTLY-ish the day someone adds a
    // module: the copied hook imports something absent, crashes, writes no snapshot, and this
    // lock goes red for a reason that has nothing to do with the mutation it exists to prove.
    // Measured 2026-08-28, when `spill-containment.mjs` was added.
    cpSync(join(REPO_ROOT, 'plugin/bin/lib'), mutatedLibDir, { recursive: true })

    const coreSrc = readFileSync(CORE, 'utf8')
    const mutatedCore = coreSrc.replace(
      "if (filtered) return { ok: false, reason: 'find_cards called with a filter — result is a subset, not the whole board' }",
      '// MUTATED: filter guard removed',
    )
    expect(mutatedCore).not.toBe(coreSrc) // the replace must actually have matched
    writeFileSync(join(mutatedLibDir, 'actionability-planka-producer-core.mjs'), mutatedCore, 'utf8')
    const hookSrc = readFileSync(PRODUCER_HOOK, 'utf8')
    writeFileSync(join(mutatedBinDir, 'wt-actionable-snapshot-producer-hook.mjs'), hookSrc, 'utf8')

    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: { boardId: 'b1', list: 'Next' },
      tool_response: findCardsResponse([{ id: '20', name: 'Ready', description: 'Depends-on: none', listName: 'Next', position: 1 }]),
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
      `import { decide } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/actionability-core.mjs')).href)}`,
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
      tool_response: boardResponse([{ name: 'Next', cards: [{ id: '20', name: 'Ready', description: 'Depends-on: none', position: 1 }] }]),
      cwd,
    }
    expect(runProducerHook(payload, env).status).toBe(0)
    const snap = readSnapshot(stateDir, cwd) as { at: number; actionable: number; next: string; workPossible: boolean; reason: string; blockedUntil: null; inFlightUntil: null }
    const decision = runDecide({ snapshot: { status: 'present', ...snap }, now: snap.at + 1000, staleAfterMs: 2 * 60 * 60 * 1000, mandateKind: 'live', consecutiveBlocks: 0, blockMax: 3 })
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
    const decision = runDecide({ snapshot: { status: 'present', ...snap }, now: snap.at + 1000, staleAfterMs: 2 * 60 * 60 * 1000, mandateKind: 'live', consecutiveBlocks: 0, blockMax: 3 })
    expect(decision.block).toBe(false)
  })

  it('a producer first-read failure artifact makes the consumer direct operators to the tracker', () => {
    const { root, cwd, stateDir, env } = scaffoldProject('e2e-first-read-failure', { withParser: true })
    const producerPayload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: {},
      cwd,
    }
    expect(runProducerHook(producerPayload, env).status).toBe(0)
    expect(readSnapshot(stateDir, cwd)).toBeNull()
    expect(readProjectState(stateDir, cwd)).toMatchObject({
      optedIn: true,
      lastOutcome: 'unreachable',
    })

    const sessionId = 'first-read-failure'
    const transcriptPath = join(root, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, '{}\n')
    const consumer = runGateHook({
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      session_id: sessionId,
      cwd,
    }, env)

    expect(consumer.status).toBe(0)
    const additionalContext = JSON.parse(consumer.stdout).hookSpecificOutput.additionalContext as string
    expect(additionalContext).toContain('payload-diverted-or-too-large')
    expect(additionalContext).toContain(`node "${REFRESH_CLI}"`)
    expect(additionalContext).not.toContain('wire the producer')
  })
})

describe('shipped dependency parser and gate (regression locks)', () => {
  function stop(project: ReturnType<typeof scaffoldProject>, tag: string) {
    const transcriptPath = join(project.root, `sess-${tag}.jsonl`)
    writeFileSync(transcriptPath, '{}\n')
    return runGateHook({ hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: `sess-${tag}`, cwd: project.cwd }, project.env).stdout
  }

  function produce(project: ReturnType<typeof scaffoldProject>, lists: Parameters<typeof boardResponse>[0]) {
    return runProducerHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' }, tool_response: boardResponse(lists), cwd: project.cwd }, project.env)
  }

  it('T1: a board pointer with no scripts directory writes a snapshot and gates actionable work', () => {
    const project = scaffoldProject('shipped-t1', { withParser: false })
    expect(produce(project, [{ name: 'Next', cards: [{ id: '100020', name: 'Ready', description: 'Depends-on: none' }] }]).status).toBe(0)
    expect(readSnapshot(project.stateDir, project.cwd)).toMatchObject({ actionable: 1, undeclared: 0 })
    expect(readSnapshot(project.stateDir, project.cwd)?.countedScope).toContain('shipped parser')
    const text = JSON.parse(stop(project, 'shipped-t1')).hookSpecificOutput.additionalContext as string
    expect(text).toContain('1 actionable item(s) remain')
    expect(text).not.toContain('could not read the board')
  })

  it('T2: the shipped parser distinguishes Done dependencies from unfinished ones', () => {
    const project = scaffoldProject('shipped-t2', { withParser: false })
    produce(project, [
      { name: 'Done', cards: [{ id: '100010', name: 'Done', description: '' }] },
      { name: 'Next', cards: [
        { id: '100020', name: 'Ready', description: 'Depends-on: #100010' },
        { id: '100030', name: 'Waiting', description: 'Depends-on: #100099' },
      ] },
    ])
    expect(readSnapshot(project.stateDir, project.cwd)).toMatchObject({ actionable: 1, next: '#100020 Ready' })
  })

  it('T3: a project parser wins over the shipped parser', () => {
    const project = scaffoldProject('shipped-t3', { withParser: true })
    writeFileSync(join(project.cwd, '.claude/scripts/lib/depends-on-parser.mjs'),
      'process.stdout.write(JSON.stringify({ ids: ["999999"], unparseable: [] }))', 'utf8')
    produce(project, [{ name: 'Next', cards: [{ id: '100020', name: 'Ready', description: 'Depends-on: none' }] }])
    expect(readSnapshot(project.stateDir, project.cwd)).toMatchObject({ actionable: 0, undeclared: 0 })
    expect(readSnapshot(project.stateDir, project.cwd)?.countedScope).toContain('project parser')
  })

  it('T5: a real failed read records its precise reason for the Stop remedy', () => {
    const project = scaffoldProject('shipped-t5', { withParser: true })
    runProducerHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' }, tool_response: { content: [{ type: 'text', text: 'not JSON' }] }, cwd: project.cwd }, project.env)
    expect(readProjectState(project.stateDir, project.cwd)?.lastReason).toBe('payload-unparseable')
    const text = JSON.parse(stop(project, 'shipped-t5')).hookSpecificOutput.additionalContext as string
    expect(text).toContain('payload-unparseable')
    expect(text.split(`node "${REFRESH_CLI}"`)).toHaveLength(2)
    expect(text).not.toContain('could not read the board')
  })

  it('T9: undeclared cards do not become actionable and are named in the hold', () => {
    const project = scaffoldProject('shipped-t9', { withParser: false })
    produce(project, [{ name: 'Next', cards: [
      { id: '100020', name: 'Blind spot', description: 'No dependency line here' },
      { id: '100030', name: 'Ready', description: 'Depends-on: none' },
    ] }])
    expect(readSnapshot(project.stateDir, project.cwd)).toMatchObject({ actionable: 1, undeclared: 1 })
    expect(String(readSnapshot(project.stateDir, project.cwd)?.countedScope)).toContain('1 with no Depends-on line')
    const text = JSON.parse(stop(project, 'shipped-t9')).hookSpecificOutput.additionalContext as string
    expect(text).toContain('1 actionable item(s) remain')
    expect(text).toContain('1 card(s) with no Depends-on line: not counted.')
  })

  it('T10: only undeclared cards yield zero actionable and Stop passes', () => {
    const project = scaffoldProject('shipped-t10', { withParser: false })
    produce(project, [{ name: 'Next', cards: [{ id: '100020', name: 'Blind spot', description: 'No dependency line here' }] }])
    expect(readSnapshot(project.stateDir, project.cwd)).toMatchObject({ actionable: 0, undeclared: 1 })
    expect(stop(project, 'shipped-t10')).toBe('')
  })

  it('F5: on the project-parser path, a card with no Depends-on line is not actionable and counts as undeclared', () => {
    const project = scaffoldProject('project-parser-undeclared', { withParser: true })
    produce(project, [{ name: 'Next', cards: [{ id: '100020', name: 'Blind spot', description: 'No dependency line here' }] }])
    expect(readSnapshot(project.stateDir, project.cwd)).toMatchObject({ actionable: 0, undeclared: 1 })
    expect(readSnapshot(project.stateDir, project.cwd)?.countedScope).toContain('project parser')
  })

  it('F4: a card whose description is null is still counted, as undeclared', () => {
    const project = scaffoldProject('null-description', { withParser: false })
    runProducerHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__planka__get_board', tool_input: { boardId: 'b1' },
      tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: 'board-1', lists: [{ name: 'Next', cards: [
        { id: '100020', name: 'Null description', description: null },
        { id: '100030', name: 'Ready', description: 'Depends-on: none' },
      ] }] }) }] }, cwd: project.cwd }, project.env)
    expect(readSnapshot(project.stateDir, project.cwd)).toMatchObject({ actionable: 1, undeclared: 1 })
  })

  it('F4: a summary board read writes no snapshot and records why', () => {
    const project = scaffoldProject('summary-read', { withParser: false })
    runProducerHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__planka__get_board', tool_input: { boardId: 'b1', cardsSummary: true },
      tool_response: boardResponse([{ name: 'Next', cards: [{ id: '100020', name: 'Ready', description: 'Depends-on: none' }] }]), cwd: project.cwd }, project.env)
    expect(readSnapshot(project.stateDir, project.cwd)).toBeNull()
    expect(readFailureRecords(project.stateDir).at(-1)?.detail).toContain('descriptions are missing')
  })

  // Root ignores file modes, so a read-only file does not make the write fail there.
  it.skipIf(process.getuid?.() === 0)('C3: a snapshot file that cannot be written records snapshot-write-failed, and the hold names that file (skipped as root: root ignores the read-only mode)', () => {
    const project = scaffoldProject('c3-snapshot-dir', { withParser: false })
    const snapshotFile = join(project.stateDir, `${slug(project.cwd)}.json`)
    // An older, read-only snapshot: the producer's write fails for real (EACCES), and the gate can still
    // read the old file, so the hold is rendered from the recorded failure.
    mkdirSync(project.stateDir, { recursive: true })
    writeFileSync(snapshotFile, JSON.stringify({ at: Date.now() - 3 * 60 * 60_000, actionable: 0, next: '', workPossible: true,
      reason: '', blockedUntil: null, inFlightUntil: null }), 'utf8')
    chmodSync(snapshotFile, 0o444)
    produce(project, [{ name: 'Next', cards: [{ id: '100020', name: 'Ready', description: 'Depends-on: none' }] }])
    expect(readProjectState(project.stateDir, project.cwd)).toMatchObject({ lastOutcome: 'unavailable', lastReason: 'snapshot-write-failed' })
    expect(readFailureRecords(project.stateDir).map((r) => r.reason)).toContain('snapshot-write-failed')
    const text = JSON.parse(stop(project, 'c3-snapshot-dir')).hookSpecificOutput.additionalContext as string
    expect(text).toContain(snapshotFile)
  })

  it('C3: a producer-state write failure after a good snapshot write is not reported as a snapshot write failure', () => {
    const project = scaffoldProject('c3-state-dir', { withParser: false })
    mkdirSync(join(project.stateDir, `${slug(project.cwd)}.project-state.json`), { recursive: true })
    produce(project, [{ name: 'Next', cards: [{ id: '100020', name: 'Ready', description: 'Depends-on: none' }] }])
    expect(readSnapshot(project.stateDir, project.cwd)).toMatchObject({ actionable: 1 })
    const reasons = readFailureRecords(project.stateDir).map((r) => r.reason)
    expect(reasons).toContain('producer-state-write-failed')
    expect(reasons).not.toContain('snapshot-write-failed')
  })

  it('C8: refresh throws when the producer reports a fresh write but the snapshot is older than the refresh start', () => {
    const project = scaffoldProject('c8-old-snapshot', { withParser: false })
    const script = [
      `globalThis.fetch = async (_url, options) => {`,
      `  const body = JSON.parse(options.body)`,
      `  const result = body.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ total: 1, offset: 0, cards: [{ id: '100020', name: 'Ready', listName: 'Next', description: 'Depends-on: none' }] }) }] } : {}`,
      `  return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) }`,
      `}`,
      `const { mkdirSync, writeFileSync } = await import('node:fs')`,
      `const { refreshSnapshot } = await import(${JSON.stringify(pathToFileURL(REFRESH_CLI).href)})`,
      `const stateDir = ${JSON.stringify(project.stateDir)}`,
      `const slug = ${JSON.stringify(slug(project.cwd))}`,
      // A producer that claims a fresh write but leaves a snapshot written before the refresh began.
      `const produce = () => {`,
      `  mkdirSync(stateDir, { recursive: true })`,
      `  writeFileSync(stateDir + '/' + slug + '.json', JSON.stringify({ at: Date.now() - 60_000, actionable: 7 }))`,
      `  writeFileSync(stateDir + '/' + slug + '.project-state.json', JSON.stringify({ optedIn: true, heartbeatAt: Date.now() + 1, lastOutcome: 'snapshot-written' }))`,
      `}`,
      `try { await refreshSnapshot({ cwd: ${JSON.stringify(project.cwd)}, produce }); process.stdout.write('SUCCESS') }`,
      `catch (error) { process.stdout.write(error.message); process.exitCode = 1 }`,
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: project.env, encoding: 'utf8' })
    expect(result.stdout).not.toBe('SUCCESS')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('snapshot missing or stale')
  })

  it('C9: a refresh that cannot reach the board records it, and the hold says to check the endpoint, never stale', () => {
    const project = scaffoldProject('c9-unreachable', { withParser: false })
    const script = [
      `globalThis.fetch = async () => { throw new Error('fetch failed') }`,
      `const { refreshSnapshot } = await import(${JSON.stringify(pathToFileURL(REFRESH_CLI).href)})`,
      `try { await refreshSnapshot({ cwd: ${JSON.stringify(project.cwd)} }); process.stdout.write('SUCCESS') }`,
      `catch (error) { process.stdout.write(error.message); process.exitCode = 1 }`,
    ].join('\n')
    const before = Date.now()
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: project.env, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('fetch failed')
    const state = readProjectState(project.stateDir, project.cwd)
    expect(state).toMatchObject({ lastOutcome: 'unreachable', lastReason: 'board-unreachable' })
    expect(Number(state?.heartbeatAt)).toBeGreaterThanOrEqual(before)
    const text = JSON.parse(stop(project, 'c9-unreachable')).hookSpecificOutput.additionalContext as string
    expect(text).toContain('board-unreachable')
    expect(text).toContain('Check that the board endpoint answers')
    expect(text).not.toContain('stale')
    expect(text.split('\n')).toHaveLength(1)
  })

  // Runs the refresh CLI against a fake endpoint whose behaviour is given as source text.
  function refreshAgainst(project: ReturnType<typeof scaffoldProject>, fetchSource: string) {
    const script = [
      `globalThis.fetch = ${fetchSource}`,
      `const { refreshSnapshot } = await import(${JSON.stringify(pathToFileURL(REFRESH_CLI).href)})`,
      `try { await refreshSnapshot({ cwd: ${JSON.stringify(project.cwd)} }); process.stdout.write('SUCCESS') }`,
      `catch (error) { process.stdout.write(error.message); process.exitCode = 1 }`,
    ].join('\n')
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: project.env, encoding: 'utf8' })
  }
  const toolAnswer = (text: string) => [
    `async (_url, options) => {`,
    `  const body = JSON.parse(options.body)`,
    `  const result = body.method === 'tools/call' ? { content: [{ type: 'text', text: ${JSON.stringify(text)} }] } : {}`,
    `  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) }`,
    `}`,
  ].join('\n')

  it('D3: a non-OK HTTP status is a transport failure, recorded as board-unreachable', () => {
    const project = scaffoldProject('d3-http-503', { withParser: false })
    const result = refreshAgainst(project, `async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' })`)
    expect(result.status).toBe(1)
    expect(readProjectState(project.stateDir, project.cwd)).toMatchObject({ lastOutcome: 'unreachable', lastReason: 'board-unreachable' })
    const text = JSON.parse(stop(project, 'd3-http-503')).hookSpecificOutput.additionalContext as string
    expect(text).toContain('Check that the board endpoint answers')
    expect(text.split('\n')).toHaveLength(1)
  })

  it('D3: an answer that is not JSON is board-read-failed, and the hold names the detail, never "check the endpoint answers"', () => {
    const project = scaffoldProject('d3-not-json', { withParser: false })
    const result = refreshAgainst(project, toolAnswer('<html>proxy error page</html>'))
    expect(result.status).toBe(1)
    expect(readProjectState(project.stateDir, project.cwd)).toMatchObject({ lastOutcome: 'unavailable', lastReason: 'board-read-failed', lastDetail: 'malformed MCP result JSON' })
    const text = JSON.parse(stop(project, 'd3-not-json')).hookSpecificOutput.additionalContext as string
    expect(text).toContain('board-read-failed')
    expect(text).toContain('The board endpoint answered with an unreadable result (malformed MCP result JSON)')
    expect(text).not.toContain('Check that the board endpoint answers')
    expect(text).not.toContain('board-unreachable')
    expect(text.split('\n')).toHaveLength(1)
  })

  it('D3: a JSON-RPC error is board-read-failed, and the hold carries the error message', () => {
    const project = scaffoldProject('d3-rpc-error', { withParser: false })
    const result = refreshAgainst(project, [
      `async (_url, options) => {`,
      `  const body = JSON.parse(options.body)`,
      `  const answer = body.method === 'tools/call' ? { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Invalid params: boardId' } } : { jsonrpc: '2.0', id: body.id, result: {} }`,
      `  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(answer) }`,
      `}`,
    ].join('\n'))
    expect(result.status).toBe(1)
    expect(readProjectState(project.stateDir, project.cwd)).toMatchObject({ lastReason: 'board-read-failed' })
    const text = JSON.parse(stop(project, 'd3-rpc-error')).hookSpecificOutput.additionalContext as string
    expect(text).toContain('Invalid params: boardId')
    expect(text).not.toContain('Check that the board endpoint answers')
  })

  it('T8: refresh refuses an old future-dated snapshot when the parser fails', () => {
    const project = scaffoldProject('shipped-t8', { withParser: true })
    writeFileSync(join(project.cwd, '.claude/scripts/lib/depends-on-parser.mjs'), 'process.exit(1)', 'utf8')
    mkdirSync(project.stateDir, { recursive: true })
    writeFileSync(join(project.stateDir, `${slug(project.cwd)}.json`), JSON.stringify({ at: Date.now() + 60_000, actionable: 7 }), 'utf8')
    const script = [
      `globalThis.fetch = async (_url, options) => {`,
      `  const body = JSON.parse(options.body)`,
      `  const result = body.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ total: 1, offset: 0, cards: [{ id: '100020', name: 'Ready', listName: 'Next', description: 'Depends-on: none' }] }) }] } : {}`,
      `  return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) }`,
      `}`,
      `const { refreshSnapshot } = await import(${JSON.stringify(pathToFileURL(REFRESH_CLI).href)})`,
      `try { await refreshSnapshot({ cwd: ${JSON.stringify(project.cwd)} }); process.stdout.write('SUCCESS') }`,
      `catch (error) { process.stdout.write(error.message); process.exitCode = 1 }`,
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: project.env, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('snapshot-computation-failed')
  })
})

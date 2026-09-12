import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { BoardUnavailable, createBoardClient } from '../../../../plugin/bin/lib/board-http-client.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createWaveServer } from '../../../../plugin/bin/lib/wave-lifecycle-server.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { parseOrchestratorArgs, runOrchestrator } from '../../../../plugin/bin/lib/orchestrator-runner-core.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(ROOT, 'plugin/bin/wt-run-orchestrator.mjs')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
type RegisteredServer = { instance: { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> }, setCardState: (id: string, state: string) => void, state: () => unknown }
const text = (server: RegisteredServer, name: string, input: Record<string, unknown>) => server.instance._registeredTools[name]!.handler(input).then((result) => result.content[0]!.text)

function waveFixture(bullets = 1) {
  const root = mkdtempSync(join(tmpdir(), 'wt-wave-')); roots.push(root)
  const cardDir = join(root, 'cards', '1'); mkdirSync(cardDir, { recursive: true })
  writeFileSync(join(cardDir, 'card.md'), `## Definition of done\n${Array.from({ length: bullets }, (_, index) => `- item ${index + 1}`).join('\n')}\n`)
  writeFileSync(join(cardDir, 'pilot-report.md'), '# report\n'); writeFileSync(join(cardDir, 'diff.patch'), 'diff\n')
  const server = createWaveServer({ waveDir: root, cards: [{ id: '1' }] }) as RegisteredServer
  server.setCardState('1', 'piloting'); server.setCardState('1', 'judging')
  return { root, cardDir, server }
}

function receipts(cardDir: string, overrides: Record<string, number> = {}) {
  for (const name of ['pilot', 'typecheck', 'lint', 'test', 'clean-tree', 'report-findings-check', 'fidelity-verify']) writeFileSync(join(cardDir, `${name}.log`), `EXIT=${overrides[name] ?? 0}\n`)
}

function repoFixture(cards = [{ id: '1', listName: 'Next', description: 'Route: LITE\n## Definition of done\n- ship\n' }]) {
  const root = mkdtempSync(join(tmpdir(), 'wt-orchestrator-')); roots.push(root)
  spawnSync('git', ['init', '-q', '-b', 'develop'], { cwd: root }); spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root }); spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  writeFileSync(join(root, '.gitignore'), '.waves/\n.lane/\n'); writeFileSync(join(root, 'base.txt'), 'base\n'); spawnSync('git', ['add', '.'], { cwd: root }); spawnSync('git', ['commit', '-qm', 'base'], { cwd: root })
  const worktreesDir = join(root, '.waves'); const report = join(worktreesDir, 'report.md'); const moves: string[] = []; const comments: string[] = []; const gitCalls: string[][] = []; const launches: Array<{ card: string, hard?: boolean }> = []
  const byId = new Map(cards.map((card) => [String(card.id), card]))
  const board = {
    getCard: async (id: string) => byId.get(String(id)),
    findCards: async ({ limit, offset }: { limit: number, offset: number }) => ({ cards: cards.slice(offset, offset + limit), total: cards.length }),
    moveCard: async (id: string, list: string) => { moves.push(`${id}:${list}`) },
    addComment: async (id: string, value: string) => { comments.push(`${id}:${value}`) },
  }
  const git = (program: string, args: string[], options: Record<string, unknown>) => { gitCalls.push(args); return execFileSync(program, args, options) }
  const runPilot = async (options: { card: string, dir: string, boardMoves: boolean }, dependencies: { log: (line: string) => void }) => {
    expect(options.boardMoves).toBe(false); launches.push(options); dependencies.log('route=LITE reasons=test model=sonnet effective=sonnet')
    mkdirSync(join(options.dir, '.lane'), { recursive: true }); writeFileSync(join(options.dir, '.lane', 'summary.json'), '{}\n'); writeFileSync(join(options.dir, '.lane', 'usage.json'), '{}\n'); writeFileSync(join(options.dir, '.lane', 'sdk-transcript.json'), '[]\n')
    writeFileSync(join(options.dir, '.lane', 'pilot-report.md'), '## Implemented\nx\n## Verification\nx\n## Independent Review\nx\n## Decisions\nx\n## Remaining Risks\nx\n## Findings\nNone.\n')
    writeFileSync(join(options.dir, `card-${options.card}.txt`), 'work\n'); spawnSync('git', ['add', '.'], { cwd: options.dir }); spawnSync('git', ['commit', '-qm', `card ${options.card}`], { cwd: options.dir })
    return { exitCode: 0, summary: {} }
  }
  const gates = async (_worktree: string, cardDir: string) => { for (const name of ['typecheck', 'lint', 'test']) writeFileSync(join(cardDir, `${name}.log`), 'EXIT=0\n'); return { typecheck: 0, lint: 0, test: 0 } }
  const reportCheck = async (_file: string, cardDir: string) => { writeFileSync(join(cardDir, 'report-findings-check.log'), 'EXIT=0\n'); return 0 }
  const fidelity = async ({ cardDir }: { cardDir: string }) => { writeFileSync(join(cardDir, 'fidelity-verify.log'), 'EXIT=0\n'); return 0 }
  const judge = async ({ row }: { row: { decision: string, reason?: string } }) => { row.decision = 'accepted'; row.reason = 'meets card' }
  const options = { cards: cards.map((card) => String(card.id)), worktreesDir, report, base: 'develop', waveId: 'testwave', maxCards: Infinity, maxMinutes: Infinity, pilotTimeout: 60, concurrency: 1, hard: [], cwd: root }
  return { root, worktreesDir, report, board, moves, comments, gitCalls, launches, git, runPilot, gates, reportCheck, fidelity, judge, options }
}

describe('orchestrator board HTTP client', () => {
  it('speaks initialize plus tools/call and supports pagination across two pages', async () => {
    const offsets: number[] = []
    const server = createServer((request, response) => { let body = ''; request.on('data', (part) => { body += part }); request.on('end', () => { const call = JSON.parse(body); const offset = call.params?.arguments?.offset; if (offset !== undefined) offsets.push(offset); const value = call.method === 'initialize' ? {} : { content: [{ type: 'text', text: JSON.stringify({ cards: [{ id: offset }], total: 2 }) }] }; response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: value })) }) })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    try { const client = createBoardClient({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }); await client.findCards({ listName: 'Next', limit: 1, offset: 0 }); await client.findCards({ listName: 'Next', limit: 1, offset: 1 }); expect(offsets).toEqual([0, 1]) } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it.each([
    ['HTTP 500', async () => ({ ok: false, status: 500, text: async () => '' })],
    ['malformed JSON', async () => ({ ok: true, text: async () => '{bad' })],
    ['malformed MCP result JSON', async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{bad' }] } }) })],
    ['malformed MCP content', async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }) })],
  ])('turns %s into BoardUnavailable', async (_name, fetch) => {
    const promise = createBoardClient({ url: 'http://board', fetch }).getCard('1')
    await expect(promise).rejects.toBeInstanceOf(BoardUnavailable)
    if (_name === 'HTTP 500') await expect(promise).rejects.toThrow('HTTP 500')
    if (_name === 'malformed MCP result JSON') await expect(promise).rejects.toThrow('malformed MCP result JSON')
  })
})

describe('wave lifecycle server', () => {
  it.each(['pilot', 'typecheck', 'lint', 'test', 'clean-tree', 'report-findings-check', 'fidelity-verify'])('refuses accept when the %s EXIT=0 receipt is missing and names its path', async (missing) => {
    const { cardDir, server } = waveFixture(); receipts(cardDir, { [missing]: 1 })
    const result = await text(server, 'decide', { cardId: '1', decision: 'accept', reason: 'x', assessment: 'Covered.', tool_use_id: missing })
    expect(result).toContain(`missing ${missing} EXIT=0 receipt: ${join(cardDir, `${missing}.log`)}`)
  })

  it('refuses an empty diff and under-covered assessment, then accepts complete evidence', async () => {
    const { cardDir, server } = waveFixture(2); receipts(cardDir); writeFileSync(join(cardDir, 'diff.patch'), '')
    expect(await text(server, 'decide', { cardId: '1', decision: 'accept', reason: 'x', assessment: 'One.', tool_use_id: 'empty' })).toContain(`missing non-empty diff: ${join(cardDir, 'diff.patch')}`)
    writeFileSync(join(cardDir, 'diff.patch'), 'x')
    expect(await text(server, 'decide', { cardId: '1', decision: 'accept', reason: 'x', assessment: 'One.', tool_use_id: 'short' })).toContain('assessment covers 1 of 2 bullets')
    expect(await text(server, 'decide', { cardId: '1', decision: 'accept', reason: 'because', assessment: 'One. Two.', tool_use_id: 'ok' })).toBe('decided accept card=1'); expect(JSON.parse(readFileSync(join(cardDir, 'decision.json'), 'utf8')).assessment).toBe('One. Two.')
  })

  it.each([1, 2])('requires escalation rather than rejection for pilot EXIT=%s', async (exit) => {
    const { cardDir, server } = waveFixture(); receipts(cardDir, { pilot: exit })
    expect(await text(server, 'decide', { cardId: '1', decision: 'reject', reason: 'x', assessment: 'One.', tool_use_id: `exit-${exit}` })).toContain(`pilot EXIT=${exit} requires escalate: ${join(cardDir, 'pilot.log')}`)
  })

  it('enforces every state edge and exposes state()', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wave-state-')); roots.push(root); const server = createWaveServer({ waveDir: root, cards: [{ id: '1' }] }) as RegisteredServer
    expect(() => server.setCardState('1', 'judging')).toThrow('pending->judging'); server.setCardState('1', 'piloting'); server.setCardState('1', 'judging'); server.setCardState('1', 'undecided')
    expect(server.state()).toEqual({ cards: { 1: 'undecided' }, judgmentWritten: false, allDecided: true }); expect(() => server.setCardState('1', 'accepted')).toThrow('undecided->accepted')
  })

  it('bounds diff reads, refuses missing evidence by path, and requires judgment headings', async () => {
    const { root, cardDir, server } = waveFixture(); writeFileSync(join(cardDir, 'diff.patch'), 'abcdef')
    expect(await text(server, 'read_diff', { cardId: '1', maxBytes: 3 })).toBe('abc'); expect(await text(server, 'read_diff', { cardId: '1', maxBytes: 204801 })).toContain('maxBytes exceeds 204800')
    rmSync(join(cardDir, 'pilot-report.md')); expect(await text(server, 'read_card_report', { cardId: '1' })).toContain(`missing reportPath: ${join(cardDir, 'pilot-report.md')}`)
    expect(await text(server, 'write_judgment', { content: 'thin' })).toContain('requires ## Independent Review and ## Decisions')
    const judgment = { content: '## Independent Review\nok\n## Decisions\nok', tool_use_id: 'write' }; expect(await text(server, 'write_judgment', judgment)).toBe('judgment written'); expect(await text(server, 'write_judgment', judgment)).toBe('judgment written'); expect(await text(server, 'write_judgment', { ...judgment, content: `${judgment.content}\nchanged` })).toContain('unique tool_use_id'); expect(readFileSync(join(root, 'judgment.md'), 'utf8')).toContain('## Decisions')
  })

  it('is idempotent for identical tool_use_id shapes and refuses changed shapes', async () => {
    const { cardDir, server } = waveFixture(); receipts(cardDir)
    const input = { cardId: '1', decision: 'reject', reason: 'x', assessment: 'One.', tool_use_id: 'same' }
    expect(await text(server, 'decide', input)).toBe('decided reject card=1'); expect(await text(server, 'decide', input)).toBe('decided reject card=1'); expect(await text(server, 'decide', { ...input, reason: 'changed' })).toContain('unique tool_use_id')
  })

  it('refuses card evidence paths outside the wave directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wt-wave-outside-')); roots.push(outside); writeFileSync(join(outside, 'card.md'), 'secret'); const root = mkdtempSync(join(tmpdir(), 'wt-wave-inside-')); roots.push(root); const server = createWaveServer({ waveDir: root, cards: [{ id: '1', cardPath: join(outside, 'card.md') }] }) as RegisteredServer
    expect(await text(server, 'read_card', { cardId: '1' })).toContain(`cardPath outside wave directory: ${join(outside, 'card.md')}`)
  })
})

describe('orchestrator driver', () => {
  it('parses the complete CLI surface and rejects invalid launch shapes', () => {
    expect(parseOrchestratorArgs(['--cards', '1,2', '--worktrees-dir', '/tmp/w', '--report', '/tmp/r', '--hard', '2', '--base', 'dev', '--pilot-timeout', '8', '--board-url', 'http://b'])).toMatchObject({ cards: ['1', '2'], hard: ['2'], base: 'dev', pilotTimeout: 8, boardUrl: 'http://b' })
    expect(parseOrchestratorArgs(['--cards', '1', '--mission-list', 'Next', '--worktrees-dir', '/tmp/w', '--report', '/tmp/r']).error).toContain('exactly one')
  })

  it('runs the complete happy path, writes receipts, moves only to In Progress, and never invokes forbidden git operations', async () => {
    const f = repoFixture(); const result = await runOrchestrator(f.options, f)
    expect(result.exitCode).toBe(0); expect(f.moves).toEqual(['1:In Progress']); expect(f.comments).toHaveLength(1); expect(readFileSync(f.report, 'utf8')).toContain('main should merge card/1-wave-testwave')
    expect(readFileSync(join(result.waveDir, 'cards/1/card.md'), 'utf8')).toBe('Route: LITE\n## Definition of done\n- ship\n')
    expect(readFileSync(join(result.waveDir, 'cards/1/runner.log'), 'utf8').split('\n')[0]).toMatch(/^route=LITE /)
    expect(f.gitCalls.flat().some((arg) => ['merge', 'push', 'branch -D'].includes(arg))).toBe(false)
  })

  it('skips duplicate and Done explicit cards without moving them', async () => {
    const f = repoFixture([{ id: '1', listName: 'Done', description: 'done' }]); const result = await runOrchestrator({ ...f.options, cards: ['1', '1'] }, f)
    expect(result).toMatchObject({ exitCode: 1, stopReason: 'no eligible card' }); expect(f.moves).toEqual([])
  })

  it('refuses an explicit card absent from the board', async () => {
    const f = repoFixture(); const result = await runOrchestrator({ ...f.options, cards: ['404'] }, f); expect(result).toMatchObject({ exitCode: 1, stopReason: 'card absent from board: 404' }); expect(f.moves).toEqual([])
  })

  it('names max-cards and no-eligible-card stop conditions', async () => {
    const cards = [{ id: '1', listName: 'Next', description: 'a' }, { id: '2', listName: 'Next', description: 'b' }]; const f = repoFixture(cards)
    const result = await runOrchestrator({ ...f.options, maxCards: 1 }, f); expect(result.stopReason).toBe('max-cards reached'); expect(result.rows).toHaveLength(1)
  })

  it('refuses a first launch outside the deterministic time reservation', async () => {
    const f = repoFixture(); const result = await runOrchestrator({ ...f.options, startedAt: 0, maxMinutes: 1, pilotTimeout: 60 }, { ...f, now: () => 1 })
    expect(result.stopReason).toBe('time budget exhausted'); expect(result.rows).toHaveLength(0)
  })

  it('passes per-card hard routing to the pilot', async () => {
    const f = repoFixture(); await runOrchestrator({ ...f.options, hard: ['1'] }, f); expect(f.launches).toMatchObject([{ card: '1', hard: true }])
  })

  it('applies the time reservation before a concurrent launch', async () => {
    const cards = [{ id: '1', listName: 'Next', description: 'a' }, { id: '2', listName: 'Next', description: 'b' }]; const f = repoFixture(cards); const times = [0, 61_000]
    const result = await runOrchestrator({ ...f.options, startedAt: 0, maxMinutes: 2, pilotTimeout: 60, concurrency: 2 }, { ...f, now: () => times.shift() ?? 61_000 })
    expect(result.stopReason).toBe('time budget exhausted'); expect(result.rows).toHaveLength(1)
  })

  it('fails closed on board unavailability and malformed mission responses while still writing the report', async () => {
    const f = repoFixture(); const unavailable = await runOrchestrator(f.options, { ...f, board: { ...f.board, getCard: async () => { throw new BoardUnavailable('offline') } } }); expect(unavailable).toMatchObject({ exitCode: 1, stopReason: 'board unavailable' }); expect(readFileSync(f.report, 'utf8')).toContain('stop=board unavailable')
    const malformed = await runOrchestrator({ ...f.options, cards: null, missionList: 'Next', waveId: 'malformed' }, { ...f, board: { ...f.board, findCards: async () => ({ wrong: [] }) } }); expect(malformed).toMatchObject({ exitCode: 1, stopReason: 'board unavailable' })
  })

  it('paginates mission discovery until total across two pages', async () => {
    const cards = [{ id: '1', listName: 'Next', labels: ['P1', 'bug', 'effort:S'], description: 'Depends-on: none' }, { id: '2', listName: 'Next', labels: ['P1', 'bug', 'effort:S'], description: 'Depends-on: none' }]; const f = repoFixture(cards); const offsets: number[] = []
    const board = { ...f.board, findCards: async ({ offset }: { offset: number }) => { offsets.push(offset); return { cards: cards.slice(offset, offset + 1), total: 2 } } }; const result = await runOrchestrator({ ...f.options, cards: null, missionList: 'Next', concurrency: 1 }, { ...f, board }); expect(result.rows).toHaveLength(2); expect(offsets.slice(0, 2)).toEqual([0, 1])
  })

  it.each(['main base', 'outside worktrees', 'budget below timeout'])('refuses the %s preflight', async (guard) => {
    const f = repoFixture(); const options = guard === 'main base' ? { ...f.options, base: 'main' } : guard === 'outside worktrees' ? { ...f.options, worktreesDir: join(tmpdir(), 'outside-waves') } : { ...f.options, maxMinutes: 0.5, pilotTimeout: 60 }
    const result = await runOrchestrator(options, f); expect(result.exitCode).toBe(1); expect(result.rows).toHaveLength(0); expect(result.stopReason).toBe(guard === 'main base' ? 'base main is refused' : guard === 'outside worktrees' ? 'worktrees dir is outside repository root' : 'time budget below one pilot timeout')
  })

  it.each(['branch', 'worktree'])('refuses a pre-existing target %s before moving the card', async (kind) => {
    const f = repoFixture(); if (kind === 'branch') spawnSync('git', ['branch', 'card/1-wave-testwave'], { cwd: f.root }); else mkdirSync(join(f.worktreesDir, 'wave-testwave', '1'), { recursive: true })
    const result = await runOrchestrator(f.options, f); expect(result.exitCode).toBe(1); expect(result.stopReason).toContain(`${kind} already exists`); expect(f.moves).toEqual([])
  })

  it.each(['dirty tree after gates', 'failing findings report'])('refuses acceptance for %s', async (guard) => {
    const f = repoFixture(); const dependencies = { ...f }
    if (guard.startsWith('dirty')) dependencies.gates = async (worktree: string, cardDir: string) => { const result = await f.gates(worktree, cardDir); writeFileSync(join(worktree, 'base.txt'), 'dirty\n'); return result }
    else dependencies.reportCheck = async (_file: string, cardDir: string) => { writeFileSync(join(cardDir, 'report-findings-check.log'), 'EXIT=1\n'); return 1 }
    const result = await runOrchestrator(f.options, dependencies); expect(result.rows[0]).toMatchObject({ decision: 'escalated', reason: 'accept refused: required receipt failed' })
    if (guard.startsWith('dirty')) expect(readFileSync(join(result.waveDir, 'cards/1/clean-tree.log'), 'utf8')).toContain('EXIT=1')
  })

  it('uses archived gate EXIT lines and mechanically escalates every nonzero pilot outcome', async () => {
    const f = repoFixture(); const runPilot = async (...args: Parameters<typeof f.runPilot>) => ({ ...(await f.runPilot(...args)), exitCode: 2 }); const gates = async (worktree: string, cardDir: string) => { await f.gates(worktree, cardDir); writeFileSync(join(cardDir, 'test.log'), 'EXIT=1\n'); return { typecheck: 0, lint: 0, test: 0 } }; const judge = async ({ row }: { row: { decision: string } }) => { row.decision = 'rejected' }
    const result = await runOrchestrator(f.options, { ...f, runPilot, gates, judge }); expect(result.rows[0]).toMatchObject({ pilot: 2, gates: '0/0/1', decision: 'escalated', reason: 'pilot EXIT=2 requires escalate' })
  })

  it('overlaps two pilots at concurrency 2 but judges and reports in card order', async () => {
    const cards = [{ id: '1', listName: 'Next', description: 'a' }, { id: '2', listName: 'Next', description: 'b' }]; const f = repoFixture(cards); let active = 0; let peak = 0; let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve }); setTimeout(() => release(), 200); const judged: string[] = []
    const runPilot = async (...args: Parameters<typeof f.runPilot>) => { active += 1; peak = Math.max(peak, active); if (active === 2) release(); await barrier; const result = await f.runPilot(...args); writeFileSync(join(args[0].dir, 'shared.txt'), args[0].card); spawnSync('git', ['add', '.'], { cwd: args[0].dir }); spawnSync('git', ['commit', '-qm', 'shared'], { cwd: args[0].dir }); active -= 1; return result }
    const judge = async ({ row }: { row: { id: string, decision: string } }) => { judged.push(row.id); row.decision = 'accepted' }
    const result = await runOrchestrator({ ...f.options, concurrency: 2 }, { ...f, runPilot, judge }); expect(peak).toBe(2); expect(judged).toEqual(['1', '2']); expect(result.rows.map((row: { id: string }) => row.id)).toEqual(['1', '2']); expect(readFileSync(f.report, 'utf8')).toContain('seam overlap 1/2: shared.txt')
  })

  it('applies all three mission label axes and Done dependencies fail-closed', async () => {
    const cards = [{ id: '1', listName: 'Next', labels: ['P1', 'bug', 'effort:S', 'mission'], description: 'Depends-on: #9' }, { id: '2', listName: 'Next', labels: ['P1', 'bug', 'mission'], description: 'Depends-on: none' }]; const f = repoFixture(cards)
    const board = { ...f.board, getCard: async (id: string) => id === '9' ? { id: '9', listName: 'Done' } : f.board.getCard(id) }; const result = await runOrchestrator({ ...f.options, cards: null, missionList: 'Next', missionLabels: ['mission'] }, { ...f, board }); expect(result.rows.map((row: { id: string }) => row.id)).toEqual(['1'])
  })

  it('re-scans a mission after each card and removes cards that cease to be eligible', async () => {
    const cards = [{ id: '1', listName: 'Next', labels: ['P1', 'bug', 'effort:S', 'mission'], description: 'Depends-on: #9' }, { id: '2', listName: 'Next', labels: ['P1', 'bug', 'effort:S', 'mission'], description: 'Depends-on: none' }]; const f = repoFixture(cards); let scans = 0
    const board = { ...f.board, getCard: async (id: string) => id === '9' ? { id: '9', listName: 'Done' } : f.board.getCard(id), findCards: async (args: { limit: number, offset: number }) => { scans += 1; const visible = scans === 1 ? cards : cards.slice(0, 1); return { cards: visible.slice(args.offset, args.offset + args.limit), total: visible.length } } }
    const result = await runOrchestrator({ ...f.options, cards: null, missionList: 'Next', missionLabels: ['mission'] }, { ...f, board }); expect(result.rows.map((row: { id: string }) => row.id)).toEqual(['1']); expect(scans).toBeGreaterThanOrEqual(2)
  })

  it('writes an exit-1 report when the driver throws', async () => {
    const f = repoFixture(); const result = await runOrchestrator(f.options, { ...f, runPilot: async () => { throw new Error('controlled driver failure') } }); expect(result.exitCode).toBe(1); expect(readFileSync(f.report, 'utf8')).toContain('controlled driver failure')
  })

  it('prints the routing line before doing driver work', () => {
    const f = repoFixture(); const result = spawnSync(process.execPath, [CLI, '--cards', '1', '--base', 'main', '--worktrees-dir', f.worktreesDir, '--report', f.report], { cwd: f.root, encoding: 'utf8' }); expect(result.stdout.split('\n')[0]).toMatch(/^wave=\S+ report=/)
  })
})

describe('real git worktree fence', () => {
  it('refuses push and no-ff merge only inside the card worktree while allowing commits', async () => {
    const f = repoFixture(); const remote = mkdtempSync(join(tmpdir(), 'wt-remote-')); roots.push(remote); spawnSync('git', ['init', '--bare', '-q'], { cwd: remote }); spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: f.root }); expect(spawnSync('git', ['push', '-u', 'origin', 'develop'], { cwd: f.root }).status).toBe(0)
    spawnSync('git', ['checkout', '-qb', 'side'], { cwd: f.root }); writeFileSync(join(f.root, 'side.txt'), 'side\n'); spawnSync('git', ['add', '.'], { cwd: f.root }); spawnSync('git', ['commit', '-qm', 'side'], { cwd: f.root }); spawnSync('git', ['checkout', '-q', 'develop'], { cwd: f.root }); const result = await runOrchestrator(f.options, f); const worktree = result.rows[0].worktree
    writeFileSync(join(worktree, 'plain.txt'), 'plain\n'); spawnSync('git', ['add', '.'], { cwd: worktree }); expect(spawnSync('git', ['commit', '-qm', 'plain'], { cwd: worktree }).status).toBe(0)
    const push = spawnSync('git', ['push', 'origin', 'HEAD'], { cwd: worktree, encoding: 'utf8' }); expect(push.status).toBe(1); expect(push.stderr).toContain("refused by wave testwave: push is main's")
    const merge = spawnSync('git', ['merge', '--no-ff', 'side'], { cwd: worktree, encoding: 'utf8' }); expect(merge.status).toBe(1); expect(`${merge.stdout}${merge.stderr}`).toContain("refused by wave testwave: merge is main's")
    expect(spawnSync('git', ['commit', '--allow-empty', '-qm', 'main unaffected'], { cwd: f.root }).status).toBe(0); expect(spawnSync('git', ['push', 'origin', 'develop'], { cwd: f.root }).status).toBe(0)
  })
})

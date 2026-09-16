import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { BoardUnavailable, createBoardClient } from '../../../../plugin/bin/lib/board-http-client.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createWaveServer } from '../../../../plugin/bin/lib/wave-lifecycle-server.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createSdkJudge, waveCanUseTool } from '../../../../plugin/bin/lib/orchestrator-judge.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { parseOrchestratorArgs, reviewBase, runOrchestrator } from '../../../../plugin/bin/lib/orchestrator-runner-core.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(ROOT, 'plugin/bin/wt-run-orchestrator.mjs')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const judgeInit = (plugins: Array<{ path: string }> = []) => ({ type: 'system', subtype: 'init', plugins })
type RegisteredServer = { instance: { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> }, setCardState: (id: string, state: string) => void, state: () => unknown }
const text = (server: RegisteredServer, name: string, input: Record<string, unknown>) => server.instance._registeredTools[name]!.handler(input).then((result) => result.content[0]!.text)
function fakeSdk(root: string) {
  const packageDir = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', main: 'index.cjs' }))
  writeFileSync(join(packageDir, 'index.cjs'), 'module.exports = { query() {} }\n')
}

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
  const install = async () => 0
  return { root, worktreesDir, report, board, moves, comments, gitCalls, launches, git, runPilot, gates, reportCheck, fidelity, judge, install, options }
}

describe('orchestrator board HTTP client', () => {
  it('O1-6 lock: sends notifications/initialized before the first tools/call', async () => {
    const offsets: number[] = []
    let notified = false
    const server = createServer((request, response) => { let body = ''; request.on('data', (part) => { body += part }); request.on('end', () => { const call = JSON.parse(body); if (call.method === 'notifications/initialized') { notified = true; response.statusCode = 202; response.end(); return } if (call.method === 'tools/call' && !notified) { response.statusCode = 409; response.end(); return } const offset = call.params?.arguments?.offset; if (offset !== undefined) offsets.push(offset); if (call.method === 'tools/call') { const a = call.params.arguments; const ok = call.params.name === 'find_cards' ? typeof a.boardId === 'string' && typeof a.list === 'string' : call.params.name === 'get_card' ? typeof a.cardId === 'string' : call.params.name === 'move_card' ? typeof a.cardId === 'string' && typeof a.listId === 'string' : call.params.name === 'add_comment' ? typeof a.cardId === 'string' && typeof a.text === 'string' : call.params.name === 'get_board' ? typeof a.boardId === 'string' : false; if (!ok) { response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: `Error: invalid arguments for ${call.params.name}` }] } })); return } } const value = call.method === 'initialize' ? {} : { content: [{ type: 'text', text: JSON.stringify({ cards: [{ id: offset }], total: 2 }) }] }; response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: value })) }) })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    try { const client = createBoardClient({ boardId: 'board-1', url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }); await client.findCards({ listName: 'Next', limit: 1, offset: 0 }); await client.findCards({ listName: 'Next', limit: 1, offset: 1 }); expect(offsets).toEqual([0, 1]) } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it.each([
    ['HTTP 500', async () => ({ ok: false, status: 500, text: async () => '' })],
    ['malformed JSON', async () => ({ ok: true, text: async () => '{bad' })],
    ['malformed MCP result JSON', async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{bad' }] } }) })],
    ['malformed MCP content', async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }) })],
  ])('turns %s into BoardUnavailable', async (_name, fetch) => {
    const promise = createBoardClient({ boardId: 'board-1', url: 'http://board', fetch }).getCard('1')
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
    expect(parseOrchestratorArgs(['--cards', '1,2', '--worktrees-dir', '/tmp/w', '--report', '/tmp/r', '--hard', '2', '--base', 'dev', '--pilot-timeout', '8', '--board-url', 'http://b', '--knowledge-base-index', '/tmp/MEMORY.md', '--plugin-dir', '/tmp/rules', '--plugin-dir', '/tmp/lsp'])).toMatchObject({ cards: ['1', '2'], hard: ['2'], base: 'dev', pilotTimeout: 8, boardUrl: 'http://b', knowledgeBaseIndex: '/tmp/MEMORY.md', pluginDirs: ['/tmp/rules', '/tmp/lsp'] })
    expect(parseOrchestratorArgs(['--cards', '1', '--worktrees-dir', '/tmp/w', '--report', '/tmp/r', '--plugin-dir', 'relative/plugin'])).toEqual({ error: '--plugin-dir must be an absolute path: relative/plugin' })
    expect(parseOrchestratorArgs(['--cards', '1', '--mission-list', 'Next', '--worktrees-dir', '/tmp/w', '--report', '/tmp/r']).error).toContain('exactly one')
  })

  it('refuses a slash in an explicit card id at parse time', () => {
    expect(parseOrchestratorArgs(['--cards', '1/2', '--worktrees-dir', '/tmp/w', '--report', '/tmp/r'])).toEqual({ error: 'invalid card id' })
  })

  it('runs the complete happy path, writes receipts, moves only to In Progress, and never invokes forbidden git operations', async () => {
    const f = repoFixture(); const result = await runOrchestrator(f.options, f)
    expect(result.exitCode).toBe(0); expect(f.moves).toEqual(['1:In Progress']); expect(f.comments).toEqual([expect.stringMatching(/^1:accepted by wave testwave — awaiting main integration \(branch card\/1-wave-testwave, head [a-f0-9]+\)$/)]); expect(readFileSync(f.report, 'utf8')).toContain('main should merge card/1-wave-testwave')
    expect(readFileSync(join(result.waveDir, 'cards/1/card.md'), 'utf8')).toBe('Route: LITE\n## Definition of done\n- ship\n')
    expect(readFileSync(join(result.waveDir, 'cards/1/runner.log'), 'utf8').split('\n')[0]).toMatch(/^route=LITE /)
    expect(f.gitCalls.flat().some((arg) => ['merge', 'push', 'branch -D'].includes(arg))).toBe(false)
  }, 60_000)

  it('freezes each card base SHA when its worktree is added even if the base branch advances', async () => {
    const f = repoFixture()
    const originalBase = execFileSync('git', ['rev-parse', 'develop'], { cwd: f.root, encoding: 'utf8' }).trim()
    const git = (program: string, args: string[], options: Record<string, unknown>) => {
      const result = f.git(program, args, options)
      if (args[0] === 'worktree' && args[1] === 'add') {
        writeFileSync(join(f.root, 'advanced-after-worktree.txt'), 'not part of the card\n')
        execFileSync('git', ['add', 'advanced-after-worktree.txt'], { cwd: f.root })
        execFileSync('git', ['commit', '-qm', 'advance develop'], { cwd: f.root })
      }
      return result
    }
    const fidelity = async ({ cardDir, base }: { cardDir: string, base: string }) => {
      mkdirSync(join(cardDir, 'fidelity'), { recursive: true })
      writeFileSync(join(cardDir, 'fidelity', 'fidelity-manifest.json'), JSON.stringify({ base }))
      writeFileSync(join(cardDir, 'fidelity-verify.log'), 'EXIT=0\n')
      return 0
    }

    const result = await runOrchestrator(f.options, { ...f, git, fidelity })

    expect(result.rows[0].base).toBe(originalBase)
    expect(readFileSync(join(result.waveDir, 'cards/1/diff.patch'), 'utf8')).not.toContain('advanced-after-worktree.txt')
    expect(JSON.parse(readFileSync(join(result.waveDir, 'cards/1/fidelity/fidelity-manifest.json'), 'utf8')).base).toBe(originalBase)
    expect(readFileSync(f.report, 'utf8')).toContain(`base=${originalBase}; baseRef=develop`)
  })

  it('refuses an older per-card record with no frozen base at review', () => {
    expect(() => reviewBase({ id: '1' })).toThrow('orchestrator review refused: card 1 missing field base')
  })

  it('refuses each card with no DoD criterion before moving it or starting its pilot', async () => {
    const f = repoFixture([{ id: '1', listName: 'Next', description: 'Route: LITE\n## Notes\n- no acceptance here\n' }])
    const result = await runOrchestrator(f.options, f)
    expect(result).toMatchObject({ exitCode: 1, stopReason: expect.stringContaining('add a Definition of done to card 1') })
    expect(f.moves).toEqual([])
    expect(f.launches).toEqual([])
  })

  it('O1-7 lock: copies card receipts beside the report and prints their path', async () => {
    const f = repoFixture(); const result = await runOrchestrator(f.options, f); const receiptDir = join(f.worktreesDir, 'cards', '1')
    expect(readFileSync(join(receiptDir, 'pilot.log'), 'utf8')).toBe('EXIT=0\n')
    expect(result.rows[0].receiptDir).toBe(receiptDir)
    expect(readFileSync(f.report, 'utf8')).toContain(`| ${receiptDir} |`)
  })

  it('O1-3 lock: rejects a malformed board card id before deriving any path', async () => {
    const f = repoFixture(); const outside = join(f.root, '..', 'outside')
    const board = { ...f.board, getCard: async () => ({ id: '../../../outside', listName: 'Next', description: 'bad' }) }
    const result = await runOrchestrator(f.options, { ...f, board })
    expect(result).toMatchObject({ exitCode: 1, stopReason: 'board unavailable' })
    expect(readFileSync(f.report, 'utf8')).toContain('board unavailable: malformed card id ../../../outside')
    expect(existsSync(outside)).toBe(false)
  })

  it('O1-4 lock: reports an In Progress move awaiting reconciliation after worktree creation fails', async () => {
    const f = repoFixture(); const git = (program: string, args: string[], options: Record<string, unknown>) => { if (args[0] === 'worktree' && args[1] === 'add') throw new Error('fake worktree add failed'); return f.git(program, args, options) }
    const result = await runOrchestrator(f.options, { ...f, git })
    expect(result.exitCode).toBe(1)
    expect(result.boardMutations).toEqual([{ type: 'moveCard', id: '1', listName: 'In Progress' }])
    expect(readFileSync(f.report, 'utf8')).toContain('card 1: moved to In Progress by wave testwave, awaiting reconciliation (fake worktree add failed)')
  })

  it('R2-1 lock: a malformed Depends-on line skips the card and the report names the card and the reason', async () => {
    const cards = [{ id: '1', listName: 'Next', labels: ['P1', 'bug', 'effort:S'], description: 'Depends-on: ../../../outside\nDoD: ship' }, { id: '2', listName: 'Next', labels: ['P1', 'bug', 'effort:S'], description: 'Depends-on: none\nDoD: ship' }]
    const f = repoFixture(cards)
    const result = await runOrchestrator({ ...f.options, cards: undefined, missionList: 'Next', missionLabels: [] }, f)
    expect(result.rows.map((row: { id: string }) => row.id)).toEqual(['2'])
    expect(result.skipped).toEqual([{ id: '1', reason: 'malformed Depends-on line "../../../outside"' }])
    expect(readFileSync(f.report, 'utf8')).toContain('skipped=1 (malformed Depends-on line "../../../outside")')
    expect(f.moves).toEqual(['2:In Progress'])
  })

  it('R2-2 lock: a worker that fails does not let the report be emitted before the other worker\'s board mutations are recorded', async () => {
    const f = repoFixture([{ id: '1', listName: 'Next', description: 'a\nDoD: ship' }, { id: '2', listName: 'Next', description: 'b\nDoD: ship' }])
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const git = (program: string, args: string[], options: Record<string, unknown>) => {
      if (args[0] === 'worktree' && args[1] === 'add' && args.some((arg) => /card-1-wave-/.test(String(arg)))) throw new Error('fake worktree add failed')
      return f.git(program, args, options)
    }
    const board = { ...f.board, moveCard: async (id: string, list: string) => { if (id === '2') await gate; f.moves.push(`${id}:${list}`) } }
    const run = runOrchestrator({ ...f.options, concurrency: 2 }, { ...f, git, board })
    await new Promise((resolve) => setTimeout(resolve, 50)); release()
    const result = await run
    expect(result.exitCode).toBe(1)
    expect(result.boardMutations.map((mutation: { type: string, id: string }) => `${mutation.type}:${mutation.id}`)).toEqual(expect.arrayContaining(['moveCard:1', 'moveCard:2']))
    expect(readFileSync(f.report, 'utf8')).toContain('card 2: moved to In Progress by wave testwave, awaiting reconciliation')
  })

  it('R4 lock: a failed dependency install is a receipt, the pilot never runs and the card is escalated', async () => {
    const f = repoFixture(); let pilots = 0
    const runPilot = async (...args: unknown[]) => { pilots += 1; return f.runPilot(...(args as Parameters<typeof f.runPilot>)) }
    const result = await runOrchestrator(f.options, { ...f, runPilot, install: async (_worktree: string, cardDir: string) => { writeFileSync(join(cardDir, 'install.log'), 'ERR_PNPM_OUTDATED_LOCKFILE\nEXIT=1\n'); return 1 } })
    expect(pilots).toBe(0)
    expect(result.rows[0]).toMatchObject({ install: 1, pilot: 1, decision: 'escalated' })
    expect(readFileSync(f.report, 'utf8')).toContain('dependency install failed (EXIT=1)')
  })

  it('R5 lock: an explicit card whose get_card answer carries only a listId is resolved through the board list map', async () => {
    const f = repoFixture()
    const board = { ...f.board, getCard: async (id: string) => ({ id, listId: 'L2', description: 'Route: LITE\n## Definition of done\n- ship\n' }), listNameOf: async (listId: string) => (listId === 'L2' ? 'Next' : null) }
    const result = await runOrchestrator(f.options, { ...f, board })
    expect(result.rows.map((row: { id: string }) => row.id)).toEqual(['1'])
    expect(result.skipped).toEqual([])
  })

  it('O1-5 lock: rejects a worktrees directory whose existing symlink ancestor escapes the repository', async () => {
    const f = repoFixture(); const outside = mkdtempSync(join(tmpdir(), 'wt-waves-outside-')); roots.push(outside); const link = join(f.root, 'linked-waves'); symlinkSync(outside, link)
    const result = await runOrchestrator({ ...f.options, worktreesDir: join(link, 'nested') }, f)
    expect(result).toMatchObject({ exitCode: 1, stopReason: 'worktrees dir is outside repository root' })
  })

  it('skips duplicate and Done explicit cards without moving them', async () => {
    const f = repoFixture([{ id: '1', listName: 'Done', description: 'done' }]); const result = await runOrchestrator({ ...f.options, cards: ['1', '1'] }, f)
    expect(result).toMatchObject({ exitCode: 1, stopReason: 'no eligible card' }); expect(f.moves).toEqual([])
  })

  it('refuses an explicit card absent from the board', async () => {
    const f = repoFixture(); const result = await runOrchestrator({ ...f.options, cards: ['404'] }, f); expect(result).toMatchObject({ exitCode: 1, stopReason: 'card absent from board: 404' }); expect(f.moves).toEqual([])
  })

  it('names max-cards and no-eligible-card stop conditions', async () => {
    const cards = [{ id: '1', listName: 'Next', description: 'a\nDoD: ship' }, { id: '2', listName: 'Next', description: 'b\nDoD: ship' }]; const f = repoFixture(cards)
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
    const cards = [{ id: '1', listName: 'Next', description: 'a\nDoD: ship' }, { id: '2', listName: 'Next', description: 'b\nDoD: ship' }]; const f = repoFixture(cards); const times = [0, 61_000]
    const result = await runOrchestrator({ ...f.options, startedAt: 0, maxMinutes: 2, pilotTimeout: 60, concurrency: 2 }, { ...f, now: () => times.shift() ?? 61_000 })
    expect(result.stopReason).toBe('time budget exhausted'); expect(result.rows).toHaveLength(1)
  })

  it('fails closed on board unavailability and malformed mission responses while still writing the report', async () => {
    const f = repoFixture(); const unavailable = await runOrchestrator(f.options, { ...f, board: { ...f.board, getCard: async () => { throw new BoardUnavailable('offline') } } }); expect(unavailable).toMatchObject({ exitCode: 1, stopReason: 'board unavailable' }); expect(readFileSync(f.report, 'utf8')).toContain('stop=board unavailable')
    const malformed = await runOrchestrator({ ...f.options, cards: null, missionList: 'Next', waveId: 'malformed' }, { ...f, board: { ...f.board, findCards: async () => ({ wrong: [] }) } }); expect(malformed).toMatchObject({ exitCode: 1, stopReason: 'board unavailable' })
  })

  it('paginates mission discovery until total across two pages', async () => {
    const cards = [{ id: '1', listName: 'Next', labels: ['P1', 'bug', 'effort:S'], description: 'Depends-on: none\nDoD: ship' }, { id: '2', listName: 'Next', labels: ['P1', 'bug', 'effort:S'], description: 'Depends-on: none\nDoD: ship' }]; const f = repoFixture(cards); const offsets: number[] = []
    const board = { ...f.board, findCards: async ({ offset }: { offset: number }) => { offsets.push(offset); return { cards: cards.slice(offset, offset + 1), total: 2 } } }; const result = await runOrchestrator({ ...f.options, cards: null, missionList: 'Next', concurrency: 1 }, { ...f, board }); expect(result.rows).toHaveLength(2); expect(offsets.slice(0, 2)).toEqual([0, 1])
  })

  it.each(['main base', 'outside worktrees', 'budget below timeout'])('refuses the %s preflight', async (guard) => {
    const f = repoFixture(); const options = guard === 'main base' ? { ...f.options, base: 'main' } : guard === 'outside worktrees' ? { ...f.options, worktreesDir: join(tmpdir(), 'outside-waves') } : { ...f.options, maxMinutes: 0.5, pilotTimeout: 60 }
    const result = await runOrchestrator(options, f); expect(result.exitCode).toBe(1); expect(result.rows).toHaveLength(0); expect(result.stopReason).toBe(guard === 'main base' ? 'base main is refused' : guard === 'outside worktrees' ? 'worktrees dir is outside repository root' : 'time budget below one pilot timeout')
  })

  it.each(['branch', 'worktree'])('refuses a pre-existing target %s before moving the card', async (kind) => {
    const f = repoFixture(); if (kind === 'branch') spawnSync('git', ['branch', 'card/1-wave-testwave'], { cwd: f.root }); else mkdirSync(join(f.worktreesDir, 'card-1-wave-testwave'), { recursive: true })
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
    const cards = [{ id: '1', listName: 'Next', description: 'a\nDoD: ship' }, { id: '2', listName: 'Next', description: 'b\nDoD: ship' }]; const f = repoFixture(cards); let active = 0; let peak = 0; let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve }); setTimeout(() => release(), 200); const judged: string[] = []
    const runPilot = async (...args: Parameters<typeof f.runPilot>) => { active += 1; peak = Math.max(peak, active); if (active === 2) release(); await barrier; const result = await f.runPilot(...args); writeFileSync(join(args[0].dir, 'shared.txt'), args[0].card); spawnSync('git', ['add', '.'], { cwd: args[0].dir }); spawnSync('git', ['commit', '-qm', 'shared'], { cwd: args[0].dir }); active -= 1; return result }
    const judge = async ({ row }: { row: { id: string, decision: string } }) => { judged.push(row.id); row.decision = 'accepted' }
    const result = await runOrchestrator({ ...f.options, concurrency: 2 }, { ...f, runPilot, judge }); expect(peak).toBe(2); expect(judged).toEqual(['1', '2']); expect(result.rows.map((row: { id: string }) => row.id)).toEqual(['1', '2']); expect(readFileSync(f.report, 'utf8')).toContain('seam overlap 1/2: shared.txt')
  })

  it('applies all three mission label axes and Done dependencies fail-closed', async () => {
    const cards = [{ id: '1', listName: 'Next', labels: ['P1', 'bug', 'effort:S', 'mission'], description: 'Depends-on: #9\nDoD: ship' }, { id: '2', listName: 'Next', labels: ['P1', 'bug', 'mission'], description: 'Depends-on: none\nDoD: ship' }]; const f = repoFixture(cards)
    const board = { ...f.board, getCard: async (id: string) => id === '9' ? { id: '9', listName: 'Done' } : f.board.getCard(id) }; const result = await runOrchestrator({ ...f.options, cards: null, missionList: 'Next', missionLabels: ['mission'] }, { ...f, board }); expect(result.rows.map((row: { id: string }) => row.id)).toEqual(['1'])
  })

  it('re-scans a mission after each card and removes cards that cease to be eligible', async () => {
    const cards = [{ id: '1', listName: 'Next', labels: ['P1', 'bug', 'effort:S', 'mission'], description: 'Depends-on: #9\nDoD: ship' }, { id: '2', listName: 'Next', labels: ['P1', 'bug', 'effort:S', 'mission'], description: 'Depends-on: none\nDoD: ship' }]; const f = repoFixture(cards); let scans = 0
    const board = { ...f.board, getCard: async (id: string) => id === '9' ? { id: '9', listName: 'Done' } : f.board.getCard(id), findCards: async (args: { limit: number, offset: number }) => { scans += 1; const visible = scans === 1 ? cards : cards.slice(0, 1); return { cards: visible.slice(args.offset, args.offset + args.limit), total: visible.length } } }
    const result = await runOrchestrator({ ...f.options, cards: null, missionList: 'Next', missionLabels: ['mission'] }, { ...f, board }); expect(result.rows.map((row: { id: string }) => row.id)).toEqual(['1']); expect(scans).toBeGreaterThanOrEqual(2)
  })

  it('writes an exit-1 report when the driver throws', async () => {
    const f = repoFixture(); const result = await runOrchestrator(f.options, { ...f, runPilot: async () => { throw new Error('controlled driver failure') } }); expect(result.exitCode).toBe(1); expect(readFileSync(f.report, 'utf8')).toContain('controlled driver failure')
  })

  it('prints the routing line before doing driver work', () => {
    const f = repoFixture(); const configDir = mkdtempSync(join(tmpdir(), 'wt-orch-config-')); roots.push(configDir); writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const result = spawnSync(process.execPath, [CLI, '--cards', '1', '--base', 'main', '--worktrees-dir', f.worktreesDir, '--report', f.report], { cwd: f.root, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } }); expect(result.stdout.split('\n')[0]).toMatch(/^wave=\S+ report=/)
  })

  it('has no up-front lane-consent refusal path', () => {
    const source = readFileSync(CLI, 'utf8')
    expect(source).not.toContain('sdk-runner-consent')
    expect(source).not.toContain('sdkRunnerConsentRefusal')
  })

  it('resolves the SDK even when the installed profile has no lane consent', () => {
    const f = repoFixture(); const installed = join(f.root, 'installed-plugin'); cpSync(join(ROOT, 'plugin'), installed, { recursive: true })
    const configDir = mkdtempSync(join(tmpdir(), 'wt-orch-config-')); roots.push(configDir); writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: {} }))
    const result = spawnSync(process.execPath, [join(installed, 'bin/wt-run-orchestrator.mjs'), '--cards', '1', '--base', 'main', '--worktrees-dir', f.worktreesDir, '--report', f.report], { cwd: f.root, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, NODE_PATH: '' } })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@anthropic-ai/claude-agent-sdk is not installed')
  })

  it('refuses a missing orchestrator SDK with one copy-pastable line', () => {
    const f = repoFixture(); const installed = join(f.root, 'installed-plugin'); cpSync(join(ROOT, 'plugin'), installed, { recursive: true })
    const configDir = mkdtempSync(join(tmpdir(), 'wt-orch-config-')); roots.push(configDir); writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir, NODE_PATH: '', NPM_CONFIG_PREFIX: join(f.root, 'empty-global') }
    delete env.CLAUDE_PLUGIN_DATA
    const result = spawnSync(process.execPath, [join(installed, 'bin/wt-run-orchestrator.mjs'), '--cards', '1', '--base', 'main', '--worktrees-dir', f.worktreesDir, '--report', f.report], { cwd: f.root, encoding: 'utf8', env })
    expect(result.status).toBe(1)
    expect(result.stderr.trim().split(/\r?\n/)).toEqual(['wt-run-orchestrator: @anthropic-ai/claude-agent-sdk is not installed; run: npm install -g @anthropic-ai/claude-agent-sdk'])
    expect(result.stdout).toBe('')
  })

  it('resolves the SDK from the orchestrator process cwd in an installed plugin tree', () => {
    const f = repoFixture(); fakeSdk(f.root)
    const installed = join(f.root, 'installed-plugin'); cpSync(join(ROOT, 'plugin'), installed, { recursive: true })
    const configDir = mkdtempSync(join(tmpdir(), 'wt-orch-config-')); roots.push(configDir); writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const profile = join(f.root, 'bad-profile.json'); writeFileSync(profile, '{bad')
    const result = spawnSync(process.execPath, [join(installed, 'bin/wt-run-orchestrator.mjs'), '--cards', '1', '--base', 'main', '--worktrees-dir', f.worktreesDir, '--report', f.report, '--profile-env', profile], { cwd: f.root, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, NODE_PATH: '', NPM_CONFIG_PREFIX: join(f.root, 'empty-global') } })
    expect(result.status).toBe(1)
    expect(result.stderr.trim().split(/\r?\n/)).toEqual([expect.stringContaining('wt-run-orchestrator: cannot read --profile-env')])
    expect(result.stderr).not.toContain('@anthropic-ai/claude-agent-sdk is not installed')
  })
})

describe('SDK orchestrator judge', () => {
  it('drives two cards through the registered wave server in one model-selected query and embeds judgment verbatim', async () => {
    const cards = [
      { id: '1', listName: 'Next', description: 'Route: LITE\n## Definition of done\n- ship one\n' },
      { id: '2', listName: 'Next', description: 'Route: LITE\n## Definition of done\n- ship two\n' },
    ]
    const f = repoFixture(cards); const knowledgeBaseIndex = join(f.root, 'MEMORY.md'); writeFileSync(knowledgeBaseIndex, '# Memory\n'); let calls = 0; const prompts: string[] = []; let queryOptions: Record<string, unknown> = {}
    type Server = { instance: { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> } }
    const judgment = '## Independent Review\nBoth diffs satisfy their cards.\n\n## Decisions\n1 accept; 2 reject.'
    const query = ({ prompt, options }: { prompt: AsyncGenerator<{ message: { content: string } }>, options: Record<string, unknown> }) => {
      calls += 1; queryOptions = options
      return (async function* () {
        yield judgeInit(options.plugins as Array<{ path: string }>)
        const tools = ((options.mcpServers as Record<string, Server>)['sdk-wave-lifecycle']!).instance._registeredTools
        for (const [id, decision] of [['1', 'accept'], ['2', 'reject']] as const) {
          const message = await prompt.next(); prompts.push(message.value.message.content)
          const result = await tools.decide!.handler({ cardId: id, decision, reason: `${decision} reason`, assessment: `card-${id}.txt:1 satisfies the bullet.`, tool_use_id: `decision-${id}` })
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `decision-${id}`, content: result.content }] } }
          yield { type: 'result' }
        }
        const final = await prompt.next(); prompts.push(final.value.message.content)
        const result = await tools.write_judgment!.handler({ content: judgment, tool_use_id: 'judgment' })
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'judgment', content: result.content }] } }
      })()
    }
    const plugins = [join(f.root, 'rules-plugin'), join(f.root, 'lsp-plugin')]; plugins.forEach((plugin) => mkdirSync(plugin))
    const result = await runOrchestrator({ ...f.options, knowledgeBaseIndex, pluginDirs: plugins }, { ...f, judge: undefined, query, models: { orchestrator: { value: 'wave-model' } }, contract: '# contract' })
    expect(calls).toBe(1)
    expect(queryOptions).toMatchObject({ model: 'wave-model', systemPrompt: '# contract', settingSources: [], permissionMode: 'default', cwd: result.waveDir, tools: ['Read', 'Glob', 'Grep'] })
    expect(queryOptions.plugins).toEqual(plugins.map((plugin) => ({ type: 'local', path: plugin })))
    expect(f.launches).toHaveLength(2)
    expect(f.launches.every((launch) => JSON.stringify(launch).includes(JSON.stringify(plugins)))).toBe(true)
    expect(Object.keys(queryOptions.mcpServers as object)).toEqual(['sdk-wave-lifecycle'])
    expect(prompts).toEqual([
      `KNOWLEDGE_BASE_INDEX: ${knowledgeBaseIndex}\nJudge card 1: read it with read_card, its report with read_card_report, its diff with read_diff, then decide.`,
      'Judge card 2: read it with read_card, its report with read_card_report, its diff with read_diff, then decide.',
      'Every card is decided: write_judgment.',
    ])
    expect(await (queryOptions.canUseTool as (name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>)('Read', { file_path: knowledgeBaseIndex })).toEqual({ behavior: 'allow' })
    writeFileSync(join(f.root, 'a-fiche.md'), 'fiche\n')
    expect(await (queryOptions.canUseTool as (name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>)('Read', { file_path: join(f.root, 'a-fiche.md') })).toEqual({ behavior: 'allow' })
    expect(result.rows.map((row: { decision: string, reason: string }) => [row.decision, row.reason])).toEqual([['accepted', 'accept reason'], ['rejected', 'reject reason']])
    expect(readFileSync(f.report, 'utf8')).toContain(judgment)
  })

  it('refuses a judge init receipt missing a configured plugin and accepts canonical symlink/trailing-slash paths', async () => {
    const f = repoFixture(); const waveDir = join(f.root, '.waves', 'judge-receipt'); mkdirSync(waveDir, { recursive: true })
    const target = join(f.root, 'plugin-target'); const linked = join(f.root, 'plugin-link'); mkdirSync(target); symlinkSync(target, linked)
    const waveServer = createWaveServer({ waveDir, cards: [{ id: '1' }] }) as RegisteredServer
    waveServer.setCardState('1', 'piloting'); waveServer.setCardState('1', 'judging')
    const missing = createSdkJudge({ query: () => (async function* () { yield judgeInit() })(), models: { orchestrator: { value: 'test' } }, waveDir, waveServer, contract: '# contract', pluginDirs: [linked] })
    await expect(missing({ row: { id: '1' } })).rejects.toThrow(/initialization receipt.*absentPlugins/)

    const acceptedServer = createWaveServer({ waveDir, cards: [{ id: '1' }] }) as RegisteredServer
    acceptedServer.setCardState('1', 'piloting'); acceptedServer.setCardState('1', 'judging')
    const accepted = createSdkJudge({ query: () => (async function* () { yield judgeInit([{ path: `${realpathSync(target)}/` }]); yield { type: 'result' }; yield { type: 'result' }; yield { type: 'result' } })(), models: { orchestrator: { value: 'test' } }, waveDir, waveServer: acceptedServer, contract: '# contract', pluginDirs: [linked] })
    await expect(accepted({ row: { id: '1' } })).resolves.toBe(false)
  })

  it('O1-2 lock: rejects absolute and traversal Glob/Grep inputs while allowing wildcard-first local patterns', () => {
    const f = repoFixture(); const wave = join(f.root, '.waves'); mkdirSync(wave, { recursive: true })
    for (const name of ['wave_state', 'read_card', 'read_card_report', 'read_diff', 'decide', 'write_judgment']) {
      expect(waveCanUseTool(wave, `mcp__sdk-wave-lifecycle__${name}`, {}).behavior).toBe('allow')
    }
    expect(waveCanUseTool(wave, 'mcp__sdk-wave-lifecycle__delete_wave', {}).behavior).toBe('deny')
    expect(waveCanUseTool(wave, 'mcp__planka__move_card', {}).behavior).toBe('deny')
    expect(waveCanUseTool(wave, 'Read', { file_path: join(f.root, 'base.txt') })).toEqual({ behavior: 'deny', message: `path outside wave directory: ${join(f.root, 'base.txt')}` })
    expect(waveCanUseTool(wave, 'Glob', { pattern: '../*.txt' })).toEqual({ behavior: 'deny', message: 'path outside wave directory: ../*.txt' })
    expect(waveCanUseTool(wave, 'Glob', { pattern: '*/../../x' }).behavior).toBe('deny')
    expect(waveCanUseTool(wave, 'Glob', { pattern: '/etc/*' }).behavior).toBe('deny')
    expect(waveCanUseTool(wave, 'Grep', { path: f.root, pattern: 'secret' }).behavior).toBe('deny')
    expect(waveCanUseTool(wave, 'Glob', { pattern: '*/inside' }).behavior).toBe('allow')
    expect(waveCanUseTool(wave, 'Read', { file_path: join(wave, 'missing.txt') }).behavior).toBe('allow')
  })

  it('refuses to launch the SDK judge when a symlink exists under the wave directory', async () => {
    const f = repoFixture(); let launched = false
    const gates = async (worktree: string, cardDir: string) => { const result = await f.gates(worktree, cardDir); symlinkSync(join(f.root, 'base.txt'), join(cardDir, 'planted-link')); return result }
    const query = () => { launched = true; return (async function* () {})() }
    const result = await runOrchestrator(f.options, { ...f, judge: undefined, gates, query, models: { orchestrator: { value: 'sonnet' } }, contract: '# contract' })
    expect(result).toMatchObject({ exitCode: 1, stopReason: 'judge refused: symlink under wave directory: cards/1/planted-link' })
    expect(launched).toBe(false)
    expect(readFileSync(f.report, 'utf8')).toContain('judge refused: symlink under wave directory')
  })

  it('marks every remaining card undecided and writes an exit-1 report after three turns without progress', async () => {
    const cards = [{ id: '1', listName: 'Next', description: 'a\nDoD: ship' }, { id: '2', listName: 'Next', description: 'b\nDoD: ship' }]; const f = repoFixture(cards); const prompts: string[] = []
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield judgeInit()
      prompts.push((await prompt.next()).value.message.content)
      for (let turn = 0; turn < 3; turn += 1) {
        yield { type: 'result' }
        prompts.push((await prompt.next()).value.message.content)
      }
    })()
    const result = await runOrchestrator(f.options, { ...f, judge: undefined, query, models: { orchestrator: { value: 'sonnet' } }, contract: '# contract' })
    expect(prompts).toHaveLength(4)
    expect(prompts.slice(1)).toEqual(Array(3).fill('Card 1 is still judging. Use decide for card 1.'))
    expect(result.exitCode).toBe(1)
    expect(result.rows.map((row: { decision: string }) => row.decision)).toEqual(['undecided', 'undecided'])
    expect(readFileSync(f.report, 'utf8')).toContain('session ended before judgment')
  })

  it('fails closed when the SDK stream ends between a card decision and the final judgment', async () => {
    const cards = [{ id: '1', listName: 'Next', description: 'a\nDoD: ship' }, { id: '2', listName: 'Next', description: 'b\nDoD: ship' }]; const f = repoFixture(cards)
    type Server = { instance: { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> } }
    const query = ({ prompt, options }: { prompt: AsyncGenerator<{ message: { content: string } }>, options: { mcpServers: Record<string, Server> } }) => (async function* () {
      yield judgeInit()
      const tools = options.mcpServers['sdk-wave-lifecycle']!.instance._registeredTools
      await prompt.next()
      const result = await tools.decide!.handler({ cardId: '1', decision: 'reject', reason: 'contradiction', assessment: 'card-1.txt:1 contradicts the bullet.', tool_use_id: 'first' })
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'first', content: result.content }] } }
    })()
    const result = await runOrchestrator(f.options, { ...f, judge: undefined, query, models: { orchestrator: { value: 'sonnet' } }, contract: '# contract' })
    expect(result.exitCode).toBe(1)
    expect(result.stopReason).toBe('orchestrator session ended before judgment')
    expect(result.rows.map((row: { decision: string }) => row.decision)).toEqual(['rejected', 'undecided'])
    expect(readFileSync(f.report, 'utf8')).toContain('session ended before judgment')
  })

  it('keeps the orchestrator contract bounded and explicit about the enforced limits', () => {
    const contract = readFileSync(join(ROOT, 'plugin/autonomy/ORCHESTRATOR-CONTRACT.md'), 'utf8')
    expect(Buffer.byteLength(contract)).toBeLessThanOrEqual(4096)
    expect(contract).toContain('You have no Bash, Write,\nEdit, or Planka tool.')
    expect(contract).toContain('Never merge, push, publish, move a board card, or mark work Done.')
  })

  it('O1-8 lock: documents orchestrator fence residuals and symlink refusal', () => {
    const runner = readFileSync(join(ROOT, 'plugin/autonomy/PILOT-RUNNER.md'), 'utf8')
    expect(runner).toContain('A push that supplies an explicit URL')
    expect(runner).toContain('merge commit\nexplicitly requested with `--no-verify` remains a residual')
    expect(runner).toContain('refuses to launch the judge if any symlink exists')
  })

  it.skipIf(process.env.WT_REAL_SDK_LOCK !== '1')('refuses an out-of-wave Read through a real SDK query without shadowing canUseTool', async () => {
    const f = repoFixture(); const waveDir = join(f.root, '.waves', 'real-sdk'); mkdirSync(join(waveDir, 'cards', '1'), { recursive: true }); writeFileSync(join(waveDir, 'cards', '1', 'card.md'), '## Definition of done\n- permission lock\n')
    const waveServer = createWaveServer({ waveDir, cards: [{ id: '1' }] }) as RegisteredServer; waveServer.setCardState('1', 'piloting'); waveServer.setCardState('1', 'judging')
    const messages: unknown[] = []; const warnings: string[] = []; const stderr: string[] = []
    const onWarning = (warning: Error & { code?: string }) => warnings.push(`${warning.code ?? ''}: ${warning.message}`); process.on('warning', onWarning)
    const query = ({ prompt, options }: Parameters<typeof sdkQuery>[0]) => (async function* () {
      try {
        for await (const message of sdkQuery({ prompt, options: { ...options, maxTurns: 1, stderr: (line) => stderr.push(line) } })) { messages.push(message); yield message }
      } catch (error) { if (!(error instanceof Error) || !error.message.includes('Reached maximum number of turns (1)')) throw error }
    })()
    try {
      const judge = createSdkJudge({ query, models: { orchestrator: { value: 'haiku' } }, waveDir, waveServer, contract: 'For card 1, first use Read on /etc/hostname. Do not call decide.' })
      await judge({ row: { id: '1' } })
    } finally { process.off('warning', onWarning) }
    await new Promise((resolve) => setImmediate(resolve))
    const transcript = JSON.stringify(messages)
    const refused = transcript.includes('path outside wave directory: /etc/hostname')
    const shadowed = [...warnings, ...stderr].some((line) => line.includes('CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'))
    process.stdout.write(`REAL_SDK_READ_REFUSED=${refused}\nREAL_SDK_SHADOWED_WARNING=${shadowed}\n`)
    expect(refused).toBe(true)
    expect(shadowed).toBe(false)
  }, 120_000)
})

describe('real git worktree fence', () => {
  it('O1-1 lock: fences configured-remote pushes and fast-forwardable merges only in the card worktree', async () => {
    const f = repoFixture(); const remote = mkdtempSync(join(tmpdir(), 'wt-remote-')); roots.push(remote); spawnSync('git', ['init', '--bare', '-q'], { cwd: remote }); spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: f.root }); expect(spawnSync('git', ['push', '-u', 'origin', 'develop'], { cwd: f.root }).status).toBe(0)
    const result = await runOrchestrator(f.options, f); const worktree = result.rows[0].worktree
    writeFileSync(join(worktree, 'plain.txt'), 'plain\n'); spawnSync('git', ['add', '.'], { cwd: worktree }); expect(spawnSync('git', ['commit', '-qm', 'plain'], { cwd: worktree }).status).toBe(0)
    const pushNoVerify = spawnSync('git', ['push', '--no-verify', 'origin', 'HEAD'], { cwd: worktree, encoding: 'utf8' }); expect(pushNoVerify.status).not.toBe(0); expect(pushNoVerify.stderr).toContain('refused-push')
    const push = spawnSync('git', ['push', 'origin', 'HEAD'], { cwd: worktree, encoding: 'utf8' }); expect(push.status).not.toBe(0); expect(push.stderr).toContain('refused-push')
    spawnSync('git', ['checkout', '-qb', 'side', 'card/1-wave-testwave'], { cwd: f.root }); writeFileSync(join(f.root, 'side.txt'), 'side\n'); spawnSync('git', ['add', '.'], { cwd: f.root }); spawnSync('git', ['commit', '-qm', 'side'], { cwd: f.root }); spawnSync('git', ['checkout', '-q', 'develop'], { cwd: f.root })
    const merge = spawnSync('git', ['merge', 'side'], { cwd: worktree, encoding: 'utf8' }); expect(merge.status).not.toBe(0); expect(`${merge.stdout}${merge.stderr}`).toContain("refused by wave testwave: merge is main's")
    spawnSync('git', ['merge', '--abort'], { cwd: worktree })
    const ffOnly = spawnSync('git', ['merge', '--ff-only', 'side'], { cwd: worktree, encoding: 'utf8' }); expect(ffOnly.status).not.toBe(0); expect(`${ffOnly.stdout}${ffOnly.stderr}`).toContain("refused by wave testwave: merge is main's")
    expect(spawnSync('git', ['commit', '--allow-empty', '-qm', 'main unaffected'], { cwd: f.root }).status).toBe(0); expect(spawnSync('git', ['push', 'origin', 'develop'], { cwd: f.root }).status).toBe(0)
  })
})

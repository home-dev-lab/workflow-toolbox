import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BIN = join(ROOT, 'plugin/bin')
const PRODUCER = process.env.WT_ACTIONABLE_TEST_PRODUCER || join(BIN, 'wt-actionable-snapshot-producer-hook.mjs')
const REFRESH = join(BIN, 'wt-actionable-snapshot-refresh.mjs')
const GATE = join(BIN, 'wt-actionable-gate-hook.mjs')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-actionable-bounded-')))
  roots.push(root)
  const cwd = join(root, 'project')
  const state = join(root, 'state/wt-actionable')
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  mkdirSync(state, { recursive: true })
  writeFileSync(join(cwd, '.claude/planka.json'), JSON.stringify({ boardId: 'board' }))
  const prefix = join(state, cwd.replace(/[^A-Za-z0-9-]/g, '-'))
  const transcript = join(root, 'transcript.jsonl')
  writeFileSync(transcript, '{}\n')
  const fixture = join(root, 'lanes.json')
  writeFileSync(fixture, JSON.stringify({ hookPid: 100, processes: [] }))
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: undefined, CLAUDE_CONFIG_DIR: join(root, 'config'),
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), WT_GUARD_JOURNAL_DIR: join(root, 'journal'),
    XDG_STATE_HOME: join(root, 'state'), WT_AUTONOMY_WATCH_MANDATE_DIR: join(root, 'mandate'),
    WT_ACTIONABLE_MAX_SPILL_BYTES: undefined, WT_ACTIONABLE_DEPS_TIMEOUT_MS: undefined,
    WT_ACTIONABLE_REFRESH_TIMEOUT_MS: undefined, WT_ACTIONABLE_AUTO_REFRESH_AFTER_MS: undefined,
    WT_ACTIONABLE_PROPOSAL_MAX_AGE_MS: undefined, WT_ACTIONABLE_STALE_AFTER_MS: undefined,
    WT_ACTIONABLE_BLOCK_MAX: undefined,
    WT_ACTIONABLE_LANE_FIXTURE_PATH: fixture }
  return { root, cwd, state, prefix, env, transcript }
}
type Project = ReturnType<typeof project>
function json(path: string) { return JSON.parse(readFileSync(path, 'utf8')) }
function run(source: string, p: Project) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: p.env, encoding: 'utf8', timeout: 120_000 })
}
function payload(p: Project, extra: Record<string, unknown> = {}) {
  return { tool_name: 'mcp__planka__find_cards', tool_input: { boardId: 'board' }, cwd: p.cwd,
    tool_response: { content: [{ type: 'text', text: JSON.stringify([{ id: '100020', name: 'Ready',
      listName: 'Next', listId: 'next', description: 'Depends-on: none' }]) }] }, ...extra }
}
function produce(p: Project, extra: Record<string, unknown> = {}, before = '') {
  return run(`${before}\nconst { produceSnapshot } = await import(${JSON.stringify(pathToFileURL(PRODUCER).href)}); produceSnapshot(${JSON.stringify(payload(p, extra))})`, p)
}
function snapshot(p: Project, at = Date.now() - 20 * 60_000) {
  writeFileSync(`${p.prefix}.json`, JSON.stringify({ at, actionable: 2, next: 'Ready', workPossible: true,
    reason: '', blockedUntil: null, inFlightUntil: null }))
  return at
}
function failure(p: Project, extra: Record<string, unknown> = {}) {
  writeFileSync(`${p.prefix}.project-state.json`, JSON.stringify({ optedIn: true, heartbeatAt: Date.now(),
    lastOutcome: 'unavailable', lastReason: 'refresh-timeout', ...extra }))
}
function stop(p: Project, cwd = p.cwd) {
  const result = spawnSync(process.execPath, [GATE], { env: p.env, encoding: 'utf8', timeout: 2000,
    input: JSON.stringify({ hook_event_name: 'Stop', cwd, session_id: 'test', transcript_path: p.transcript }) })
  expect(result.status).toBe(0)
  return result.stdout ? JSON.parse(result.stdout) : {}
}
function live(p: Project, cwd = p.cwd) {
  mkdirSync(join(p.root, 'mandate'), { recursive: true })
  writeFileSync(join(p.root, 'mandate', `engine-${cwd.replace(/[^A-Za-z0-9-]/g, '-')}.json`),
    JSON.stringify({ declaredAtMs: Date.now(), sessionId: 'test' }))
}
function optIn(p: Project) {
  writeFileSync(join(p.cwd, '.claude/planka.json'), JSON.stringify({ boardId: 'board', actionableAutoRefresh: true }))
}
function stub(p: Project, source = `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(join(p.root, 'marker'))}, process.cwd() + '\\n')`) {
  const path = join(p.root, 'refresh-stub.mjs')
  writeFileSync(path, source)
  p.env = { ...p.env, WT_ACTIONABLE_REFRESH_BIN: path } as typeof p.env
  return path
}
function collect(p: Project, source: string) {
  const result = run(`import { collectCompleteCards } from ${JSON.stringify(pathToFileURL(REFRESH).href)};
    ${source}`, p)
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

  it('bounded actionability producer: writes a snapshot from a ten MiB spilled board payload', () => {
    const p = project()
    const path = join(p.root, 'board-spill.json')
    writeFileSync(path, JSON.stringify({ lists: [{ name: 'Next', cards: [{ id: '100020', name: 'Ready',
      description: 'Depends-on: none' }] }], padding: 'x'.repeat(10 * 1024 * 1024) }))
    const result = produce(p, { tool_name: 'mcp__planka__get_board', tool_response: { content: [{ type: 'text',
      text: `Error: result exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text` }] } })
    expect(result.status).toBe(0)
    expect(existsSync(`${p.prefix}.json`)).toBe(true)
    expect(json(`${p.prefix}.json`).actionable).toBe(1)
  })

  it('bounded actionability producer: publishes snapshot and state through temporary files and cleans them', () => {
    const p = project()
    const result = produce(p, {}, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const writes = []; const original = fs.writeFileSync; fs.writeFileSync = (path, ...args) => {
        writes.push(String(path)); return original(path, ...args) }; syncBuiltinESMExports();
      process.on('exit', () => process.stdout.write(JSON.stringify(writes)))`)
    expect(result.status).toBe(0)
    const writes: string[] = JSON.parse(result.stdout)
    expect(writes).not.toContain(`${p.prefix}.json`)
    expect(writes).not.toContain(`${p.prefix}.project-state.json`)
    expect(json(`${p.prefix}.json`).actionable).toBe(1)
    expect(json(`${p.prefix}.project-state.json`).lastOutcome).toBe('snapshot-written')
    expect(readdirSync(p.state).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('bounded actionability producer: ordinary hook readings declare their ninety second deadline', () => {
    const p = project()
    const result = produce(p, {}, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const write = fs.writeFileSync; let reading;
      fs.writeFileSync = (path, data, ...args) => { if (String(path).includes('.project-state.json')) {
        const state = JSON.parse(String(data)); if (state.lastOutcome === 'reading') reading = state }
        return write(path, data, ...args) }; syncBuiltinESMExports();
      process.on('exit', () => process.stdout.write(JSON.stringify(reading)))`)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).deadlineAt - json(`${p.prefix}.json`).at).toBe(90_000)
  })

  it('the hook host allows the producer budget and cleanup time for every producer registration', () => {
    const manifest = json(join(ROOT, 'plugin/.claude-plugin/plugin.json'))
    const hooks = manifest.hooks.PostToolUse.flatMap((group: { hooks?: Array<{ command: string; timeout: number }> }) => group.hooks ?? [])
      .filter((hook: { command: string }) => hook.command.includes('wt-actionable-snapshot-producer-hook.mjs'))
    expect(hooks.length).toBeGreaterThan(0)
    for (const hook of hooks) expect(hook.timeout * 1000).toBeGreaterThanOrEqual(90_000 + 2000)
  })

  it('bounded actionability producer: a failing rename preserves the previous snapshot and removes its temporary file', () => {
    const p = project()
    const at = snapshot(p)
    const result = produce(p, {}, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const original = fs.renameSync; fs.renameSync = (from, to) => {
        if (to === ${JSON.stringify(`${p.prefix}.json`)}) throw new Error('rename refused');
        return original(from, to) }; syncBuiltinESMExports()`)
    expect(result.status).toBe(0)
    expect(json(`${p.prefix}.json`).at).toBe(at)
    expect(json(`${p.prefix}.project-state.json`).lastReason).toBe('snapshot-write-failed')
    expect(readdirSync(p.state).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('bounded actionability producer: keeps a newer acquisition when an older producer completes afterwards', () => {
    const p = project()
    const at = snapshot(p, Date.now() - 1000)
    expect(produce(p, { acquisitionStartedAt: at - 1000 }).status).toBe(0)
    expect(json(`${p.prefix}.json`).at).toBe(at)
    expect(json(`${p.prefix}.project-state.json`)).toMatchObject({ lastOutcome: 'superseded', snapshotAt: at })
  })

  it('bounded actionability producer: records acquisition start and the generation described by producer state', () => {
    const p = project()
    const at = Date.now() - 1000
    expect(produce(p, { acquisitionStartedAt: at }).status).toBe(0)
    expect(json(`${p.prefix}.json`).at).toBe(at)
    expect(json(`${p.prefix}.project-state.json`).snapshotAt).toBe(at)
  })

  it('bounded actionability producer: does not spawn a parser or publish after the deadline', () => {
    const p = project()
    const at = snapshot(p)
    const dir = join(p.cwd, '.claude/scripts/lib')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'depends-on-parser.mjs'), `import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(p.root, 'parser-ran'))}, 'yes'); process.stdout.write('{"ids":[],"unparseable":[]}')`)
    expect(produce(p, { deadlineAt: Date.now() - 1 }).status).toBe(0)
    expect(existsSync(join(p.root, 'parser-ran'))).toBe(false)
    expect(json(`${p.prefix}.json`).at).toBe(at)
    expect(json(`${p.prefix}.project-state.json`).lastReason).toBe('refresh-timeout')
  })

  it('bounded actionability producer: kills a parser ignoring SIGTERM within the remaining deadline and never publishes', () => {
    const p = project()
    const at = snapshot(p)
    const dir = join(p.cwd, '.claude/scripts/lib')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'depends-on-parser.mjs'), `process.on('SIGTERM', () => {}); setTimeout(() => {
      process.stdout.write('{"ids":[],"unparseable":[]}') }, 800)`)
    const started = Date.now()
    expect(produce(p, { deadlineAt: started + 200 }).status).toBe(0)
    expect(Date.now() - started).toBeLessThan(700)
    expect(json(`${p.prefix}.json`).at).toBe(at)
    expect(json(`${p.prefix}.project-state.json`).lastReason).toBe('refresh-timeout')
  })

  it.each(['valid', 'invalid'])('bounded actionability producer: refuses publication when the deadline expires during synchronous computation (%s parser reply)', (reply) => {
    const p = project()
    const at = snapshot(p)
    const marker = join(p.root, 'computation-finished')
    const dir = join(p.cwd, '.claude/scripts/lib')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'depends-on-parser.mjs'), `import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'yes'); process.stdout.write(${JSON.stringify(reply === 'valid' ? '{"ids":[],"unparseable":[]}' : 'not json')})`)
    expect(produce(p, { deadlineAt: Date.now() + 1000 }, `import { existsSync } from 'node:fs';
      const originalNow = Date.now; Date.now = () => originalNow() + (existsSync(${JSON.stringify(marker)}) ? 2000 : 0)`).status).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(json(`${p.prefix}.json`).at).toBe(at)
    expect(json(`${p.prefix}.project-state.json`).lastReason).toBe('refresh-timeout')
  })
  it('bounded actionability producer: a deadline expiring in the generation read prevents publication', () => {
    const p = project()
    const at = snapshot(p)
    const before = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFileSync, write = fs.writeFileSync, now = Date.now; let armed = false, expired = false;
      fs.writeFileSync = (path, ...args) => { if (String(path).startsWith(${JSON.stringify(`${p.prefix}.json.`)})) armed = true; return write(path, ...args) };
      fs.readFileSync = (path, ...args) => { if (path === ${JSON.stringify(`${p.prefix}.json`)} && armed) expired = true; return read(path, ...args) };
      Date.now = () => now() + (expired ? 10000 : 0); syncBuiltinESMExports();`
    expect(produce(p, { deadlineAt: Date.now() + 2000 }, before).status).toBe(0)
    expect(json(`${p.prefix}.json`).at).toBe(at)
    expect(json(`${p.prefix}.project-state.json`).lastReason).toBe('refresh-timeout')
  })

// Stable board acquisition.
  for (const shape of ['empty', 'duplicate', 'missing', 'over-count']) {
    it(`retries an unstable ${shape} scan from offset zero`, () => {
      const p = project()
      expect(collect(p, `let scans = 0; const shape = ${JSON.stringify(shape)};
        const result = await collectCompleteCards(async (offset, limit) => { scans++;
          if (scans === 1) { const cards = shape === 'empty' ? [] : shape === 'missing' ? [{}] : [{ id: '1' }, { id: '1' }];
            return { offset, total: shape === 'over-count' || shape === 'missing' ? 1 : 2, cards } }
          return { offset, total: 1, cards: [{ id: '1' }] } });
        process.stdout.write(JSON.stringify({ count: result.length, scans }))`)).toEqual({ count: 1, scans: 2 })
    })
  }
  it('reads a board of this size in one 5000-card page', () => {
    const p = project()
    expect(collect(p, `const calls = []; const cards = Array.from({ length: 2481 }, (_, i) => ({ id: String(i) }));
      const result = await collectCompleteCards(async (offset, limit) => { calls.push([offset, limit]);
        return { offset, total: cards.length, cards: cards.slice(offset, offset + limit) } });
      process.stdout.write(JSON.stringify({ count: result.length, calls }))`)).toEqual({ count: 2481, calls: [[0, 5000]] })
  })

  it('restarts a moving total and accepts two agreeing complete scans', () => {
    const p = project()
    expect(collect(p, `let scans = 0; const cards = Array.from({ length: 5001 }, (_, i) => ({ id: String(i) }));
      const result = await collectCompleteCards(async (offset, limit) => { if (offset === 0) scans++;
        return { offset, total: scans === 1 && offset > 0 ? 5002 : 5001, cards: cards.slice(offset, offset + limit) } });
      process.stdout.write(JSON.stringify({ count: result.length, scans }))`)).toEqual({ count: 5001, scans: 3 })
  })

  it('a same-total list move requires a third agreeing scan', () => {
    const p = project()
    expect(collect(p, `let scans = 0; const cards = Array.from({ length: 5001 }, (_, i) => ({ id: String(i), listId: 'next' }));
      const result = await collectCompleteCards(async (offset, limit) => { if (offset === 0) scans++;
        if (scans === 1 && offset > 0) cards[0].listId = 'done';
        const page = cards.slice(offset, offset + limit).map(card => ({ ...card }));
        return { offset, total: cards.length, cards: page } });
      process.stdout.write(JSON.stringify({ listId: result[0].listId, scans }))`)).toEqual({ listId: 'done', scans: 3 })
  })

  it('a board that keeps changing fails plainly after three scans', () => {
    const p = project()
    expect(collect(p, `let scans = 0; const cards = Array.from({ length: 5001 }, (_, i) => ({ id: String(i) }));
      try { await collectCompleteCards(async (offset, limit) => { if (offset === 0) scans++;
        return { offset, total: cards.length, cards: cards.slice(offset, offset + limit).map(card => ({ ...card, updatedAt: scans })) } }) }
      catch (error) { process.stdout.write(JSON.stringify({ scans, message: error.message })) }`)).toMatchObject({ scans: 3,
        message: expect.stringContaining('board kept changing over 3 scans') })
  })

  for (const field of ['updatedAt', 'description']) {
    it(`detects a changed ${field} across complete scans`, () => {
      const p = project()
      expect(collect(p, `let scans = 0; const field = ${JSON.stringify(field)};
        const source = Array.from({ length: 5001 }, (_, i) => ({ id: String(i), listId: 'next', updatedAt: 'old', description: 'old' }));
        const result = await collectCompleteCards(async (offset, limit) => { if (!offset) scans++;
          const cards = source.slice(offset, offset + limit).map(card => ({ ...card }));
          if (scans > 1 && !offset) cards[0][field] = 'new-value';
          return { offset, total: source.length, cards } });
        process.stdout.write(JSON.stringify({ value: result[0][field], scans }))`)).toEqual({ value: 'new-value', scans: 3 })
    })
  }
// Unrefreshable readings and detached refresh.
  it('the pure decision passes an explicitly unrefreshable reading', () => {
    const p = project()
    const result = run(`import { decide } from ${JSON.stringify(pathToFileURL(join(BIN, 'lib/actionability-core.mjs')).href)};
      process.stdout.write(JSON.stringify(decide({ snapshot: { status: 'missing' }, now: 1000,
        staleAfterMs: 1000, mandateKind: 'live', unrefreshable: true })))`, p)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ block: false, reason: 'snapshot-unrefreshable', nextConsecutiveBlocks: 0 })
  })
  it('an old failed reading passes three Stops with one diagnostic and remedy', () => {
    const p = project(); live(p); snapshot(p); failure(p)
    const messages: string[] = []
    for (let i = 0; i < 3; i++) {
      const result = stop(p)
      expect(result.hookSpecificOutput).toBeUndefined()
      if (result.systemMessage) messages.push(result.systemMessage)
    }
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('refresh-timeout')
    expect(messages[0]).toContain('wt-actionable-snapshot-refresh.mjs')
    const heartbeatAt = json(`${p.prefix}.project-state.json`).heartbeatAt
    expect(json(`${p.prefix}--test.session-state.json`).reportedFailureHeartbeatAt).toBe(heartbeatAt)
    failure(p, { heartbeatAt: heartbeatAt + 1 })
    expect(stop(p).systemMessage).toContain('refresh-timeout')
    expect(stop(p).systemMessage).toBeUndefined()
  })

  it.each(['absent', 'expired'])('an unrefreshable reading stays silent with an %s mandate', (kind) => {
    const p = project(); snapshot(p); failure(p)
    if (kind === 'expired') {
      live(p)
      const path = join(p.root, 'mandate', `engine-${p.cwd.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
      writeFileSync(path, JSON.stringify({ declaredAtMs: Date.now() - 24 * 60 * 60_000, sessionId: 'test' }))
    }
    expect(stop(p)).toEqual({})
    expect(existsSync(join(p.root, 'journal'))).toBe(false)
    live(p)
    expect(stop(p).systemMessage).toContain('refresh-timeout')
  })

  it('an unknown mandate reports a producer failure only once', () => {
    const p = project(); snapshot(p); failure(p); live(p)
    writeFileSync(join(p.root, 'mandate', `engine-${p.cwd.replace(/[^A-Za-z0-9-]/g, '-')}.json`), 'not json')
    expect(stop(p).systemMessage).toContain('refresh-timeout')
    expect(stop(p)).toEqual({})
  })

  it('diagnostic memory survives intervening actionable-work holds', () => {
    const p = project(); live(p); const oldAt = snapshot(p); failure(p)
    expect(stop(p).systemMessage).toContain('refresh-timeout')
    snapshot(p, Date.now() - 1000)
    expect(stop(p).hookSpecificOutput).toBeDefined()
    snapshot(p, oldAt)
    expect(stop(p)).toEqual({})
  })

  it('an unwritable diagnostic memory passes silently rather than repeating an unremembered failure', () => {
    const p = project(); live(p); snapshot(p); failure(p)
    mkdirSync(`${p.prefix}--test.session-state.json`)
    for (let i = 0; i < 3; i++) expect(stop(p)).toEqual({})
  })

  it('a missing snapshot with a recorded failure passes with a remedy', () => {
    const p = project(); live(p); failure(p)
    expect(stop(p)).toMatchObject({ systemMessage: expect.stringContaining('refresh-timeout') })
    expect(stop(p).hookSpecificOutput).toBeUndefined()
  })

  it('an abandoned reading past deadline passes with a diagnostic', () => {
    const p = project(); live(p); snapshot(p)
    failure(p, { lastOutcome: 'reading', lastReason: '', deadlineAt: Date.now() - 1 })
    expect(stop(p)).toMatchObject({ systemMessage: expect.stringContaining('read started and did not finish') })
  })

  it('a fresh snapshot still holds after a newer failed refresh', () => {
    const p = project(); live(p); snapshot(p, Date.now() - 1000); failure(p)
    expect(stop(p).hookSpecificOutput?.additionalContext).toContain('2 actionable item(s) remain')
  })

  it('superseded producer state is not reported as a failure', () => {
    const p = project(); live(p); snapshot(p); failure(p, { lastOutcome: 'superseded', lastReason: '' })
    const result = stop(p)
    expect(result.systemMessage).toBeUndefined()
    expect(result.hookSpecificOutput?.additionalContext).not.toContain('superseded')
  })

  it('launches once without a mandate and throttles the next Stop', async () => {
    const p = project(); snapshot(p); optIn(p); stub(p)
    stop(p)
    expect(existsSync(`${p.prefix}.auto-refresh.json`)).toBe(true)
    expect(json(`${p.prefix}.auto-refresh.json`).deadlineAt).toBeGreaterThan(Date.now())
    await expect.poll(() => existsSync(join(p.root, 'marker'))).toBe(true)
    stop(p)
    expect(readFileSync(join(p.root, 'marker'), 'utf8')).toBe(`${p.cwd}\n`)
  })

  it('without the opt-in field never launches', () => {
    const p = project(); snapshot(p); stub(p)
    stop(p)
    expect(existsSync(`${p.prefix}.auto-refresh.json`)).toBe(false)
    expect(existsSync(join(p.root, 'marker'))).toBe(false)
  })

  it('a fresh opted-in snapshot never launches', () => {
    const p = project(); snapshot(p, Date.now()); optIn(p); stub(p)
    stop(p)
    expect(existsSync(`${p.prefix}.auto-refresh.json`)).toBe(false)
  })

  it('throttles through the recorded deadline even after the age window elapsed', () => {
    const p = project(); optIn(p); stub(p)
    writeFileSync(`${p.prefix}.auto-refresh.json`, JSON.stringify({ launchedAt: Date.now() - 20 * 60_000,
      deadlineAt: Date.now() + 60_000 }))
    stop(p)
    expect(existsSync(join(p.root, 'marker'))).toBe(false)
    expect(json(`${p.prefix}.auto-refresh.json`).launchedAt).toBeLessThan(Date.now() - 10 * 60_000)
  })

  it('a nested Stop reads and refreshes the pointer-bearing ancestor', async () => {
    const p = project(); snapshot(p); optIn(p); stub(p)
    const nested = join(p.cwd, 'packages/app'); mkdirSync(nested, { recursive: true }); live(p, nested)
    expect(stop(p, nested).hookSpecificOutput?.additionalContext).toContain('2 actionable item(s) remain')
    expect(existsSync(`${p.prefix}.auto-refresh.json`)).toBe(true)
    await expect.poll(() => existsSync(join(p.root, 'marker'))).toBe(true)
    expect(readFileSync(join(p.root, 'marker'), 'utf8')).toBe(`${p.cwd}\n`)
  })

  it('missing refresh script records a launch failure and remains fail-open', () => {
    const p = project(); optIn(p)
    stub(p); rmSync(join(p.root, 'refresh-stub.mjs'))
    expect(stop(p).hookSpecificOutput).toBeUndefined()
    expect(json(`${p.prefix}.project-state.json`).lastReason).toBe('auto-refresh-launch-failed')
  })

  it('a failed launch-record write launches nothing and an old reading passes immediately', () => {
    const p = project(); optIn(p); live(p); snapshot(p); stub(p)
    mkdirSync(`${p.prefix}.auto-refresh.json`)
    const result = stop(p)
    expect(result.hookSpecificOutput).toBeUndefined()
    expect(result.systemMessage).toContain('auto-refresh-launch-failed')
    expect(existsSync(join(p.root, 'marker'))).toBe(false)
  })

  it('the parent exits before the detached child finishes', async () => {
    const p = project(); optIn(p)
    stub(p, `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(join(p.root, 'finished'))}, 'yes'), 700)`)
    stop(p)
    expect(existsSync(`${p.prefix}.auto-refresh.json`)).toBe(true)
    expect(existsSync(join(p.root, 'finished'))).toBe(false)
    await expect.poll(() => existsSync(join(p.root, 'finished')), { timeout: 30_000 }).toBe(true)
  })

  it('a child dying after reading is detected on its next Stop', async () => {
    const p = project(); optIn(p); live(p)
    stub(p, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(`${p.prefix}.project-state.json`)},
      JSON.stringify({ optedIn: true, heartbeatAt: Date.now(), lastOutcome: 'reading', deadlineAt: Date.now() - 1 })); process.exit(1)`)
    stop(p)
    await expect.poll(() => existsSync(`${p.prefix}.project-state.json`)).toBe(true)
    const result = stop(p)
    expect(result.hookSpecificOutput).toBeUndefined()
    expect(result.systemMessage).toContain('read started and did not finish')
  })

  it('a detached child exiting before its heartbeat passes Stop after the launch deadline', () => {
    const p = project(); optIn(p); live(p); snapshot(p)
    const at = Date.now() - 1000
    failure(p, { heartbeatAt: at, lastOutcome: 'snapshot-written', lastReason: '' })
    stub(p, 'process.exit(1)')
    expect(stop(p).hookSpecificOutput).toBeDefined()
    const launch = json(`${p.prefix}.auto-refresh.json`)
    const clock = join(p.root, 'after-launch-deadline.mjs')
    writeFileSync(clock, `Date.now = () => ${launch.deadlineAt + 1}`)
    Object.assign(p.env, { NODE_OPTIONS: `--import=${pathToFileURL(clock).href}` })
    const result = stop(p)
    expect(result.hookSpecificOutput).toBeUndefined()
    expect(result.systemMessage).toContain('read started and did not finish')
    expect(stop(p)).toEqual({})
    expect(json(`${p.prefix}.project-state.json`).heartbeatAt).toBe(at)
  })

  it.each(['absent', 'older', 'equal', 'newer'])('expired launch checks the %s producer heartbeat', (kind) => {
    const p = project(); live(p); snapshot(p)
    const launchedAt = Date.now() - 1000
    if (kind !== 'absent') failure(p, { heartbeatAt: launchedAt + (kind === 'older' ? -1 : kind === 'newer' ? 1 : 0),
      lastOutcome: 'snapshot-written', lastReason: '' })
    writeFileSync(`${p.prefix}.auto-refresh.json`, JSON.stringify({ launchedAt, deadlineAt: launchedAt + 1 }))
    const result = stop(p)
    if (kind === 'absent' || kind === 'older') {
      expect(result.hookSpecificOutput).toBeUndefined()
      expect(result.systemMessage).toContain('read started and did not finish')
    } else expect(result.hookSpecificOutput).toBeDefined()
  })

  it('a block journals producer reason, age, and auto-refresh status', () => {
    const p = project(); live(p); snapshot(p, Date.now() - 1000); failure(p)
    Object.assign(p.env, { WT_GUARD_JOURNAL_DIR: join(p.root, 'journal') })
    stop(p)
    const path = join(p.root, 'journal', readdirSync(join(p.root, 'journal'))[0]!)
    const entry = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(entry.evidence).toMatchObject({ producerReason: 'refresh-timeout', autoRefresh: 'off' })
    expect(Number(entry.evidence.snapshotAgeMs)).toBeGreaterThanOrEqual(1000)
  })

  for (const mode of ['fresh', 'launched', 'throttled', 'failed']) {
    it(`journals auto-refresh status ${mode}`, async () => {
      const p = project(); live(p); optIn(p); stub(p)
      snapshot(p, Date.now() - (mode === 'fresh' ? 1000 : 20 * 60_000))
      if (mode === 'failed') rmSync(join(p.root, 'refresh-stub.mjs'))
      if (mode === 'throttled') writeFileSync(`${p.prefix}.auto-refresh.json`, JSON.stringify({ launchedAt: Date.now(), deadlineAt: Date.now() + 90_000 }))
      Object.assign(p.env, { WT_GUARD_JOURNAL_DIR: join(p.root, 'journal') })
      stop(p)
      const path = join(p.root, 'journal', readdirSync(join(p.root, 'journal'))[0]!)
      const entry = JSON.parse(readFileSync(path, 'utf8').trim())
      expect(entry.evidence.autoRefresh).toBe(mode)
      if (mode === 'launched') await expect.poll(() => existsSync(join(p.root, 'marker'))).toBe(true)
    })
  }
// Refresh deadline CLI.
  it('a deadline crossed after publication exits one with a published-snapshot diagnostic', () => {
    const p = project()
    const preload = join(p.root, 'late-publication.mjs')
    writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      let now = 100000; Date.now = () => now; const rename = fs.renameSync;
      fs.renameSync = (from, to) => { const result = rename(from, to);
        if (to === ${JSON.stringify(`${p.prefix}.project-state.json`)} &&
          JSON.parse(fs.readFileSync(to, 'utf8')).lastOutcome === 'snapshot-written') now += 2000;
        return result }; syncBuiltinESMExports();
      globalThis.fetch = async (_url, options) => { const body = JSON.parse(options.body);
        const result = body.method === 'tools/call'
          ? { content: [{ type: 'text', text: JSON.stringify({ offset: 0, total: 0, cards: [] }) }] } : {};
        return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) } }`)
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, REFRESH, '--timeout-s', '1'],
      { cwd: p.cwd, env: p.env, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toBe('Actionability snapshot refresh finished in 2.00 s, past its 1 s bound (snapshot was published)')
    expect(json(`${p.prefix}.json`)).toMatchObject({ at: 100000, actionable: 0 })
    expect(json(`${p.prefix}.project-state.json`).lastOutcome).toBe('snapshot-written')
  })

  it('uses the default 90 second bound, records reading before requests, and prints elapsed time', () => {
    const p = project()
    const preload = join(p.root, 'fake-endpoint.mjs')
    writeFileSync(preload, `import { readFileSync } from 'node:fs'; globalThis.fetch = async (_url, options) => {
      const state = JSON.parse(readFileSync(${JSON.stringify(`${p.prefix}.project-state.json`)}, 'utf8'));
      if (state.lastOutcome !== 'reading' || state.deadlineAt - state.heartbeatAt > 90000 || state.deadlineAt - state.heartbeatAt < 89000) throw new Error('reading deadline missing');
      const body = JSON.parse(options.body); const result = body.method === 'tools/call'
        ? { content: [{ type: 'text', text: JSON.stringify({ offset: 0, total: 0, cards: [] }) }] } : {};
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) } }`)
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, REFRESH], { cwd: p.cwd,
      env: { ...p.env, WT_ACTIONABLE_REFRESH_TIMEOUT_MS: undefined }, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/from 0 cards in \d+\.\d{2} s\./)
  })

  it('an environment deadline aborts a body that never completes', () => {
    const p = project()
    const preload = join(p.root, 'fake-body.mjs')
    writeFileSync(preload, `globalThis.fetch = async (_url, options) => ({ ok: true, headers: { get: () => null },
      text: () => new Promise((_resolve, reject) => { const keepAlive = setInterval(() => {}, 100);
        options.signal.addEventListener('abort', () => { clearInterval(keepAlive); reject(options.signal.reason) }, { once: true }) }) })`)
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, REFRESH], { cwd: p.cwd,
      env: { ...p.env, WT_ACTIONABLE_REFRESH_TIMEOUT_MS: '100' }, encoding: 'utf8', timeout: 2200 })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('did not finish within 0.1 s (board acquisition)')
    expect(json(`${p.prefix}.project-state.json`).lastReason).toBe('refresh-timeout')
  })
  it('a fake endpoint that never answers exits within its bound with plain failure and state', async () => {
    const p = project()
    const server = createServer(() => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')
    const started = Date.now()
    try {
      const child = spawn(process.execPath, [REFRESH, '--timeout-s', '0.2'], { cwd: p.cwd,
        env: { ...p.env, BOARD_LIST_MCP_URL: `http://127.0.0.1:${address.port}/mcp` } })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      expect(code).toBe(1)
      expect(stderr).toContain('Actionability snapshot refresh did not finish within 0.2 s (board acquisition)')
      expect(Date.now() - started).toBeLessThan(2200)
      expect(json(`${p.prefix}.project-state.json`)).toMatchObject({ lastOutcome: 'unavailable', lastReason: 'refresh-timeout' })
      expect(readFileSync(join(p.state, 'actionable-producer-journal.jsonl'), 'utf8')).toContain('refresh-timeout')
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it('pointer failures are recorded even before acquisition begins', () => {
    const p = project()
    writeFileSync(join(p.cwd, '.claude/planka.json'), '{}')
    const result = spawnSync(process.execPath, [REFRESH], { cwd: p.cwd, env: p.env, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(existsSync(`${p.prefix}.project-state.json`)).toBe(true)
    expect(json(`${p.prefix}.project-state.json`).lastReason).toBe('board-pointer-unreadable')
    live(p)
    const message = stop(p).systemMessage
    expect(message).toContain('Fix .claude/planka.json')
    expect(message).not.toContain('endpoint answered')
  })
// Documentation contract.
  it('documents the bound, opt-in, and non-blocking failure policy', () => {
    const issues = readFileSync(join(ROOT, 'docs/public/known-issues.md'), 'utf8')
    expect(issues).toContain('actionableAutoRefresh')
    expect(issues).toContain('WT_ACTIONABLE_REFRESH_TIMEOUT_MS')
    expect(issues).toContain('unrefreshable reading passes')
    expect(readFileSync(join(ROOT, 'plugin/CHANGELOG.md'), 'utf8')).toContain('5000-card')
  })

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createBoardClient, resolveBoardPointer } from '../../../../plugin/bin/lib/board-http-client.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { removeLifecycleWorktree } from '../../../../plugin/bin/lib/lifecycle-report-edge.mjs'

const cli = fileURLToPath(new URL('../../../../plugin/bin/wt-worktree-remove.mjs', import.meta.url))
const orchestrator = fileURLToPath(new URL('../../../../plugin/bin/wt-run-orchestrator.mjs', import.meta.url))
const noHandEdit = /edit|correct expiry\.boardId|record the board id in the retention marker/i
let container: string
let project: string
let config: string
let worktree: string
let calls: string[]
let cardCalls: string[]
let card: { id: string, listId: string, boardId?: string } | null
let server: ReturnType<typeof createServer>

function git(...args: string[]) {
  const result = spawnSync('git', args, { cwd: project, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
}

function addWorktree(name: string, boardId: string | null = null) {
  const target = join(container, 'trees', name)
  git('worktree', 'add', '-q', '-b', name, target)
  mkdirSync(join(target, '.lane'))
  writeFileSync(join(target, '.lane', 'worktree-retention.json'), JSON.stringify({
    version: 1, cardId: 'card', worktree: realpathSync(target), retainedAt: '2026-09-17T10:00:00.000Z',
    reason: 'bounded lifecycle spent', phase: 'critic',
    expiry: { boardId, removeWhen: 'card is absent or in Done or NotDoing' },
  }))
  return target
}

function pointer(dir: string, value: unknown) {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'planka.json'), JSON.stringify({ boardId: value }))
}

function replaceMarker(target: string, change: (marker: { cardId: string, expiry: { boardId: string | null } }) => void) {
  const file = join(target, '.lane', 'worktree-retention.json')
  const marker = JSON.parse(readFileSync(file, 'utf8'))
  change(marker)
  writeFileSync(`${file}.tmp`, JSON.stringify(marker))
  renameSync(`${file}.tmp`, file)
}

function run(target = worktree, args: string[] = [], cwd = container) {
  return new Promise<{ code: number | null, stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [cli, '--dir', target, '--force', ...args], {
      cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: config, WT_PLANKA_MCP_URL: '' },
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => done({ code, stderr }))
  })
}

beforeEach(async () => {
  container = mkdtempSync(join(tmpdir(), 'wt-remove-board-'))
  // Every no-pointer case assumes nothing above the temporary directory carries a board pointer.
  expect(resolveBoardPointer(realpathSync(container))).toBeNull()
  project = join(container, 'repo'); config = join(container, 'config')
  mkdirSync(project); mkdirSync(config); mkdirSync(join(container, 'trees'))
  writeFileSync(join(project, 'tracked'), 'base\n')
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Board Test')
  git('config', 'commit.gpgSign', 'false'); git('add', '-A'); git('commit', '-qm', 'base')
  worktree = addWorktree('first')
  card = { id: 'card', listId: 'done', boardId: 'B1' }
  calls = []
  cardCalls = []
  server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const rpc = JSON.parse(body) as { id?: number, method: string, params?: { name: string, arguments: { boardId?: string } } }
      let value: unknown = {}
      if (rpc.method === 'tools/call') {
        const name = rpc.params?.name
        if (name === 'get_card') { cardCalls.push('card'); value = card }
        if (name === 'get_board') {
          const id = rpc.params?.arguments.boardId ?? ''
          calls.push(id)
          value = { lists: id === 'B1' ? [{ id: 'done', name: 'Done' }, { id: 'open', name: 'In Progress' }] : [] }
        }
        value = { content: [{ type: 'text', text: JSON.stringify(value) }] }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result: value }))
    })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture has no port')
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'workflow-toolbox@test': { options: { planka_mcp_url: `http://127.0.0.1:${address.port}/mcp` } } } }))
})

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()))
  rmSync(container, { recursive: true, force: true })
})

describe('retained worktree board resolution', () => {
  it('A: refuses a null marker without a board, naming the usable flag before any board call', async () => {
    const result = await run()
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/records no board id.*rerun with --board-id/)
    expect(existsSync(worktree)).toBe(true)
    expect(calls).toEqual([])
    expect(cardCalls).toEqual([])
  })

  it('B: resolves a null marker from --board-id', async () => {
    const result = await run(worktree, ['--board-id', 'B1'])
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(worktree)).toBe(false)
    expect(calls).toEqual(['B1'])
  })

  it('C: resolves a pointer above the worktree when cwd has none', async () => {
    pointer(join(container, 'trees'), 'B1')
    const result = await run()
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(worktree)).toBe(false)
    expect(calls).toEqual(['B1'])
  })

  it('C2: resolves a pointer above cwd when the worktree has none', async () => {
    const cwd = join(container, 'invocation'); mkdirSync(cwd); pointer(cwd, 'B1')
    const result = await run(worktree, [], cwd)
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(worktree)).toBe(false)
    expect(calls).toEqual(['B1'])
  })

  it('D: refuses a flag that conflicts with a marker board before board calls', async () => {
    worktree = addWorktree('conflict', 'B1')
    const result = await run(worktree, ['--board-id', 'B2'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/retention marker .* for card card names board B1; --board-id B2 disagrees; omit --board-id or pass --board-id B1/)
    expect(existsSync(worktree)).toBe(true)
    expect(calls).toEqual([])
    expect(cardCalls).toEqual([])
  })

  it('E: a flag cannot bypass an open card', async () => {
    card = { id: 'card', listId: 'open', boardId: 'B1' }
    const result = await run(worktree, ['--board-id', 'B1'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/open card card in list In Progress/)
    expect(result.stderr).toMatch(/the worktree is retained until card card is in Done or NotDoing, then rerun/)
    expect(result.stderr).not.toMatch(noHandEdit)
    expect(existsSync(worktree)).toBe(true)
    expect(calls).toEqual(['B1'])
    expect(cardCalls).toEqual(['card'])
  })

  it('F: a wrong flag cannot use a card on another board', async () => {
    const result = await run(worktree, ['--board-id', 'WRONG'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/card card belongs to board B1, not WRONG; rerun with --board-id B1/)
    expect(existsSync(worktree)).toBe(true)
    expect(calls).toEqual([])
    expect(cardCalls).toEqual(['card'])
  })

  it('G: refuses a terminal card on another board even if its list name resolves', async () => {
    card = { id: 'card', listId: 'done', boardId: 'B2' }
    const result = await run(worktree, ['--board-id', 'B1'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/card card belongs to board B2, not B1; rerun with --board-id B2/)
    expect(existsSync(worktree)).toBe(true)
    expect(calls).toEqual([])
    expect(cardCalls).toEqual(['card'])
  })

  it('H: a marker board remains authoritative when the card omits boardId', async () => {
    worktree = addWorktree('authoritative', 'B1')
    card = { id: 'card', listId: 'done' }
    const result = await run()
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(worktree)).toBe(false)
    expect(calls).toEqual(['B1'])
  })

  it('I: refuses an unprovable terminal card when the board came from a flag', async () => {
    card = { id: 'card', listId: 'done' }
    const result = await run(worktree, ['--board-id', 'B1'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/card card: the board response carries no boardId, so the card cannot be proven to be on board B1; rerun once the board server returns boardId/)
    expect(result.stderr).not.toMatch(noHandEdit)
    expect(existsSync(worktree)).toBe(true)
    expect(calls).toEqual([])
    expect(cardCalls).toEqual(['card'])
  })

  it('I2: refuses an unprovable terminal card when the board came from a pointer', async () => {
    pointer(join(container, 'trees'), 'B1')
    card = { id: 'card', listId: 'done' }
    const result = await run()
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/card card: the board response carries no boardId/)
    expect(result.stderr).toMatch(/rerun once the board server returns boardId/)
    expect(result.stderr).not.toMatch(noHandEdit)
    expect(existsSync(worktree)).toBe(true)
    expect(calls).toEqual([])
    expect(cardCalls).toEqual(['card'])
  })

  it('J: a marker board contradicted by the card names the marker correction', async () => {
    worktree = addWorktree('contradicted', 'B1')
    card = { id: 'card', listId: 'done', boardId: 'B2' }
    const result = await run()
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/the retention marker records board B1 but the card is on board B2, so the retention stands until the owner resolves the mismatch/)
    expect(result.stderr).not.toMatch(noHandEdit)
    expect(existsSync(worktree)).toBe(true)
    expect(calls).toEqual([])
  })

  it('K: a marker-sourced board adapter without a boardId property keeps its removal contract', async () => {
    worktree = addWorktree('adapter', 'B1')
    const removed: string[] = []
    const adapter = { getCard: async () => ({ id: 'card', boardId: 'B1', listName: 'Done' }), listNameOf: async () => null }
    const result = await removeLifecycleWorktree({ root: worktree, board: adapter, git: (_command: string, args: string[]) => {
      if (args.includes('--git-common-dir')) return join(project, '.git')
      removed.push(args.join(' ')); return ''
    } })
    expect(result).toMatchObject({ removed: true, expired: true, cardId: 'card' })
    expect(removed).toHaveLength(1)
  })

  it('K2: a marker-sourced adapter without a boardId property still refuses a card on another board', async () => {
    worktree = addWorktree('adapter-foreign', 'B1')
    const adapter = { getCard: async () => ({ id: 'card', boardId: 'B2', listName: 'Done' }), listNameOf: async () => null }
    await expect(removeLifecycleWorktree({ root: worktree, board: adapter, git: () => { throw new Error('must not remove') } }))
      .rejects.toThrow(/the retention marker records board B1 but the card is on board B2, so the retention stands until the owner resolves the mismatch/)
    expect(existsSync(worktree)).toBe(true)
  })

  it('refuses an adapter board that contradicts the recorded marker before getCard', async () => {
    worktree = addWorktree('adapter-conflict', 'B1')
    const board = { boardId: 'B2', getCard: async () => { throw new Error('must not be called') } }
    await expect(removeLifecycleWorktree({ root: worktree, board, git: () => { throw new Error('git must not run') } }))
      .rejects.toThrow(/retention marker .* for card card records board B1.*adapter board B2/)
    expect(existsSync(worktree)).toBe(true)
  })

  it('L: an unreachable board names how to recover', async () => {
    worktree = addWorktree('unreachable', 'B1')
    const adapter = { getCard: async () => { throw new Error('network down') }, listNameOf: async () => null }
    await expect(removeLifecycleWorktree({ root: worktree, board: adapter, git: () => { throw new Error('must not remove') } }))
      .rejects.toThrow(/board unavailable \(network down\); restore access to the board \(the planka_mcp_url plugin option\) and rerun/)
    await expect(removeLifecycleWorktree({ root: worktree, board: null, git: () => { throw new Error('must not remove') } }))
      .rejects.toThrow(/retention expiry cannot be verified; restore access to the board/)
    expect(existsSync(worktree)).toBe(true)
  })

  it('treats whitespace marker boardId as missing', async () => {
    worktree = addWorktree('blank', '   ')
    const result = await run(worktree, ['--board-id', 'B1'])
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(worktree)).toBe(false)
    expect(calls).toEqual(['B1'])
  })

  it('names the nearest unusable pointer and refuses without board calls', async () => {
    pointer(join(container, 'trees'), 123)
    pointer(container, 'B1')
    const result = await run()
    expect(result.code).toBe(1)
    const named = /; (.+?) has no usable boardId/.exec(result.stderr)?.[1]
    expect(named && realpathSync(named)).toBe(realpathSync(join(container, 'trees', '.claude', 'planka.json')))
    expect(result.stderr).toMatch(/rerun with --board-id <board id>/)
    expect(existsSync(worktree)).toBe(true)
    expect(calls).toEqual([])
    expect(cardCalls).toEqual([])
  })

  it('walks the real target ancestry, not a symlink alias ancestry', async () => {
    pointer(join(container, 'trees'), 'B1')
    const aliasParent = join(container, 'alias-parent'); mkdirSync(aliasParent); pointer(aliasParent, 'B2')
    const alias = join(aliasParent, 'alias'); symlinkSync(worktree, alias, 'junction')
    const result = await run(alias)
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(worktree)).toBe(false)
    expect(calls).toEqual(['B1'])
  })

  it('still expires a globally absent card with a resolved board', async () => {
    worktree = addWorktree('absent', 'B1')
    card = null
    const result = await run()
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(worktree)).toBe(false)
    expect(calls).toEqual([])
  })

  it.each(['--board-id', 'pointer'])('refuses absent card when board comes from %s', async (source) => {
    card = null
    if (source === 'pointer') pointer(join(container, 'trees'), 'B1')
    const result = await run(worktree, source === 'pointer' ? [] : ['--board-id', 'B1'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/absence cannot be proven on board B1.*retention stands until the owner removes the worktree/)
    expect(result.stderr).not.toMatch(noHandEdit)
    expect(existsSync(worktree)).toBe(true)
  })

  it.each(['cardId', 'boardId'])('refuses a changed marker %s before git', async (field) => {
    const marker = {
      cardId: field === 'cardId' ? 'old-card' : 'card',
      expiry: { boardId: field === 'boardId' ? 'B2' : null },
    }
    await expect(removeLifecycleWorktree({ root: worktree, marker, board: { boardId: 'B1', getCard: async () => null }, git: () => { throw new Error('git must not run') } }))
      .rejects.toThrow(/retention marker .* changed while removal was being decided \(card .*\/board .*, now card .*\/board .*\); rerun/)
    expect(existsSync(worktree)).toBe(true)
  })

  it.each(['cardId', 'boardId', 'deleted'])('refuses a marker %s changed during getCard before any git call', async (field) => {
    worktree = addWorktree(`during-card-${field}`, 'B1')
    const board = { boardId: 'B1', getCard: async () => {
      if (field === 'deleted') rmSync(join(worktree, '.lane', 'worktree-retention.json'))
      else replaceMarker(worktree, (marker) => {
        if (field === 'cardId') marker.cardId = 'other-card'
        else marker.expiry.boardId = 'B2'
      })
      return { id: 'card', boardId: 'B1', listName: 'Done' }
    } }
    await expect(removeLifecycleWorktree({ root: worktree, board, git: () => { throw new Error('git must not run') } }))
      .rejects.toThrow(/retention marker .* changed while removal was being decided/)
    expect(existsSync(worktree)).toBe(true)
  })

  it('refuses a marker appearing before worktree remove', async () => {
    rmSync(join(worktree, '.lane', 'worktree-retention.json'))
    let calls = 0
    await expect(removeLifecycleWorktree({ root: worktree, git: (_command: string, args: string[]) => {
      calls += 1
      if (args.includes('--git-common-dir')) {
        writeFileSync(join(worktree, '.lane', 'worktree-retention.json'), JSON.stringify({
          version: 1, cardId: 'card', worktree: realpathSync(worktree), retainedAt: 'now', reason: 'bounded', phase: 'critic',
          expiry: { boardId: 'B1', removeWhen: 'card is absent or in Done or NotDoing' },
        }))
        return join(project, '.git')
      }
      throw new Error('git worktree remove must not run')
    } })).rejects.toThrow(/retention marker .* changed while removal was being decided/)
    expect(calls).toBe(1)
  })

  it('derives marker board provenance when an API caller omits it or asserts it incorrectly', async () => {
    const board = { boardId: 'B1', getCard: async () => ({ id: 'card', listName: 'Done' }) }
    for (const boardIdFromMarker of [undefined, true]) {
      await expect(removeLifecycleWorktree({ root: worktree, board, boardIdFromMarker, git: () => { throw new Error('git must not run') } }))
        .rejects.toThrow(/card cannot be proven to be on board B1; rerun once the board server returns boardId/)
    }
    expect(existsSync(worktree)).toBe(true)
  })

  it('prefers the worktree pointer over a conflicting pointer above cwd', async () => {
    const cwd = join(container, 'invocation'); mkdirSync(cwd)
    pointer(join(container, 'trees'), 'B1'); pointer(cwd, 'B2')
    const result = await run(worktree, [], cwd)
    expect(result.code, result.stderr).toBe(0)
    expect(calls).toEqual(['B1'])
  })

  it('refuses a foreign marker before requiring a board flag', async () => {
    const foreign = addWorktree('foreign')
    const markerFile = join(worktree, '.lane', 'worktree-retention.json')
    const marker = JSON.parse(readFileSync(markerFile, 'utf8'))
    marker.worktree = realpathSync(foreign)
    writeFileSync(markerFile, JSON.stringify(marker))
    const result = await run()
    expect(result.code).toBe(1)
    const named = /names worktree (.+?), not removal target (.+?); rerun with --dir (.+?) to release that worktree, or remove this worktree once the owner confirms the marker was copied/.exec(result.stderr)
    expect(named).not.toBeNull()
    expect(realpathSync(named![1]!)).toBe(realpathSync(foreign))
    expect(realpathSync(named![2]!)).toBe(realpathSync(worktree))
    expect(realpathSync(named![3]!)).toBe(realpathSync(foreign))
    expect(result.stderr).not.toMatch(noHandEdit)
    expect(existsSync(worktree)).toBe(true)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses an unsearchable nearest pointer instead of falling back', () => {
    const lower = join(container, 'trees', '.claude')
    pointer(join(container, 'trees'), 'B2'); pointer(container, 'B1')
    chmodSync(lower, 0)
    try {
      const resolved = resolveBoardPointer(worktree)
      expect(resolved?.boardId).toBeNull()
      // realpath of the inaccessible file is available from its parent once permissions are restored.
      chmodSync(lower, 0o700)
      expect(realpathSync(resolved!.path)).toBe(realpathSync(join(lower, 'planka.json')))
    } finally { chmodSync(lower, 0o700) }
  })

  it.each(['malformed', 'missing-fields'])('invalid %s marker names owner inspection as remedy', async (kind) => {
    writeFileSync(join(worktree, '.lane', 'worktree-retention.json'), kind === 'malformed' ? '{' : JSON.stringify({ version: 0, cardId: 'card' }))
    const result = await run()
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/the marker is not a version-1 retention marker, so the retention stands until the owner inspects /)
    expect(result.stderr).not.toMatch(noHandEdit)
    expect(existsSync(worktree)).toBe(true)
  })

  it('board client lazily rejects with the pointer reason, retaining the default message otherwise', async () => {
    const pointerPath = join(container, '.claude', 'planka.json')
    const reason = `${pointerPath} has no usable boardId (it must be a non-empty string); fix the pointer or pass --board-id <id>`
    const request = async () => { throw new Error('fetch must not run') }
    await expect(createBoardClient({ url: 'unused', boardId: null, boardIdMissingReason: reason, fetch: request }).getCard('card'))
      .rejects.toThrow(reason)
    await expect(createBoardClient({ url: 'unused', boardId: null, fetch: request }).getCard('card'))
      .rejects.toThrow('boardId is required (--board-id or .claude/planka.json)')
  })

  it('orchestrator routes an unusable pointer through the board client and runner', () => {
    const source = readFileSync(orchestrator, 'utf8')
    expect(source).not.toMatch(/if\s*\(pointer\s*&&\s*!pointer\.boardId\)\s*\{[^}]*return 1/s)
    expect(source).toMatch(/createBoardClient\(\{[^}]*boardIdMissingReason/s)
  })

  it('requires a value for --board-id', async () => {
    const result = await run(worktree, ['--board-id'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/--board-id requires a value/)
    expect(result.stderr).toMatch(/Usage: node wt-worktree-remove\.mjs --dir/)
    expect(existsSync(worktree)).toBe(true)
    expect(calls).toEqual([])
    expect(cardCalls).toEqual([])
  })
})

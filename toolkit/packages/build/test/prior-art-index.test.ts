import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PRODUCER_HOOK = join(REPO_ROOT, 'plugin/bin/wt-actionable-snapshot-producer-hook.mjs')
const CORE = join(REPO_ROOT, 'plugin/bin/lib/prior-art-index-core.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function slug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}

function scaffoldProject(tag: string, opts: { withBoardPointer?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `wt-prior-art-index-${tag}-`))
  roots.push(root)
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
  return {
    cwd,
    priorArtDir: join(state, 'wt-prior-art'),
    env: { ...process.env, CLAUDE_CONFIG_DIR: undefined, CLAUDE_PLUGIN_DATA: undefined, HOME: home, XDG_STATE_HOME: state },
  }
}

function runProducerHook(payload: unknown, env: NodeJS.ProcessEnv) {
  const res = spawnSync(process.execPath, [PRODUCER_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env })
  return { status: res.status, stderr: (res.stderr ?? '').trim() }
}

function boardResponse(lists: Array<{ name: string; cards: Array<{ id: string; name: string; description?: string; position?: number }> }>) {
  return { content: [{ type: 'text', text: JSON.stringify({ id: 'board-1', lists }) }] }
}

function readIndex(priorArtDir: string, cwd: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(priorArtDir, `${slug(cwd)}.json`), 'utf8'))
  } catch {
    return null
  }
}

describe('prior-art-index-core', () => {
  it('buildCardIndex: keeps only id/name/listName, records the true scanned count', () => {
    const script = [
      `import { buildCardIndex } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `const r = buildCardIndex([{id:'1', name:'A', listName:'Next', description:'secret', position: 0}], 5000)`,
      'process.stdout.write(JSON.stringify(r))',
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    const r = JSON.parse(res.stdout)
    expect(r.at).toBe(5000)
    expect(r.scanned).toBe(1)
    expect(r.truncated).toBe(false)
    expect(r.cards).toEqual([{ id: '1', name: 'A', listName: 'Next' }])
    expect(r.cards[0].description).toBeUndefined()
  })

  it('buildCardIndex: caps at MAX_CARDS and marks truncated', () => {
    const script = [
      `import { buildCardIndex, MAX_CARDS } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `const cards = Array.from({length: MAX_CARDS + 10}, (_, i) => ({id: String(i), name: 'c'+i, listName: 'Backlog'}))`,
      `const r = buildCardIndex(cards, 1)`,
      `process.stdout.write(JSON.stringify({ scanned: r.scanned, truncated: r.truncated, kept: r.cards.length, cap: r.cap }))`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    const r = JSON.parse(res.stdout)
    expect(r.scanned).toBe(510)
    expect(r.truncated).toBe(true)
    expect(r.kept).toBe(r.cap)
  })

  it('buildCardIndex: an empty card list is a legitimate empty index, not a degraded one', () => {
    const script = [
      `import { buildCardIndex } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `process.stdout.write(JSON.stringify(buildCardIndex([], 1)))`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    const r = JSON.parse(res.stdout)
    expect(r.scanned).toBe(0)
    expect(r.cards).toEqual([])
  })
})

describe('wt-actionable-snapshot-producer-hook — prior-art index side effect (integration)', () => {
  it('a successful board read writes the title index, independent of the depends-on parser', () => {
    // Deliberately NO depends-on parser scaffolded (withParser is not even an option here) — the
    // point of this test is that the title index does not need it, unlike the actionability
    // snapshot the SAME hook also computes.
    const project = scaffoldProject('success')
    const result = runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([
        { name: 'Backlog', cards: [{ id: '1837209261243893380', name: 'Prove it: run a fully-scripted pipeline', position: 0 }] },
        { name: 'Done', cards: [{ id: '2', name: 'Some finished thing', position: 0 }] },
      ]),
      cwd: project.cwd,
    }, project.env)
    expect(result.status).toBe(0)
    const index = readIndex(project.priorArtDir, project.cwd)
    expect(index).not.toBeNull()
    expect((index!.cards as Array<{ id: string }>).map((c) => c.id)).toEqual(['1837209261243893380', '2'])
  })

  it('a partial/unreadable read writes NEITHER the snapshot nor the title index, and leaves an existing index untouched', () => {
    const project = scaffoldProject('partial')
    // First, a real successful read to plant a genuine index.
    runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([{ name: 'Next', cards: [{ id: '1', name: 'Good card', position: 0 }] }]),
      cwd: project.cwd,
    }, project.env)
    const before = readIndex(project.priorArtDir, project.cwd)
    expect(before).not.toBeNull()

    // Then a FILTERED find_cards call — extraction fails, must not touch the index.
    runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: { list: 'Next' },
      tool_response: { content: [{ type: 'text', text: JSON.stringify([{ id: '99', name: 'should never appear', listName: 'Next' }]) }] },
      cwd: project.cwd,
    }, project.env)
    const after = readIndex(project.priorArtDir, project.cwd)
    expect(after).toEqual(before)
  })

  it('no tool_response at all (no board payload available) writes no index — degrades honestly', () => {
    const project = scaffoldProject('no-payload')
    runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__find_cards',
      tool_input: {},
      cwd: project.cwd,
    }, project.env)
    expect(readIndex(project.priorArtDir, project.cwd)).toBeNull()
  })

  it('the title index is written on a successful read EVEN WITHOUT a board pointer file — it needs only extraction, not the Depends-on convention', () => {
    const project = scaffoldProject('no-board-pointer', { withBoardPointer: false })
    runProducerHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__planka__get_board',
      tool_input: { boardId: 'b1' },
      tool_response: boardResponse([{ name: 'Next', cards: [{ id: '1', name: 'Card without a board pointer', position: 0 }] }]),
      cwd: project.cwd,
    }, project.env)
    const index = readIndex(project.priorArtDir, project.cwd)
    expect(index).not.toBeNull()
    expect((index!.cards as Array<{ id: string }>).map((c) => c.id)).toEqual(['1'])
  })
})

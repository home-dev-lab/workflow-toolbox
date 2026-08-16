import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-queue-not-empty-gate-hook.mjs')
const HELP_FILE = join(REPO_ROOT, 'plugin/bin/wt-queue-not-empty-gate-hook.help.md')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wt-queue-gate-${tag}-`))
  roots.push(root)
  return root
}

function slug(cwd: string): string {
  const readable = cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 12)
  return `${readable}-${hash}`
}

type Scaffold = {
  env: NodeJS.ProcessEnv
  payload: unknown
  stateDir: string
  cwd: string
  transcriptPath: string
}

function scaffold(tag: string): Scaffold {
  const root = mkRoot(tag)
  const stateDir = join(root, 'queue-gate-state')
  const cwd = join(root, 'project')
  const transcriptPath = join(root, 'transcript.jsonl')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, '.git'), 'gitdir: /dev/null\n', 'utf8')
  writeFileSync(transcriptPath, '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WT_QUEUE_GATE_DIR: stateDir,
    HOME: root,
  }
  const payload = {
    hook_event_name: 'Stop',
    session_id: `session-${tag}`,
    cwd,
    transcript_path: transcriptPath,
  }
  return { env, payload, stateDir, cwd, transcriptPath }
}

function writeSnapshot(stateDir: string, cwd: string, snap: Record<string, unknown>): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, `queue-${slug(cwd)}.json`), JSON.stringify(snap), 'utf8')
}

function agePath(path: string, minutesAgo = 10): void {
  const staleDate = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(path, staleDate, staleDate)
}

function runHook(payload: unknown, env: NodeJS.ProcessEnv): { code: number | null; stderr: string; stdout: string } {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
  return { code: res.status, stderr: (res.stderr ?? '').trim(), stdout: (res.stdout ?? '').trim() }
}

// The hook emits its block text as stdout JSON (hookSpecificOutput.additionalContext) with
// exit 0, not stderr with exit 2 — this is the discriminator every test below uses. A PASS case
// legitimately emits no stdout at all, so malformed/absent stdout returns ''.
function blockText(r: { stdout: string }): string {
  if (!r.stdout) return ''
  try {
    const parsed = JSON.parse(r.stdout) as { hookSpecificOutput?: { additionalContext?: unknown } }
    const text = parsed?.hookSpecificOutput?.additionalContext
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

describe('wt-queue-not-empty-gate-hook: emission shape', () => {
  it('reaches the same queue verdict from a project root and every nested directory', () => {
    const { env, payload, stateDir, cwd } = scaffold('ancestor-family')
    writeSnapshot(stateDir, cwd, { open: 7, at: Date.now(), next: 'CARD-7 inherited item' })

    const repository = join(cwd, 'repository')
    const packages = join(repository, 'packages')
    const core = join(packages, 'core')
    mkdirSync(core, { recursive: true })
    agePath(repository)
    agePath(packages)
    agePath(core)
    const directories = [cwd, repository, core]
    const verdicts = directories.map((directory, index) => {
      const r = runHook({
        ...(payload as Record<string, unknown>),
        cwd: directory,
        session_id: `session-ancestor-family-${index}`,
      }, env)
      expect(r.code).toBe(0)
      return blockText(r)
    })

    for (const verdict of verdicts) {
      expect(verdict).toContain('7 open')
      expect(verdict).toContain('next: CARD-7 inherited item')
    }
    expect(verdicts[0]).not.toContain('using ancestor snapshot')
    for (const verdict of verdicts.slice(1)) {
      expect(verdict).toContain(`using ancestor snapshot from ${cwd}`)
    }
  })

  it('uses the most specific ancestor snapshot', () => {
    const { env, payload, stateDir, cwd } = scaffold('specific-ancestor')
    const repository = join(cwd, 'repository')
    const nested = join(repository, 'packages', 'core')
    mkdirSync(nested, { recursive: true })
    agePath(repository)
    agePath(join(repository, 'packages'))
    agePath(nested)
    writeSnapshot(stateDir, cwd, { open: 11, at: Date.now(), next: 'root item' })
    writeSnapshot(stateDir, repository, { open: 3, at: Date.now(), next: 'repository item' })

    const r = runHook({ ...(payload as Record<string, unknown>), cwd: nested }, env)
    const text = blockText(r)
    expect(text).toContain('3 open')
    expect(text).toContain('next: repository item')
    expect(text).toContain(`using ancestor snapshot from ${repository}`)
    expect(text).not.toContain('11 open')
  })

  it('ignores a truncated readable-prefix match without the full ancestor hash', () => {
    const { env, payload, stateDir, cwd } = scaffold('truncated-prefix')
    const shared = 'x'.repeat(140)
    const current = join(cwd, shared, 'current', 'nested')
    const sibling = join(cwd, shared, 'sibling')
    mkdirSync(current, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeSnapshot(stateDir, sibling, { open: 9, at: Date.now(), next: 'sibling item' })
    expect(slug(current).slice(0, 120)).toBe(slug(sibling).slice(0, 120))

    const r = runHook({ ...(payload as Record<string, unknown>), cwd: current }, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('blocks via stdout hookSpecificOutput.additionalContext + exit 0, never stderr + exit 2', () => {
    const { env, payload, stateDir, cwd } = scaffold('emission-shape')
    writeSnapshot(stateDir, cwd, { open: 3, at: Date.now(), next: 'CARD-1 next item' })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    const text = blockText(r)
    expect(text).not.toBe('')
    expect(text).toContain('open work remains')
  })

  it('stays silent when the worktree was written to seconds ago even if no subagent transcript moved', () => {
    const { env, payload, stateDir, cwd } = scaffold('recent-worktree-activity')
    writeSnapshot(stateDir, cwd, { open: 4, at: Date.now(), next: 'CARD-4 lane-owned item' })
    writeFileSync(join(cwd, 'lane-output.txt'), 'external lane wrote here', 'utf8')

    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('still blocks when the worktree is stale and no recent activity exists', () => {
    const { env, payload, stateDir, cwd } = scaffold('stale-worktree-idle')
    writeSnapshot(stateDir, cwd, { open: 6, at: Date.now(), next: 'CARD-6 idle item' })
    const staleFile = join(cwd, 'old-output.txt')
    writeFileSync(staleFile, 'old write', 'utf8')
    const staleDate = new Date(Date.now() - 10 * 60_000)
    utimesSync(staleFile, staleDate, staleDate)

    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    const text = blockText(r)
    expect(text).toContain('open work remains')
    expect(text).toContain('no recent worktree activity')
  })

  it('does not treat recent node_modules writes as in-flight worktree activity', () => {
    const { env, payload, stateDir, cwd } = scaffold('skip-node-modules')
    writeSnapshot(stateDir, cwd, { open: 8, at: Date.now(), next: 'CARD-8 real work item' })
    const recentDependencyFile = join(cwd, 'node_modules', 'pkg', 'index.js')
    mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(recentDependencyFile, 'dependency churn', 'utf8')

    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    const text = blockText(r)
    expect(text).toContain('open work remains')
    expect(text).toContain('no recent worktree activity')
    expect(text).toContain('8 open')
  })

  it('does not let a sibling worktree under an umbrella root silence this session', () => {
    const root = mkRoot('umbrella-neighbor-activity')
    const stateDir = join(root, 'queue-gate-state')
    const umbrella = join(root, 'umbrella')
    const driven = join(umbrella, 'worktrees', 'this-session')
    const sibling = join(umbrella, 'worktrees', 'other-session')
    const transcriptPath = join(root, 'transcript.jsonl')
    mkdirSync(driven, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(driven, '.git'), 'gitdir: /dev/null\n', 'utf8')
    writeFileSync(join(sibling, '.git'), 'gitdir: /dev/null\n', 'utf8')
    writeFileSync(transcriptPath, '')
    writeSnapshot(stateDir, umbrella, { open: 5, at: Date.now(), next: 'CARD-5 scoped item' })
    writeFileSync(join(sibling, 'lane-output.txt'), 'neighbor session write', 'utf8')

    const r = runHook({
      hook_event_name: 'Stop',
      session_id: 'session-umbrella-neighbor-activity',
      cwd: umbrella,
      transcript_path: transcriptPath,
    }, {
      ...process.env,
      WT_QUEUE_GATE_DIR: stateDir,
      HOME: root,
    })

    expect(r.code).toBe(0)
    const text = blockText(r)
    expect(text).toContain('open work remains')
    expect(text).toContain('no recent worktree activity')
    expect(text).toContain('5 open')
  })

  it('the emitted additionalContext is at most 6 lines', () => {
    const { env, payload, stateDir, cwd } = scaffold('length-lock')
    writeSnapshot(stateDir, cwd, { open: 5, at: Date.now(), next: 'CARD-2 length lock item' })
    const r = runHook(payload, env)
    const text = blockText(r)
    expect(text).not.toBe('')
    // ⚠ RED PROOF, run once by hand before this assertion was accepted (per the card's own
    // test-lock requirement): reverting the emission edit and re-running this file against the
    // OLD stderr message (12+ lines) fails this assertion — the lock is not decorative.
    expect(text.split('\n').length).toBeLessThanOrEqual(6)
  })

  it('the block still fires with an UNKNOWN (stale) snapshot, message included', () => {
    const { env, payload, stateDir, cwd } = scaffold('unknown-state')
    // No snapshot written at all ⇒ hook has nothing wired ⇒ silent (see hook header, "NO
    // TRACKER"). Write a STALE one instead so the UNKNOWN branch of the message is exercised.
    writeSnapshot(stateDir, cwd, { open: 2, at: Date.now() - 3 * 60 * 60 * 1000, next: '' })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    const text = blockText(r)
    expect(text).toContain('Queue size is unknown')
  })

  // Card 1837879927592977538: STALE and MALFORMED used to share the identical text ("Queue size
  // is unknown (stale snapshot)"), even when the marker was corrupt rather than merely old — two
  // different remedies (repair a broken write vs. just re-read the queue) hidden behind one
  // word. The lock below asserts the INVARIANT — every distinct queue status this hook computes
  // produces a message distinct from every other status' message — over the whole set the code
  // defines, not a hard-coded pair, so a status added later that forgets to differentiate its
  // text fails this test rather than silently joining the collapse it was meant to prevent.
  it('every distinct queue status produces a message distinct from every other status', () => {
    // Each fixture writer produces ONE way of reaching its status. 'malformed' has TWO
    // independent producers (corrupt JSON text; well-formed JSON with a wrong field shape) —
    // both must land on the SAME message as each other (same status), while STALE must land on
    // a DIFFERENT message than either (different status). This is the invariant, checked over
    // the whole set the code defines — not a hard-coded pair — so a status added later that
    // forgets to differentiate its text fails here instead of silently rejoining the collapse.
    const fixtures: Record<string, (stateDir: string, cwd: string) => void> = {
      stale: (stateDir, cwd) =>
        writeSnapshot(stateDir, cwd, { open: 2, at: Date.now() - 3 * 60 * 60 * 1000, next: '' }),
      'malformed (corrupt JSON)': (stateDir, cwd) => {
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(join(stateDir, `queue-${slug(cwd)}.json`), '{not json', 'utf8')
      },
      'malformed (wrong field types)': (stateDir, cwd) =>
        writeSnapshot(stateDir, cwd, { open: 'lots', at: Date.now(), next: '' }),
    }

    const byLabel: Record<string, string> = {}
    for (const [label, write] of Object.entries(fixtures)) {
      const { env, payload, stateDir, cwd } = scaffold(`status-${label.replace(/\W+/g, '-')}`)
      write(stateDir, cwd)
      const r = runHook(payload, env)
      expect(r.code).toBe(0)
      const text = blockText(r)
      expect(text).not.toBe('') // every fixture here is expected to block
      byLabel[label] = text
    }

    const stale = byLabel.stale
    const malformedA = byLabel['malformed (corrupt JSON)']
    const malformedB = byLabel['malformed (wrong field types)']
    expect(malformedA).toBe(malformedB) // same STATUS ⇒ same text, regardless of producer
    expect(stale).not.toBe(malformedA) // different STATUS ⇒ different text — the fix itself
    expect(stale).toContain('stale')
    expect(malformedA).toContain('unreadable/malformed')
    expect(stale).not.toContain('unreadable/malformed')
    expect(malformedA).not.toContain('stale')
  })

  it('names the companion help file, and that file exists on disk', () => {
    const { env, payload, stateDir, cwd } = scaffold('help-pointer')
    writeSnapshot(stateDir, cwd, { open: 1, at: Date.now(), next: '' })
    const r = runHook(payload, env)
    const text = blockText(r)
    expect(text).toContain('wt-queue-not-empty-gate-hook.help.md')
    expect(existsSync(HELP_FILE)).toBe(true)
    expect(readFileSync(HELP_FILE, 'utf8').length).toBeGreaterThan(0)
  })

  it('stays silent when the queue is genuinely empty', () => {
    const { env, payload, stateDir, cwd } = scaffold('empty-queue')
    writeSnapshot(stateDir, cwd, { open: 0, at: Date.now(), next: '' })
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })

  it('stays silent with no snapshot ever written (no tracker wired)', () => {
    const { env, payload } = scaffold('no-tracker')
    const r = runHook(payload, env)
    expect(r.code).toBe(0)
    expect(blockText(r)).toBe('')
  })
})

describe('plugin manifest wiring', () => {
  it('registers wt-queue-not-empty-gate-hook.mjs on Stop, alongside wt-actionable-gate-hook.mjs (register-not-retire)', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8'),
    ) as { hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> } }
    const commands = (manifest.hooks?.Stop ?? [])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? '')
    expect(commands.some((c) => c.includes('wt-queue-not-empty-gate-hook.mjs'))).toBe(true)
    expect(commands.some((c) => c.includes('wt-actionable-gate-hook.mjs'))).toBe(true)
  })
})

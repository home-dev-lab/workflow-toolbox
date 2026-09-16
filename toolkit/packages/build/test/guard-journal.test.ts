import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LIB = join(REPO_ROOT, 'plugin/bin/lib/guard-journal.mjs')
const SCAN = join(REPO_ROOT, 'plugin/bin/wt-guard-journal-scan.mjs')

let journalDir: string

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'wt-guard-journal-test-'))
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

/** Runs a tiny inline script that imports the library and calls recordGuardEvent once. */
function record(
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
  spawnCwd?: string,
) {
  const script = `
    import { recordGuardEvent } from ${JSON.stringify(pathToFileURL(LIB).href)}
    recordGuardEvent(${JSON.stringify(args)})
  `
  const childEnv: NodeJS.ProcessEnv = { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir, ...env }
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key]
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: childEnv,
    ...(spawnCwd ? { cwd: spawnCwd } : {}),
  })
}

function emitNotice(payload: Record<string, unknown>) {
  const script = `
    import { emitGuardNotice } from ${JSON.stringify(pathToFileURL(LIB).href)}
    emitGuardNotice({ payload: ${JSON.stringify(payload)}, stdoutText: 'warning' })
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, WT_GUARD_MODE: 'warn' },
  })
}

function journalFiles(): string[] {
  if (!existsSync(journalDir)) return []
  return readdirSync(journalDir).filter((f) => f.endsWith('.ndjson'))
}

function readAllEntries(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const f of journalFiles()) {
    const lines = readFileSync(join(journalDir, f), 'utf8').split('\n').filter(Boolean)
    for (const l of lines) out.push(JSON.parse(l))
  }
  return out
}

function secretStore(configDir: string, name: string, value: string, token: string) {
  const salt = 'test-salt-which-is-long-enough-to-be-valid'
  const storeDir = join(configDir, 'plugins', 'store')
  mkdirSync(storeDir, { recursive: true })
  const storePath = join(storeDir, name)
  writeFileSync(storePath, JSON.stringify({
    salt,
    detections: {
      entries: [{ token, sha256: createHash('sha256').update(`${salt}:${value}`).digest('hex') }],
    },
  }))
  return storePath
}

describe('guard-journal — recordGuardEvent', () => {
  it('renders warned notices for the main loop but not a subagent', () => {
    const main = emitNotice({})
    const subagent = emitNotice({ agent_id: 'a1' })
    expect(main.status).toBe(0)
    expect(main.stdout).toBe('warning')
    expect(subagent.status).toBe(0)
    expect(subagent.stdout).toBe('')
  })

  it('RED->GREEN: writes one NDJSON line for a blocked decision', () => {
    const res = record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked', class: 'x', reason: 'because' })
    expect(res.status).toBe(0)
    const entries = readAllEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      guard: 'wt-example-guard-hook.mjs',
      decision: 'blocked',
      class: 'x',
      reason: 'because',
      pid: expect.any(Number),
      ppid: expect.any(Number),
    })
    expect(typeof entries[0]!.ts).toBe('string')
  })

  it('RED: replaces a matching candidate using the named secret-guard store before persisting', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'wt-secret-store-test-'))
    const value = ['synthetic', 'token', 'value', '123456789'].join('-')
    const token = 'secret:test#named'
    secretStore(configDir, 'wt-secret-guard.json', value, token)
    try {
      const res = record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked', reason: value }, { CLAUDE_CONFIG_DIR: configDir })
      expect(res.status).toBe(0)
      expect(readAllEntries()[0]!.reason === token).toBe(true)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('RED: masks stored secrets embedded in punctuation-delimited journal fields', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'wt-secret-store-test-'))
    const short = 's3cr3t'
    const first = 'synthetic-token-value-123456789'
    const second = 'another-token-value-987654321'
    secretStore(configDir, 'wt-secret-guard.json', short, 'masked-short')
    try {
      const storePath = join(configDir, 'plugins', 'store', 'wt-secret-guard.json')
      const store = JSON.parse(readFileSync(storePath, 'utf8'))
      store.detections.entries.push(
        { token: 'masked-first', sha256: createHash('sha256').update(`${store.salt}:${first}`).digest('hex') },
        { token: 'masked-second', sha256: createHash('sha256').update(`${store.salt}:${second}`).digest('hex') },
      )
      writeFileSync(storePath, JSON.stringify(store))

      const res = record({
        guard: 'wt-example-guard-hook.mjs',
        decision: 'blocked',
        class: `token=${short},`,
        reason: `token=${first}, then ${second}.`,
        cwd: `https://example.test/records/${first}?token=${second}`,
        evidence: { json: `{"token":"${short}"}`, prose: `contains ${short} here` },
      }, { CLAUDE_CONFIG_DIR: configDir })

      expect(res.status).toBe(0)
      const persisted = JSON.stringify(readAllEntries()[0])
      expect(persisted).not.toContain(short)
      expect(persisted).not.toContain(first)
      expect(persisted).not.toContain(second)
      expect(persisted).toContain('masked-short')
      expect(persisted).toContain('masked-first')
      expect(persisted).toContain('masked-second')
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('RED: uses the newest inline secret-guard store before persisting', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'wt-secret-store-test-'))
    const value = ['synthetic', 'token', 'value', '987654321'].join('-')
    const token = 'secret:test#inline'
    const oldValue = ['synthetic', 'token', 'value', '111111111'].join('-')
    const oldStore = secretStore(configDir, 'wt-secret-guard_inline-old.json', oldValue, 'secret:test#old')
    utimesSync(oldStore, 1, 1)
    secretStore(configDir, 'wt-secret-guard_inline-current.json', value, token)
    try {
      const res = record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked', reason: value }, { CLAUDE_CONFIG_DIR: configDir })
      expect(res.status).toBe(0)
      expect(readAllEntries()[0]!.reason === token).toBe(true)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('writes one NDJSON line for a warned decision', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'warned' })
    const entries = readAllEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.decision).toBe('warned')
    expect(entries[0]!.mode).toBe('enforce')
  })

  it('classifies a record whose raw target is under the native temp root as test-origin', () => {
    const target = join(journalDir, 'project')
    mkdirSync(target)
    record(
      { guard: 'wt-example-guard-hook.mjs', decision: 'blocked', cwd: target },
      { WT_GUARD_JOURNAL_TEST_ORIGIN: undefined },
    )
    expect(readAllEntries()[0]!.origin).toBe('test')
  })

  it('classifies a record whose raw target is outside the native temp root as real', () => {
    record(
      { guard: 'wt-example-guard-hook.mjs', decision: 'blocked', cwd: REPO_ROOT },
      { WT_GUARD_JOURNAL_TEST_ORIGIN: undefined },
    )
    expect(readAllEntries()[0]!.origin).toBe('real')
  })

  // A call site that omits `cwd` is the MAJORITY case: measured on this tree, 26 of the 33 files
  // that journal never pass one, and they include the loudest guards. Classifying those as
  // `unknown` left the `real` count — the only one the recurrence threshold reads — pinned at zero
  // for them forever, so the probation could never be reached. The guard PROCESS's own directory is
  // the session's directory, so it is the answer, not a guess. These two tests are a pair: the
  // second is what stops the fallback from simply always saying `real`.
  it('classifies a record with no target from the guard process own directory', () => {
    const result = record(
      { guard: 'wt-example-guard-hook.mjs', decision: 'blocked' },
      { WT_GUARD_JOURNAL_TEST_ORIGIN: undefined },
      REPO_ROOT,
    )
    expect(result.status, result.stderr).toBe(0)
    const entry = readAllEntries()[0]!
    expect(entry.origin).toBe('real')
    expect(entry.cwd).toBe(REPO_ROOT.replace(/[\\/]$/, ''))
  })

  it('still classifies a record with no target as test when that directory is the temp root', () => {
    const inTemp = mkdtempSync(join(tmpdir(), 'wt-guard-origin-cwd-'))
    try {
      const result = record(
        { guard: 'wt-example-guard-hook.mjs', decision: 'blocked' },
        { WT_GUARD_JOURNAL_TEST_ORIGIN: undefined },
        inTemp,
      )
      expect(result.status, result.stderr).toBe(0)
      expect(readAllEntries()[0]!.origin).toBe('test')
    } finally {
      rmSync(inTemp, { recursive: true, force: true })
    }
  })

  it('classifies as unknown when the selftest marker is present but not the declared value', () => {
    record(
      { guard: 'wt-example-guard-hook.mjs', decision: 'blocked' },
      { WT_GUARD_JOURNAL_TEST_ORIGIN: 'maybe' },
      REPO_ROOT,
    )
    expect(readAllEntries()[0]!.origin).toBe('unknown')
  })

  it('stamps mode=observe when WT_GUARD_MODE=observe', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'warned' }, { WT_GUARD_MODE: ' observe ' })
    const entries = readAllEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.mode).toBe('observe')
  })

  it('never writes for a decision that is neither blocked nor warned (e.g. allow/journal)', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'allowed-journaled' })
    expect(journalFiles()).toHaveLength(0)
  })

  it('never writes with no guard name', () => {
    record({ decision: 'blocked' })
    expect(journalFiles()).toHaveLength(0)
  })

  it('appends — two events land as two lines in the same file, never overwriting', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked' })
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'warned' })
    expect(journalFiles()).toHaveLength(1)
    expect(readAllEntries()).toHaveLength(2)
  })

  it('two concurrent processes both land their line — the file is never clobbered by the second writer', () => {
    // Simulates two sessions writing at "the same time": both writes are independent
    // fs.appendFileSync calls, no shared lock — the property under test is that append
    // survives without truncation, not true atomicity of interleaved bytes.
    const a = record({ guard: 'wt-guard-a.mjs', decision: 'blocked' })
    const b = record({ guard: 'wt-guard-b.mjs', decision: 'warned' })
    expect(a.status).toBe(0)
    expect(b.status).toBe(0)
    const entries = readAllEntries()
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.guard).sort()).toEqual(['wt-guard-a.mjs', 'wt-guard-b.mjs'])
  })

  it('rotates weekly: a forced past week and a forced future week land in DIFFERENT files', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked' }, { WT_GUARD_JOURNAL_NOW: '2024-01-01T00:00:00Z' })
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked' }, { WT_GUARD_JOURNAL_NOW: '2024-07-01T00:00:00Z' })
    expect(journalFiles()).toHaveLength(2)
  })

  it('the same week produces the same file regardless of which day within it', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked' }, { WT_GUARD_JOURNAL_NOW: '2024-01-01T00:00:00Z' }) // Monday
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked' }, { WT_GUARD_JOURNAL_NOW: '2024-01-07T23:00:00Z' }) // Sunday, same ISO week
    expect(journalFiles()).toHaveLength(1)
    expect(readAllEntries()).toHaveLength(2)
  })

  it('FAIL-OPEN: a directory that cannot be created never throws — the call always returns', () => {
    // Point the journal at a path segment that is actually a FILE, so mkdirSync must fail.
    const blockerFile = join(journalDir, 'not-a-dir')
    mkdirSync(journalDir, { recursive: true })
    writeFileSync(blockerFile, 'x')
    const res = record(
      { guard: 'wt-example-guard-hook.mjs', decision: 'blocked' },
      { WT_GUARD_JOURNAL_DIR: join(blockerFile, 'journal'), CLAUDE_CONFIG_DIR: journalDir },
    )
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('secret guard store unavailable')
  })

  it('reason is truncated so one enormous command never blows up the journal file', () => {
    const huge = 'x'.repeat(5000)
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked', reason: huge })
    const entries = readAllEntries()
    expect((entries[0]!.reason as string).length).toBeLessThanOrEqual(400)
  })

  it('keeps well-formed bounded evidence and session fields', () => {
    record({
      guard: 'wt-example-guard-hook.mjs',
      decision: 'warned',
      session: 'session-123/example',
      evidence: { after: 'pnpm,git', count: 2 },
    })
    expect(readAllEntries()[0]).toMatchObject({
      session: 'session-123/example',
      evidence: { after: 'pnpm,git', count: '2' },
    })
  })

  it('sanitises and records the agent identity', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked', session: 's1', agent: 'agent 1' })
    expect(readAllEntries()[0]).toMatchObject({ agent: 'agent?1', pid: expect.any(Number), ppid: expect.any(Number) })
  })

  it('aggregates distinct sessions and counts old-shape entries as unknown', () => {
    mkdirSync(journalDir, { recursive: true })
    writeFileSync(
      join(journalDir, '2026-W32.ndjson'),
      [
        { guard: 'g', decision: 'blocked', session: 'a' },
        { guard: 'g', decision: 'warned', session: 'a' },
        { guard: 'g', decision: 'blocked', session: 'b' },
        { guard: 'g', decision: 'blocked' },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    )
    const result = spawnSync(process.execPath, [SCAN, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir },
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).guards[0]).toMatchObject({
      total: 4,
      origins: { real: 0, test: 0, unknown: 4 },
      sessions: 2,
      unknownSessionEvents: 1,
    })
  })

  it('prints firing and distinct-session counts in the human scan line', () => {
    mkdirSync(journalDir, { recursive: true })
    writeFileSync(
      join(journalDir, '2026-W32.ndjson'),
      [
        { guard: 'g', decision: 'blocked', session: 'a' },
        { guard: 'g', decision: 'warned', session: 'a' },
        { guard: 'g', decision: 'blocked' },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    )
    const result = spawnSync(process.execPath, [SCAN], {
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 real firings (0 from test runs, excluded); 3 origin unknown')
    expect(result.stdout).toContain('1 sessions across all origins (+1 unattributed)')
  })

  it('truncates an over-long evidence value after coercion', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked', evidence: { after: 'x'.repeat(40) } })
    expect(readAllEntries()[0]!.evidence).toEqual({ after: 'x'.repeat(24) })
  })

  // Two properties in one case, deliberately: the COMMA survives (it is a guard's own list
  // separator and cannot carry a secret), while the run of spaces around it collapses to a
  // single '?'. An earlier version excluded the comma too, which mangled `pnpm,git` into
  // `pnpm?git` — readable-ish, and wrong about what the charset is for.
  it('collapses each run of disallowed evidence characters to one question mark, keeping the comma', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked', evidence: { after: 'pnpm,  --filter' } })
    expect(readAllEntries()[0]!.evidence).toEqual({ after: 'pnpm,?--filter' })
  })

  it('drops a seventh valid evidence key', () => {
    record({
      guard: 'wt-example-guard-hook.mjs',
      decision: 'blocked',
      evidence: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 },
    })
    expect(readAllEntries()[0]!.evidence).toEqual({ a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' })
  })

  it('omits evidence when every key or value is unusable', () => {
    record({
      guard: 'wt-example-guard-hook.mjs',
      decision: 'blocked',
      session: 'session-garbage',
      evidence: {
        ['k'.repeat(25)]: 'value',
        'bad$key': 'value',
        object: { secret: 'not-flat' },
        boolean: true,
        empty: '',
      },
    })
    expect(readAllEntries()[0]).toMatchObject({ session: 'session-garbage' })
    expect(readAllEntries()[0]).not.toHaveProperty('evidence')
  })
})

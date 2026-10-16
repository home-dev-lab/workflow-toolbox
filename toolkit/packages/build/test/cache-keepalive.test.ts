import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const MONITOR = join(REPO_ROOT, 'plugin/bin/wt-cache-keepalive.mjs')
const MONITORS_JSON = join(REPO_ROOT, 'plugin/monitors/monitors.json')
const roots: string[] = []
const PROVIDER_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE']
const FETCH_ENV_KEYS = ['DISABLE_GROWTHBOOK', 'DISABLE_TELEMETRY', 'DO_NOT_TRACK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', ...PROVIDER_KEYS]
const CLEAN_FETCH_ENV = Object.fromEntries(FETCH_ENV_KEYS.map((key) => [key, undefined]))

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function projectSlug(dir: string): string {
  return resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

function assistant(id: string, model: string, atMinutes: number, usage = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(atMinutes * 60_000).toISOString(),
    message: {
      id,
      model,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
    },
  })
}

function scaffold(tag: string, model = 'claude-sonnet-4-5') {
  const root = mkdtempSync(join(tmpdir(), `wt-cache-keepalive-${tag}-`))
  roots.push(root)
  const configDir = join(root, 'config')
  const projectDir = join(root, 'project')
  const sessionId = 'session-under-test'
  const transcriptDir = join(configDir, 'projects', projectSlug(projectDir))
  const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`)
  const journalDir = join(root, 'journal')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(transcriptDir, { recursive: true })
  writeFileSync(transcriptPath, `${assistant('baseline', model, 0)}\n`)
  const bootstrapPath = installBootstrap(configDir)
  return { bootstrapPath, configDir, journalDir, projectDir, sessionId, transcriptPath }
}

function run(state: ReturnType<typeof scaffold>, nowMinutes: number, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(state.bootstrapPath).href, MONITOR, '--once', '--now', String(nowMinutes * 60_000), '--project', state.projectDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: state.sessionId,
      CLAUDE_CONFIG_DIR: state.configDir,
      CLAUDE_CODE_ENTRYPOINT: undefined,
      CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: undefined,
      DISABLE_AUTO_COMPACT: undefined,
      ...CLEAN_FETCH_ENV,
      WT_CACHE_KEEPALIVE_ENABLED: 'true',
      WT_CACHE_KEEPALIVE_ANTHROPIC_MINUTES: '50',
      WT_CACHE_KEEPALIVE_OPENAI_MINUTES: '25',
      WT_CACHE_KEEPALIVE_MAX_REFRESHES: '10',
      WT_CACHE_KEEPALIVE_JOURNAL_DIR: state.journalDir,
      ...extraEnv,
    },
  })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  return result
}

function append(state: ReturnType<typeof scaffold>, line: string): void {
  writeFileSync(state.transcriptPath, `${readFileSync(state.transcriptPath, 'utf8')}${line}\n`)
}

function journal(state: ReturnType<typeof scaffold>): Array<Record<string, unknown>> {
  return readFileSync(join(state.journalDir, `${state.sessionId}.jsonl`), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('wt-cache-keepalive', () => {
  it('is on by default and stays silent only when explicitly disabled', () => {
    const state = scaffold('off')
    const runWith = (value: string | undefined) => spawnSync(process.execPath, [MONITOR, '--once', '--now', String(60 * 60_000), '--project', state.projectDir], {
      encoding: 'utf8',
      // The ambient setting must not leak in either way.
      env: { ...process.env, WT_CACHE_KEEPALIVE_ENABLED: value, WT_CACHE_KEEPALIVE_ANTHROPIC_MINUTES: '50', WT_CACHE_KEEPALIVE_MAX_REFRESHES: '10', WT_CACHE_KEEPALIVE_JOURNAL_DIR: state.journalDir, CLAUDE_CODE_SESSION_ID: state.sessionId, CLAUDE_CONFIG_DIR: state.configDir },
    })
    const unset = runWith(undefined)
    expect(unset.status).toBe(0)
    expect(unset.stdout).toContain('CACHE KEEPALIVE')
    for (const value of ['false', '0', 'no', 'off']) {
      const disabled = runWith(value)
      expect(disabled.status).toBe(0)
      expect(disabled.stdout).toBe('')
    }
  })

  it('uses the 50-minute Claude threshold and journals model, threshold, and refresh count', () => {
    const state = scaffold('claude')
    expect(run(state, 49).stdout).toBe('')
    expect(run(state, 50).stdout).toBe('CACHE KEEPALIVE: Reply with exactly one word: warm. Do not perform any other work.\n')
    expect(journal(state).at(-1)).toMatchObject({ kind: 'wake', model: 'claude-sonnet-4-5', provider: 'anthropic', refreshCount: 1, thresholdMinutes: 50 })
  })

  it('uses the overridable 25-minute GPT threshold', () => {
    const state = scaffold('gpt', 'gpt-5.3-codex')
    const env = { WT_CACHE_KEEPALIVE_OPENAI_MINUTES: '20' }
    expect(run(state, 19, env).stdout).toBe('')
    expect(run(state, 20, env).stdout).toContain('CACHE KEEPALIVE:')
    expect(journal(state).at(-1)).toMatchObject({ provider: 'openai', thresholdMinutes: 20 })
  })

  it('stays silent while real calls continue and resets the consecutive refresh count on work', () => {
    const state = scaffold('work')
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    append(state, assistant('refresh-1', 'claude-sonnet-4-5', 50.01, { cache_read_input_tokens: 250_000, cache_creation_input_tokens: 100 }))
    append(state, assistant('work', 'claude-sonnet-4-5', 70))
    expect(run(state, 75).stdout).toBe('')
    expect(journal(state).find((entry) => entry.kind === 'refreshed')).toMatchObject({
      usage: { cacheCreation: 100, cacheRead: 250_000 },
    })
    expect(run(state, 120).stdout).toContain('CACHE KEEPALIVE:')
    expect(journal(state).at(-1)).toMatchObject({ kind: 'wake', refreshCount: 1 })
  })

  it('does not count synthetic assistant records as activity and records an uncallable wake', () => {
    const state = sized('synthetic', 10_000)
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    expect(run(state, 75).stdout).toBe('')
    append(state, assistant('synthetic', '<synthetic>', 50.01, { input_tokens: 0, output_tokens: 0 }))
    expect(run(state, 99).stdout).toBe('')
    expect(journal(state).some((entry) => entry.kind === 'uncallable')).toBe(true)
    expect(run(state, 100).stdout).toBe('')
    expect(journal(state).at(-1)).toMatchObject({ kind: 'skip', reason: 'prompt cache freshness expired' })
  })

  it('stops after the configured consecutive refresh cap', () => {
    const state = scaffold('cap')
    const env = { WT_CACHE_KEEPALIVE_MAX_REFRESHES: '2' }
    expect(run(state, 50, env).stdout).toContain('CACHE KEEPALIVE:')
    append(state, assistant('refresh-1', 'claude-sonnet-4-5', 50.01))
    expect(run(state, 100.01, env).stdout).toContain('CACHE KEEPALIVE:')
    append(state, assistant('refresh-2', 'claude-sonnet-4-5', 100.02))
    expect(run(state, 151, env).stdout).toBe('')
    expect(journal(state).at(-1)).toMatchObject({ kind: 'capped', refreshCount: 2 })
    expect(run(state, 250, env).stdout).toBe('')
  })

  it('deduplicates streamed records sharing one message id', () => {
    const state = scaffold('stream')
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    append(state, assistant('refresh', 'claude-sonnet-4-5', 50.01, { output_tokens: 1 }))
    append(state, assistant('refresh', 'claude-sonnet-4-5', 50.02, { output_tokens: 2 }))
    expect(run(state, 100.01).stdout).toBe('')
    expect(run(state, 100.02).stdout).toContain('CACHE KEEPALIVE:')
    expect(journal(state).at(-1)).toMatchObject({ refreshCount: 2 })
  })

  it('tail-scans past an oversized trailing record with bounded memory', () => {
    const state = scaffold('tail')
    append(state, JSON.stringify({ type: 'tool_result', timestamp: new Date(1).toISOString(), content: 'x'.repeat(2 * 1024 * 1024) }))
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
  })

  it('stays silent and journals unknown models and missing transcripts', () => {
    const unknown = scaffold('unknown', 'other-model')
    expect(run(unknown, 100).stdout).toBe('')
    expect(journal(unknown).at(-1)).toMatchObject({ kind: 'skip', reason: 'unrecognised model: other-model' })

    const missing = scaffold('missing')
    rmSync(missing.transcriptPath, { force: true })
    expect(run(missing, 100).stdout).toBe('')
    expect(journal(missing).at(-1)?.reason).toMatch(/^transcript unavailable:/)
  })

  it('supports help and validates the injected clock', () => {
    const help = spawnSync(process.execPath, [MONITOR, '--help'], { encoding: 'utf8' })
    const badClock = spawnSync(process.execPath, [MONITOR, '--now', '1'], { encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('WT_CACHE_KEEPALIVE_ENABLED=false')
    expect(badClock.status).toBe(2)
    expect(badClock.stderr).toContain('--now requires --once')
  })
})

describe('monitors.json registers cache-keepalive', () => {
  it('points at the executable and loads it for every session start', () => {
    const monitors = JSON.parse(readFileSync(MONITORS_JSON, 'utf8')) as Array<{ name: string; command: string; when: string; description: string }>
    const entry = monitors.find((monitor) => monitor.name === 'cache-keepalive')
    expect(entry?.command).toContain('wt-cache-keepalive.mjs')
    expect(entry?.when).toBe('always')
    expect(entry?.description).toContain('On by default')
    expect(entry?.description).toContain('yields to native idle compaction')
  })
})

type Session = ReturnType<typeof scaffold>
const HOUR = { cache_creation_input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 0 } }
const FIVE = { cache_creation_input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1 } }

// Keep subprocess fixtures independent of a machine's managed policy while exercising
// the real settings reader. Direct managed-policy tests inject their own file path.
const POLICY_BOOTSTRAP = `import fs from 'node:fs/promises'
import { basename } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const original = fs.readFile
fs.readFile = function (file, ...args) {
  if (typeof file === 'string' && basename(file) === 'managed-settings.json') return Promise.resolve('{}')
  return original.call(this, file, ...args)
}
syncBuiltinESMExports()
`

function installBootstrap(configDir: string) {
  const file = join(configDir, 'policy-bootstrap.mjs')
  writeFileSync(file, POLICY_BOOTSTRAP)
  return file
}

function sized(tag: string, context: number, ttl: object = HOUR, model = 'claude-sonnet-4-5') {
  const state = scaffold(tag, model)
  writeFileSync(state.transcriptPath, `${assistant('baseline', model, 0, { ...ttl, input_tokens: context - 1 })}\n`)
  return state
}

function compactBoundary(atMinutes: number) {
  return JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(atMinutes * 60_000).toISOString(),
    compactMetadata: { trigger: 'auto', preTokens: 250_000 } })
}

function settings(state: Session, scope: 'user' | 'project' | 'local', value: object) {
  const file = scope === 'user' ? join(state.configDir, 'settings.json')
    : join(state.projectDir, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

function saved(state: Session): Record<string, unknown> {
  return JSON.parse(readFileSync(join(state.journalDir, `${state.sessionId}.state.json`), 'utf8')) as Record<string, unknown>
}

function save(state: Session, value: object) {
  mkdirSync(state.journalDir, { recursive: true })
  writeFileSync(join(state.journalDir, `${state.sessionId}.state.json`), JSON.stringify(value))
}

describe('cache keepalive native compaction and freshness gates', () => {
  it.each([250_000, 200_000])('leaves eligible context %i idle and journals once per idle period', (context) => {
    const state = sized('eligible', context)
    expect(run(state, 50).stdout).toBe('')
    expect(run(state, 55).stdout).toBe('')
    expect(journal(state)).toEqual([expect.objectContaining({ kind: 'skip', reason: 'native idle compaction applies' })])
    append(state, assistant('work', 'claude-sonnet-4-5', 60, { ...HOUR, input_tokens: context - 1 }))
    expect(run(state, 110).stdout).toBe('')
    expect(journal(state)).toHaveLength(2)
  })

  it.each([199_999, 199_999.5])('wakes below the floor without rounding context %s', (context) => {
    expect(run(sized('below', context), 50).stdout).toContain('CACHE KEEPALIVE:')
  })

  it('sums input, cache read and cache creation without including output', () => {
    const state = scaffold('sum')
    writeFileSync(state.transcriptPath, `${assistant('baseline', 'claude-sonnet-4-5', 0,
      { ...HOUR, input_tokens: 99_999, cache_read_input_tokens: 100_000, output_tokens: 500_000 })}\n`)
    expect(run(state, 50).stdout).toBe('')
    expect(saved(state).lastContext).toEqual({ tokens: 200_000, callId: 'baseline', atMs: 0 })
  })

  it('does not repeat a native skip after a transient transcript read failure', () => {
    const state = sized('skip-recovery', 250_000)
    const transcript = readFileSync(state.transcriptPath, 'utf8')
    expect(run(state, 50).stdout).toBe('')
    rmSync(state.transcriptPath)
    expect(run(state, 51).stdout).toBe('')
    writeFileSync(state.transcriptPath, transcript)
    expect(run(state, 52).stdout).toBe('')
    expect(journal(state).filter((entry) => entry.reason === 'native idle compaction applies')).toHaveLength(1)
  })
})

describe('cache keepalive native compaction fallback', () => {
  it('warms an eligible one-hour cache when native idle compaction has not run by its fire time plus grace', () => {
    const state = sized('native-fallback', 250_000)
    expect(run(state, 50).stdout).toBe('')
    expect(run(state, 55).stdout).toBe('')
    expect(run(state, 56).stdout).toContain('CACHE KEEPALIVE:')
    expect(journal(state).at(-1)).toEqual(expect.objectContaining({ kind: 'wake', nativeFallback: true }))
  })

  it('stays silent once a compaction boundary newer than the last call is appended', () => {
    const state = sized('native-compacted', 250_000)
    expect(run(state, 50).stdout).toBe('')
    append(state, compactBoundary(54))
    expect(run(state, 56).stdout).toBe('')
    expect(run(state, 59).stdout).toBe('')
    expect(saved(state).lastCompactedAtMs).toBe(54 * 60_000)
    expect(journal(state).some((entry) => entry.kind === 'wake')).toBe(false)
  })

  it('finds a compaction boundary on first discovery and ignores one older than the last call', () => {
    const compacted = sized('native-compacted-discovery', 250_000)
    append(compacted, compactBoundary(54))
    expect(run(compacted, 56).stdout).toBe('')
    const older = scaffold('native-older-boundary')
    writeFileSync(older.transcriptPath, `${compactBoundary(-5)}\n${assistant('baseline', 'claude-sonnet-4-5', 0, { ...HOUR, input_tokens: 249_999 })}\n`)
    expect(run(older, 56).stdout).toContain('CACHE KEEPALIVE:')
  })
})

describe('cache keepalive environment floor', () => {
  it.each([
    ['320000', 300_000, true], ['320000', 320_000, false], ['50000', 100_000, false], ['50000', 99_999, true],
    ['0', 200_000, false], ['-5', 200_000, false], ['150000.5', 200_000, false],
    ['abc', 200_000, false], ['', 200_000, false], [' 320000 ', 200_000, false],
    ['1e6', 200_000, false], ['+320000', 200_000, false], ['00050000', 100_000, false],
    ['0', 199_999, true], ['-5', 199_999, true], ['150000.5', 199_999, true],
    ['abc', 199_999, true], ['', 199_999, true],
  ] as const)('parses environment floor %j at context %i (wake=%s)', (floor, context, wake) => {
    const result = run(sized('env-floor', context), 50, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: floor })
    expect(result.stdout.includes('CACHE KEEPALIVE:')).toBe(wake)
  })
})

describe('cache keepalive compaction settings', () => {
  it.each([
    [{ idleCompaction: true }, {}, { idleCompaction: false }, true],
    [{ idleCompaction: false }, { idleCompaction: true }, {}, false],
    [{ idleCompaction: false }, {}, { unrelated: true }, true],
    [{ idleCompaction: true }, {}, { unrelated: true }, false],
  ] as const)('resolves idleCompaction independently across settings %#', (user, project, local, wake) => {
    const state = sized('settings', 250_000)
    settings(state, 'user', user)
    settings(state, 'project', project)
    settings(state, 'local', local)
    expect(run(state, 50).stdout.includes('CACHE KEEPALIVE:')).toBe(wake)
  })

  it('reads the floor from settings env blocks with per-key file precedence', () => {
    const state = sized('settings-env', 300_000)
    settings(state, 'user', { env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '200000' } })
    settings(state, 'project', { env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '320000' } })
    settings(state, 'local', { env: { OTHER: 'value' } })
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
  })

  it.each(['1', 'true'])('disables the size gate for DISABLE_AUTO_COMPACT=%s', (value) => {
    expect(run(sized('disable', 250_000), 50, { DISABLE_AUTO_COMPACT: value }).stdout).toContain('CACHE KEEPALIVE:')
  })

  it.each(['0', 'false', 'yes', ''])('does not interpret undocumented disable value %j as set', (value) => {
    expect(run(sized('enabled', 250_000), 50, { DISABLE_AUTO_COMPACT: value }).stdout).toBe('')
  })

  it('applies eligibility independently of provider model', () => {
    expect(run(sized('gpt-size', 250_000, HOUR, 'gpt-5.3-codex'), 25).stdout).toBe('')
  })

  it.each(['sdk-cli', 'sdk-ts', 'sdk-py'])('keeps the size gate off for the noninteractive %s entrypoint', (entrypoint) => {
    expect(run(sized('sdk', 250_000), 50, { CLAUDE_CODE_ENTRYPOINT: entrypoint }).stdout).toContain('CACHE KEEPALIVE:')
  })
})

describe('cache keepalive TTL evidence', () => {
  it('skips an expired five-minute-only cache', () => {
    const state = sized('five', 10_000, FIVE)
    expect(run(state, 50).stdout).toBe('')
    expect(journal(state).at(-1)).toMatchObject({ kind: 'skip', reason: 'prompt cache freshness expired' })
  })

  it('retains an earlier one-hour writer behind a newer five-minute writer', () => {
    const state = sized('mixed', 10_000)
    append(state, assistant('five', 'claude-sonnet-4-5', 1, FIVE))
    expect(run(state, 51).stdout).toContain('CACHE KEEPALIVE:')
    expect(saved(state).cacheEvidence).toMatchObject({ oneHour: { callId: 'baseline', atMs: 0 }, fiveMinute: { callId: 'five', atMs: 60_000 } })
  })

  it('keeps unknown TTL behavior even for a large context', () => {
    expect(run(sized('unknown-ttl', 250_000, { cache_creation_input_tokens: 1 }), 50).stdout).toContain('CACHE KEEPALIVE:')
  })

  it('does not expire a five-minute cache before a threshold override under five minutes', () => {
    expect(run(sized('short', 10_000, FIVE), 3, { WT_CACHE_KEEPALIVE_ANTHROPIC_MINUTES: '3' }).stdout).toContain('CACHE KEEPALIVE:')
  })

  it.each([[5, true], [5.001, false]] as const)('uses full precision for five-minute expiry at %s (wake=%s)', (minutes, wake) => {
    expect(run(sized('ttl-boundary', 10_000, FIVE), minutes, { WT_CACHE_KEEPALIVE_ANTHROPIC_MINUTES: '5' })
      .stdout.includes('CACHE KEEPALIVE:')).toBe(wake)
  })
})

describe('cache keepalive freshness', () => {
  it('skips a stale one-hour anchor at initial discovery', () => {
    expect(run(sized('stale-start', 10_000), 61).stdout).toBe('')
  })

  it('handles sleep/resume and becomes refreshable after a new real call', () => {
    const state = sized('resume', 10_000)
    expect(run(state, 49).stdout).toBe('')
    expect(run(state, 120).stdout).toBe('')
    append(state, assistant('work', 'claude-sonnet-4-5', 121))
    expect(run(state, 171).stdout).toContain('CACHE KEEPALIVE:')
  })

  it('does not treat an uncallable attempt as cache freshness', () => {
    const state = sized('uncallable-ttl', 10_000)
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    append(state, assistant('synthetic', '<synthetic>', 50.01))
    expect(run(state, 100).stdout).toBe('')
    expect(journal(state).at(-1)).toMatchObject({ kind: 'skip', reason: 'prompt cache freshness expired' })
    expect(saved(state)).toMatchObject({ lastRefreshedAtMs: null })
  })

  it('preserves the second uncallable attempt when TTL remains unknown', () => {
    const state = scaffold('uncallable-unknown')
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    append(state, assistant('synthetic', '<synthetic>', 50.01))
    expect(run(state, 99).stdout).toBe('')
    expect(run(state, 100).stdout).toContain('CACHE KEEPALIVE:')
    expect(journal(state).map((entry) => entry.kind)).toEqual(['wake', 'uncallable', 'wake'])
  })
})

describe('cache keepalive context and TTL provenance', () => {
  it('backfills legacy state and updates a stop-id usage rewrite without new work', () => {
    const state = sized('backfill', 199_999)
    save(state, { lastRealId: 'baseline', lastRealAtMs: 0, lastModel: 'claude-sonnet-4-5', refreshCount: 4 })
    expect(run(state, 49).stdout).toBe('')
    append(state, assistant('baseline', 'claude-sonnet-4-5', 0, { ...HOUR, input_tokens: 250_000 }))
    expect(run(state, 50).stdout).toBe('')
    expect(saved(state)).toMatchObject({ refreshCount: 4, lastContext: { tokens: 250_001, callId: 'baseline', atMs: 0 } })
  })

  it('finds a cache writer behind the newest read-only call and separates journal metadata', () => {
    const state = sized('writer-history', 10_000)
    append(state, assistant('reader', 'claude-sonnet-4-5', 1, { cache_read_input_tokens: 20 }))
    expect(run(state, 51).stdout).toContain('CACHE KEEPALIVE:')
    append(state, assistant('refresh', 'claude-sonnet-4-5', 51.01, HOUR))
    expect(run(state, 52).stdout).toBe('')
    const refreshed = journal(state).find((entry) => entry.kind === 'refreshed')
    expect(refreshed).toMatchObject({ cacheTtl: { oneHour: true, fiveMinute: false }, usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 1 } })
    expect(Object.keys(refreshed?.usage as object).sort()).toEqual(['cacheCreation', 'cacheRead', 'input', 'output'])
    expect(saved(state).cacheEvidence).toMatchObject({ oneHour: { callId: 'refresh', atMs: 51.01 * 60_000 } })
  })
})

describe('cache keepalive pending delivery', () => {
  it('clears an orphaned pending wake as unresolved without refreshing freshness', () => {
    const state = scaffold('orphan')
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    expect(run(state, 100).stdout).toBe('')
    expect(run(state, 101).stdout).toContain('CACHE KEEPALIVE:')
    expect(journal(state).map((entry) => entry.kind)).toEqual(['wake', 'unresolved', 'wake'])
    expect(saved(state).lastRefreshedAtMs).toBeNull()
  })

  it('expires an orphaned known-TTL cache instead of treating unresolved delivery as a refresh', () => {
    const state = sized('orphan-stale', 10_000)
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    expect(run(state, 101).stdout).toBe('')
    expect(journal(state).map((entry) => entry.kind)).toEqual(['wake', 'unresolved', 'skip'])
    expect(saved(state)).toMatchObject({ lastRefreshedAtMs: null, pendingWake: null, refreshCount: 1 })
  })
})

describe('cache keepalive unknown inputs', () => {
  it('keeps unknown size and unreadable enabled settings on the existing wake path', () => {
    const unknown = sized('unknown-size', 250_000)
    append(unknown, assistant('baseline', 'claude-sonnet-4-5', 0, { ...HOUR, input_tokens: 'bad' }))
    expect(run(unknown, 50).stdout).toContain('CACHE KEEPALIVE:')
    const unreadable = sized('unknown-enabled', 250_000)
    writeFileSync(join(unreadable.configDir, 'settings.json'), '{')
    expect(run(unreadable, 50).stdout).toContain('CACHE KEEPALIVE:')
  })

  it('treats an unrepresentable context sum as unknown rather than eligible', () => {
    const state = sized('unknown-sum', 10_000)
    append(state, assistant('baseline', 'claude-sonnet-4-5', 0,
      { ...HOUR, input_tokens: Number.MAX_VALUE, cache_read_input_tokens: Number.MAX_VALUE }))
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    expect(saved(state)).toMatchObject({ lastContext: { tokens: null } })
  })
})

describe('cache keepalive managed and environment resolution', () => {
  it('resolves readable managed policy ahead of local settings, per key', async () => {
    const state = sized('managed', 250_000)
    settings(state, 'local', { idleCompaction: false, env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '320000' } })
    const managedFile = join(state.configDir, 'managed.json')
    writeFileSync(managedFile, JSON.stringify({ idleCompaction: true, env: { OTHER: 'x' } }))
    const host = await import(pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/host/cache-keepalive-settings.mjs')).href)
    expect(await host.compactionSettings(state.configDir, state.projectDir, { managedFile, env: {} }))
      .toMatchObject({ enabled: true, floor: '320000' })
    writeFileSync(managedFile, '{')
    expect(await host.compactionSettings(state.configDir, state.projectDir, { managedFile, env: {} }))
      .toMatchObject({ enabled: null })
  })

  it('resolves a monitor environment value ahead of settings env fallback', async () => {
    const state = sized('monitor-env', 250_000)
    settings(state, 'local', { env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '320000' } })
    const host = await import(pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/host/cache-keepalive-settings.mjs')).href)
    const result = await host.compactionSettings(state.configDir, state.projectDir,
      { managedFile: join(state.configDir, 'absent.json'), env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '200000' } })
    expect(result).toMatchObject({ floor: '200000' })
  })
})

describe('cache keepalive retained evidence and legacy state', () => {
  it('retains one-hour evidence over subsequent polls with five-minute writes', () => {
    const state = sized('retained-hour', 10_000)
    expect(run(state, 1).stdout).toBe('')
    append(state, assistant('five', 'claude-sonnet-4-5', 2, FIVE))
    expect(run(state, 52).stdout).toContain('CACHE KEEPALIVE:')
    expect(saved(state).cacheEvidence).toMatchObject({ oneHour: { callId: 'baseline', atMs: 0 } })
    expect(run(state, 54).stdout).toBe('')
    expect(saved(state).cacheEvidence).toMatchObject({ oneHour: { callId: 'baseline', atMs: 0 } })
  })

  it('backfills a legacy read-only stop record with an older cache writer', () => {
    const state = sized('legacy-writer', 10_000)
    append(state, assistant('reader', 'claude-sonnet-4-5', 1))
    save(state, { lastRealId: 'reader', lastRealAtMs: 60_000, lastModel: 'claude-sonnet-4-5', refreshCount: 2 })
    expect(run(state, 51).stdout).toContain('CACHE KEEPALIVE:')
    expect(saved(state)).toMatchObject({ refreshCount: 3, cacheEvidence: { oneHour: { callId: 'baseline', atMs: 0 } } })
  })
})

describe('cache keepalive stop-id TTL and platform policy locations', () => {
  it('learns a stop-id TTL rewrite without resetting the idle attempt count', () => {
    const state = sized('ttl-rewrite', 250_000, { cache_creation_input_tokens: 1 })
    save(state, { lastRealId: 'baseline', lastRealAtMs: 0, lastModel: 'claude-sonnet-4-5', refreshCount: 3, cacheEvidence: {} })
    append(state, assistant('baseline', 'claude-sonnet-4-5', 0, { ...HOUR, input_tokens: 249_999 }))
    expect(run(state, 50).stdout).toBe('')
    expect(saved(state)).toMatchObject({ refreshCount: 3, cacheEvidence: { oneHour: { callId: 'baseline', atMs: 0 } } })
  })

  it('uses portable managed-file locations and names unsupported policy as unknown', async () => {
    const host = await import(pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/host/cache-keepalive-settings.mjs')).href)
    expect(managedReadPaths('linux').files[0]).toBe('/etc/claude-code/managed-settings.json')
    expect(managedReadPaths('darwin').files[0]).toBe('/Library/Application Support/ClaudeCode/managed-settings.json')
    expect(managedReadPaths('win32', { ProgramFiles: 'D:\\Programs' }).files[0]).toBe('D:\\Programs\\ClaudeCode\\managed-settings.json')
    const state = sized('unknown-platform', 250_000)
    expect(await host.compactionSettings(state.configDir, state.projectDir, { platform: 'unsupported', env: {} }))
      .toMatchObject({ enabled: null })
  })
})

// Counts the bytes callsSince reads through the real file handle, in a separate process.
function scanReads(transcriptPath: string, stopId: string | null, change?: { append?: string, rewrite?: string }) {
  const url = pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/host/cache-keepalive-transcript.mjs')).href
  const script = `import fs from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    const original = fs.open
    let bytesRead = 0
    fs.open = async (...args) => {
      const handle = await original(...args)
      return { stat: () => handle.stat(), close: () => handle.close(),
        read: async (...readArgs) => { const result = await handle.read(...readArgs); bytesRead += result.bytesRead; return result } }
    }
    syncBuiltinESMExports()
    const host = await import(${JSON.stringify(url)})
    const file = ${JSON.stringify(transcriptPath)}, stopId = ${JSON.stringify(stopId)}
    let result = await host.callsSince(file, stopId, false)
    const initialBytes = bytesRead, modes = [result.mode], change = ${JSON.stringify(change) ?? 'undefined'}
    if (change) {
      if (change.append !== undefined) await fs.appendFile(file, change.append)
      if (change.rewrite !== undefined) await fs.writeFile(file, change.rewrite)
      bytesRead = 0
      result = await host.callsSince(file, stopId, { cursor: result.cursor })
      modes.push(result.mode)
      const incrementalBytes = bytesRead
      const next = await host.callsSince(file, stopId, { cursor: result.cursor })
      modes.push(next.mode)
      bytesRead = incrementalBytes
    }
    const { size } = await fs.stat(file)
    console.log(JSON.stringify({ bytesRead, initialBytes, size, modes, reset: result.reset,
      calls: result.calls.map((call) => call.id), evidence: result.evidence, cursor: result.cursor,
      oneHour: result.evidence.oneHour?.callId ?? null }))`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as { bytesRead: number, initialBytes: number, size: number, calls: string[],
    oneHour: string | null, evidence: object, modes: string[], reset: boolean, cursor: { offset: number, size: number } }
}

function managedReadPaths(platform: string, env = {}) {
  const url = pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/host/cache-keepalive-settings.mjs')).href
  const script = `import fs from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    const files = []
    fs.readFile = async (file) => { files.push(file); return '{}' }
    syncBuiltinESMExports()
    const host = await import(${JSON.stringify(url)})
    await host.compactionSettings('config', 'project', ${JSON.stringify({ platform, env })})
    console.log(JSON.stringify({ files }))`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  return JSON.parse(result.stdout) as { files: string[] }
}

describe('cache keepalive incremental streamed writers', () => {
  it('retains a writer behind the final record of an already-established stop id', () => {
    const state = sized('incremental-stream', 250_000, { cache_creation_input_tokens: 1 })
    expect(run(state, 1).stdout).toBe('')
    expect(saved(state)).toMatchObject({ lastRealId: 'baseline', cacheEvidence: {} })
    append(state, assistant('baseline', 'claude-sonnet-4-5', 0, { ...HOUR, input_tokens: 249_999 }))
    append(state, assistant('baseline', 'claude-sonnet-4-5', 0, { input_tokens: 250_000 }))
    expect(run(state, 50).stdout).toBe('')
    expect(saved(state).cacheEvidence).toMatchObject({ oneHour: { callId: 'baseline', atMs: 0 } })
  })

  it('collects streamed evidence for newer calls even when their records are interleaved', () => {
    const state = sized('interleaved-stream', 250_000, { cache_creation_input_tokens: 1 })
    expect(run(state, 1).stdout).toBe('')
    append(state, assistant('newer', 'claude-sonnet-4-5', 2, { ...HOUR, input_tokens: 249_999 }))
    append(state, assistant('baseline', 'claude-sonnet-4-5', 0))
    append(state, assistant('newer', 'claude-sonnet-4-5', 2, { input_tokens: 250_000 }))
    expect(run(state, 52).stdout).toBe('')
    expect(saved(state).cacheEvidence).toMatchObject({ oneHour: { callId: 'newer', atMs: 120_000 } })
  })

  it('stops an incremental poll after the saved boundary instead of reading the whole history', () => {
    const state = sized('bounded-scan', 250_000)
    const history = Array.from({ length: 4000 }, (_, index) => assistant(`old-${index}`, 'claude-sonnet-4-5', 0))
    writeFileSync(state.transcriptPath, `${[...history,
      assistant('stop', 'claude-sonnet-4-5', 1, { ...HOUR, input_tokens: 249_998 }),
      assistant('stop', 'claude-sonnet-4-5', 1, { input_tokens: 249_999 }),
      assistant('newer', 'claude-sonnet-4-5', 2, { input_tokens: 250_000 })].join('\n')}\n`)
    const scan = scanReads(state.transcriptPath, 'stop')
    expect(scan.size).toBeGreaterThan(800_000)
    expect(scan.bytesRead).toBeGreaterThan(0)
    expect(scan.bytesRead).toBeLessThan(scan.size / 4)
    expect(scan.calls).toEqual(['stop', 'newer'])
    expect(scan.oneHour).toBe('stop')
  })
})

describe('cache keepalive model-scoped evidence', () => {
  it.each([10_000, 250_000])('does not reuse another model cache at context %i', (context) => {
    const state = sized('model-change', context)
    expect(run(state, 1).stdout).toBe('')
    append(state, assistant('other-model', 'claude-opus-4-6', 120, { ...FIVE, input_tokens: context - 1 }))
    expect(run(state, 170).stdout).toBe('')
    expect(journal(state).at(-1)?.reason).toBe('prompt cache freshness expired')
    expect(saved(state)).toMatchObject({ cacheEvidenceModel: 'claude-opus-4-6',
      cacheEvidence: { fiveMinute: { callId: 'other-model', atMs: 120 * 60_000 } } })
    expect(saved(state).cacheEvidence).not.toHaveProperty('oneHour')
  })

  it('scopes initial discovery history to the newest real model', () => {
    const state = sized('model-history', 250_000)
    append(state, assistant('other-model', 'claude-opus-4-6', 120, { ...FIVE, input_tokens: 249_999 }))
    expect(run(state, 170).stdout).toBe('')
    expect(journal(state).at(-1)?.reason).toBe('prompt cache freshness expired')
  })

  it('migrates legacy evidence using its writer rather than the latest model', () => {
    const state = sized('legacy-model', 10_000)
    save(state, { lastRealId: 'baseline', lastRealAtMs: 0, lastModel: 'claude-sonnet-4-5',
      cacheEvidence: { oneHour: { callId: 'baseline', atMs: 0 } } })
    append(state, assistant('b', 'claude-opus-4-6', 120, { ...FIVE, input_tokens: 9_999 }))
    expect(run(state, 170).stdout).toBe('')
    expect(journal(state).at(-1)?.reason).toBe('prompt cache freshness expired')
    expect(saved(state)).toMatchObject({ cacheEvidenceModel: 'claude-opus-4-6',
      cacheEvidence: { fiveMinute: { callId: 'b', atMs: 120 * 60_000 } } })
  })
})

describe('cache keepalive unknown freshness and malformed usage', () => {
  it.each([undefined, 'not-a-time'])('does not expire an unknown latest timestamp %j across restarts', (timestamp) => {
    const state = sized('unknown-time', 10_000)
    expect(run(state, 1).stdout).toBe('')
    const fresh = JSON.parse(assistant('unknown-time', 'claude-sonnet-4-5', 120, HOUR)) as Record<string, unknown>
    fresh.timestamp = timestamp
    append(state, JSON.stringify(fresh))
    expect(run(state, 120).stdout).toContain('CACHE KEEPALIVE:')
    expect(saved(state).lastRealAtMs).toBeNull()
    expect(run(state, 171).stdout).toContain('CACHE KEEPALIVE:')
    expect(journal(state).some((entry) => entry.reason === 'prompt cache freshness expired')).toBe(false)
    append(state, assistant('known-time', 'claude-sonnet-4-5', 180, HOUR))
    expect(run(state, 241).stdout).toBe('')
    expect(journal(state).at(-1)?.reason).toBe('prompt cache freshness expired')
    expect(saved(state).lastRealAtMs).toBe(180 * 60_000)
  })

  it.each(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])(
    'ignores malformed historical %s without making the transcript unavailable', (key) => {
      const state = scaffold('malformed-history')
      writeFileSync(state.transcriptPath, `${assistant('old', 'claude-sonnet-4-5', 0,
        { [key]: { valueOf: 0, toString: 0 } })}\n${assistant('recent', 'claude-sonnet-4-5', 120)}\n`)
      expect(run(state, 170).stdout).toContain('CACHE KEEPALIVE:')
      expect(journal(state).some((entry) => String(entry.reason).startsWith('transcript unavailable:'))).toBe(false)
    })

  it.each(['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens'])('rejects non-finite %s TTL evidence', (key) => {
    const state = sized('nonfinite-ttl', 250_000, {})
    const line = assistant('baseline', 'claude-sonnet-4-5', 0,
      { input_tokens: 250_000, cache_creation: { [key]: 1 } }).replace(`"${key}":1`, `"${key}":1e400`)
    writeFileSync(state.transcriptPath, `${line}\n`)
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    expect(saved(state).cacheEvidence).toEqual({})
  })
})

// Documented on/off and set-or-unset spellings, with the expected wake for each.
const FETCH_SWITCH_CASES = [
  ['DISABLE_GROWTHBOOK', '1', true], ['DISABLE_GROWTHBOOK', 'true', true],
  ['DISABLE_GROWTHBOOK', '0', false], ['DISABLE_GROWTHBOOK', 'false', false],
  ['DISABLE_GROWTHBOOK', '', false],
  ['DISABLE_TELEMETRY', '1', true], ['DISABLE_TELEMETRY', '0', true],
  ['DISABLE_TELEMETRY', 'false', true], ['DISABLE_TELEMETRY', '', false],
  ['DO_NOT_TRACK', '1', true], ['DO_NOT_TRACK', 'true', true],
  ['DO_NOT_TRACK', '0', false], ['DO_NOT_TRACK', 'false', false],
  ['DO_NOT_TRACK', '', false],
  ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1', true],
  ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '0', true],
  ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'false', true],
  ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '', false],
  ['DO_NOT_TRACK', 'maybe', true], ['DISABLE_GROWTHBOOK', 'maybe', true],
] as const

describe('cache keepalive feature-flag fetching prerequisites', () => {
  it.each(FETCH_SWITCH_CASES)('uses documented fetching semantics for %s=%j (wake=%s)', (key, value, wake) => {
    expect(run(sized('fetch-switch', 250_000), 50, { [key]: value }).stdout.includes('CACHE KEEPALIVE:')).toBe(wake)
  })

  it.each(PROVIDER_KEYS)('handles %s on, off, unknown and host-managed', (key) => {
    for (const [value, managed, wake] of [
      ['1', undefined, true], ['true', undefined, true], ['0', undefined, false],
      ['false', undefined, false], ['', undefined, false], ['maybe', undefined, true],
      ['1', '1', false], ['maybe', '1', false],
    ] as const) {
      const state = sized('fetch-provider', 250_000)
      expect(run(state, 50, { [key]: value, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: managed })
        .stdout.includes('CACHE KEEPALIVE:'), `${key}=${value}, host=${managed}`).toBe(wake)
    }
  })

  it.each([undefined, '0'] as const)('resolves fetching switches per key with monitor override %j', (override) => {
    const state = sized('fetch-precedence', 250_000)
    settings(state, 'user', { env: { DISABLE_GROWTHBOOK: '1', DO_NOT_TRACK: '1' } })
    settings(state, 'project', { env: { DISABLE_GROWTHBOOK: '0' } })
    settings(state, 'local', { env: { OTHER: 'unrelated' } })
    expect(run(state, 50, { DO_NOT_TRACK: override }).stdout.includes('CACHE KEEPALIVE:')).toBe(override === undefined)
  })

  it('reads provider and host-managed switches from separate settings env layers', () => {
    const state = sized('fetch-host-settings', 250_000)
    settings(state, 'user', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } })
    settings(state, 'local', { env: { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' } })
    expect(run(state, 50).stdout).toBe('')
    expect(journal(state).at(-1)?.reason).toBe('native idle compaction applies')
  })
})

describe('cache keepalive legacy pending outcomes', () => {
  it('backfills a legacy pending outcome without losing subsequent real work', () => {
    const state = sized('legacy-pending', 10_000)
    save(state, { lastRealId: 'baseline', lastRealAtMs: 0, lastModel: 'claude-sonnet-4-5', refreshCount: 1,
      lastWakeAtMs: 50 * 60_000, pendingWake: { atMs: 50 * 60_000, model: 'claude-sonnet-4-5' } })
    append(state, assistant('refresh', 'claude-sonnet-4-5', 50.01))
    append(state, assistant('work', 'claude-sonnet-4-5', 70))
    expect(run(state, 75).stdout).toBe('')
    expect(journal(state).find((entry) => entry.kind === 'refreshed')?.wakeAt).toBe(new Date(50 * 60_000).toISOString())
    expect(saved(state)).toMatchObject({ refreshCount: 0, lastRealId: 'work',
      lastRefreshedAtMs: 50.01 * 60_000, cacheEvidence: { oneHour: { callId: 'baseline', atMs: 0 } } })
  })

  it('persists backfilled metadata even after the cap was already journaled', () => {
    const state = sized('legacy-capped', 10_000)
    save(state, { lastRealId: 'baseline', lastRealAtMs: 0, lastModel: 'claude-sonnet-4-5', refreshCount: 10, cappedLogged: true })
    expect(run(state, 50).stdout).toBe('')
    expect(saved(state)).toMatchObject({ refreshCount: 10, cappedLogged: true,
      lastContext: { tokens: 10_000, callId: 'baseline', atMs: 0 }, cacheEvidence: { oneHour: { callId: 'baseline', atMs: 0 } } })
  })
})

describe('cache keepalive streamed writer evidence', () => {
  it('retains a writer from an earlier streamed record with the newest call id', () => {
    const state = sized('stream-writer', 10_000)
    append(state, assistant('baseline', 'claude-sonnet-4-5', 1, { cache_read_input_tokens: 250_000 }))
    expect(run(state, 51).stdout).toBe('')
    expect(saved(state)).toMatchObject({ lastContext: { tokens: 250_001, callId: 'baseline', atMs: 60_000 },
      cacheEvidence: { oneHour: { callId: 'baseline', atMs: 0 } } })
  })

  it('keeps the newest writer record when timestamps tie', () => {
    const state = sized('writer-tie', 10_000)
    append(state, assistant('second', 'claude-sonnet-4-5', 0, HOUR))
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    expect(saved(state).cacheEvidence).toMatchObject({ oneHour: { callId: 'second', atMs: 0 } })
  })
})

describe('cache keepalive unreadable managed aliases', () => {
  it.skipIf(process.platform === 'win32')('treats a dangling managed settings link as unknown', async () => {
    // Windows file symlinks can require privileges; the other reader cases are portable.
    const state = sized('managed-alias', 250_000)
    const file = join(state.configDir, 'managed.json')
    symlinkSync('missing-managed-policy.json', file)
    const host = await import(pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/host/cache-keepalive-settings.mjs')).href)
    expect(await host.compactionSettings(state.configDir, state.projectDir, { managedFile: file, env: {} }))
      .toMatchObject({ enabled: null })
  })
})

function nonAssistantHistory(records: number) {
  return Array.from({ length: records }, (_, index) => JSON.stringify({
    type: ['user', 'tool_result', 'progress'][index % 3], content: 'x'.repeat(1000),
  })).join('\n') + '\n'
}

function withoutTimestamp(id: string, atMinutes: number) {
  const record = JSON.parse(assistant(id, 'claude-sonnet-4-5', atMinutes)) as Record<string, unknown>
  delete record.timestamp
  return JSON.stringify(record)
}

function registerCursorAppendLocks() {
  it('reads only appended bytes plus one chunk after user/tool/progress-only history', () => {
    const state = scaffold('non-assistant-history')
    writeFileSync(state.transcriptPath, nonAssistantHistory(3000) + assistant('a', 'claude-sonnet-4-5', 0) + '\n')
    const appended = JSON.stringify({ type: 'progress', content: 'next' }) + '\n'
    const scan = scanReads(state.transcriptPath, 'a', { append: appended })
    console.info(`cursor user/tool history: size=${scan.size} bytesRead=${scan.bytesRead} appended=${Buffer.byteLength(appended)}`)
    expect(scan.bytesRead).toBeGreaterThan(0)
    expect(scan.bytesRead).toBeLessThanOrEqual(Buffer.byteLength(appended) + 65_536)
    expect(scan.modes).toEqual(['discovery', 'incremental', 'incremental'])
  })

  it.each(['<synthetic>', 'claude-sonnet-4-5'])('keeps a writer separated from its final record by %s', (separator) => {
    const state = sized('separated-writer', 250_000, {})
    expect(run(state, 1).stdout).toBe('')
    append(state, assistant('baseline', 'claude-sonnet-4-5', 0, HOUR))
    append(state, assistant('x', separator, 0))
    append(state, assistant('baseline', 'claude-sonnet-4-5', 0, { input_tokens: 250_000 }))
    expect(run(state, 50).stdout).toBe('')
    expect(saved(state)).toMatchObject({ lastRealId: 'baseline', lastContext: { tokens: 250_000 },
      cacheEvidence: { oneHour: { callId: 'baseline', atMs: 0 } } })
  })

  it('keeps synthetic-interleaved writer evidence when the final record arrives in the next poll', () => {
    const state = sized('cross-poll-writer', 250_000, {})
    expect(run(state, 1).stdout).toBe('')
    append(state, assistant('baseline', 'claude-sonnet-4-5', 0, HOUR))
    append(state, assistant('x', '<synthetic>', 0))
    expect(run(state, 2).stdout).toBe('')
    append(state, assistant('baseline', 'claude-sonnet-4-5', 0, { input_tokens: 250_000 }))
    expect(run(state, 50).stdout).toBe('')
    expect(saved(state).cacheEvidence).toMatchObject({ oneHour: { callId: 'baseline', atMs: 0 } })
  })

}

function registerTruncationLocks() {
  it('forgets the saved activity when the transcript is truncated, so an emptied file never wakes', () => {
    const state = scaffold('truncated-to-empty')
    expect(run(state, 1).stdout).toBe('')
    writeFileSync(state.transcriptPath, '')
    expect(run(state, 50).stdout).toBe('')
    expect(saved(state)).toMatchObject({ lastRealId: '', lastRealAtMs: null, lastCadenceAtMs: null })
  })

  it('re-reads a transcript truncated and regrown past the old offset, and anchors on its own calls', () => {
    const state = scaffold('truncated-regrown')
    writeFileSync(state.transcriptPath, nonAssistantHistory(5) + assistant('a', 'claude-sonnet-4-5', 0) + '\n')
    expect(run(state, 1).stdout).toBe('')
    const oldSize = Buffer.byteLength(readFileSync(state.transcriptPath))
    writeFileSync(state.transcriptPath, assistant('b', 'claude-sonnet-4-5', 10) + '\n' + nonAssistantHistory(10))
    expect(Buffer.byteLength(readFileSync(state.transcriptPath))).toBeGreaterThan(oldSize)
    expect(run(state, 55).stdout).toBe('')
    expect(saved(state)).toMatchObject({ lastRealId: 'b', lastCadenceAtMs: 10 * 60_000 })
    expect(run(state, 61).stdout).toContain('CACHE KEEPALIVE:')
  })

  it('does not carry the old attempt cap, wake or refresh into a replaced transcript', () => {
    const state = scaffold('replaced-keeps-nothing')
    expect(run(state, 1).stdout).toBe('')
    save(state, { ...saved(state), refreshCount: 10, cappedLogged: true, lastWakeAtMs: 50 * 60_000, lastRefreshedAtMs: 51 * 60_000 })
    writeFileSync(state.transcriptPath, `${assistant('b', 'claude-sonnet-4-5', 10, HOUR)}\n`)
    expect(run(state, 60).stdout).toContain('CACHE KEEPALIVE:')
  })
}

function registerCursorRecoveryLocks() {
  it.each(['truncation', 'same-size rewrite'])('rediscovers after %s', (kind) => {
    const state = scaffold('rewritten-cursor')
    const original = assistant('a', 'claude-sonnet-4-5', 0, HOUR) + '\n'
    writeFileSync(state.transcriptPath, kind === 'truncation' ? nonAssistantHistory(100) + original : original)
    const rewritten = assistant('b', 'claude-sonnet-4-5', 1, HOUR) + '\n'
    if (kind === 'same-size rewrite') expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original))
    const scan = scanReads(state.transcriptPath, 'a', { rewrite: rewritten })
    expect(scan.modes).toEqual(['discovery', 'discovery', 'incremental'])
    expect(scan.reset).toBe(true)
    expect(scan.calls).toEqual(['b'])
    expect(scan.oneHour).toBe('b')
  })

  it('discovers legacy state once, then consumes subsequent polls incrementally', () => {
    const state = sized('legacy-cursor', 10_000)
    save(state, { lastRealId: 'baseline', lastRealAtMs: 0, lastModel: 'claude-sonnet-4-5', cacheEvidence: {} })
    expect(run(state, 1).stdout).toBe('')
    expect(saved(state).transcriptCursor).toMatchObject({ size: Buffer.byteLength(readFileSync(state.transcriptPath)) })
    const scan = scanReads(state.transcriptPath, 'baseline', { append: '' })
    expect(scan.modes).toEqual(['discovery', 'incremental', 'incremental'])
    expect(scan.bytesRead).toBeGreaterThan(0)
    expect(scan.bytesRead).toBeLessThanOrEqual(4096)
  })

}

function registerDiscoveryBudgetLocks() {
  it('bounds initial discovery and finds a recent decisive streamed writer in a larger history', () => {
    const state = scaffold('bounded-discovery')
    writeFileSync(state.transcriptPath, nonAssistantHistory(6000)
      + assistant('a', 'claude-sonnet-4-5', 0, { ...HOUR, input_tokens: 249_999 }) + '\n'
      + assistant('a', 'claude-sonnet-4-5', 0, { input_tokens: 250_000 }) + '\n')
    const scan = scanReads(state.transcriptPath, 'a')
    console.info(`cursor initial discovery: size=${scan.size} bytesRead=${scan.bytesRead}`)
    expect(scan.size).toBeGreaterThan(4 * 1024 * 1024)
    expect(scan.bytesRead).toBeGreaterThan(0)
    expect(scan.bytesRead).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(scan.oneHour).toBe('a')
    expect(run(state, 50).stdout).toBe('')
    expect(journal(state).at(-1)?.reason).toBe('native idle compaction applies')
  })

  it('leaves TTL unknown when the discovery budget cannot establish the longest TTL', () => {
    const state = scaffold('budget-unknown')
    writeFileSync(state.transcriptPath, nonAssistantHistory(6000)
      + assistant('a', 'claude-sonnet-4-5', 0, FIVE) + '\n')
    const scan = scanReads(state.transcriptPath, 'a')
    expect(scan.bytesRead).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(scan.evidence).toEqual({})
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
  })

  it('stops discovery after passing records older than two longest TTLs', () => {
    const state = scaffold('age-bound')
    writeFileSync(state.transcriptPath, nonAssistantHistory(3000)
      + assistant('old', 'claude-sonnet-4-5', 0, HOUR) + '\n'
      + assistant('a', 'claude-sonnet-4-5', 121) + '\n')
    const scan = scanReads(state.transcriptPath, null)
    expect(scan.bytesRead).toBeLessThanOrEqual(65_536)
    expect(scan.evidence).toEqual({})
  })

}

function registerUnfinishedLineLock() {
  it('persists an unterminated UTF-8 tail and consumes its completion exactly once', () => {
    const state = scaffold('partial-line')
    expect(run(state, 1).stdout).toBe('')
    const record = assistant('new', 'claude-sonnet-4-5', 2, HOUR).replace('"type"', '"label":"é😀","type"')
    const bytes = Buffer.from(record)
    const split = bytes.indexOf(Buffer.from('😀')) + 1
    writeFileSync(state.transcriptPath, Buffer.concat([readFileSync(state.transcriptPath), bytes.subarray(0, split)]))
    expect(run(state, 2).stdout).toBe('')
    expect(saved(state).transcriptCursor).toMatchObject({ offset: Buffer.byteLength(assistant('baseline', 'claude-sonnet-4-5', 0) + '\n') })
    writeFileSync(state.transcriptPath, Buffer.concat([readFileSync(state.transcriptPath), bytes.subarray(split), Buffer.from('\n')]))
    expect(run(state, 3).stdout).toBe('')
    expect(saved(state)).toMatchObject({ lastRealId: 'new', cacheEvidence: { oneHour: { callId: 'new' } } })
    expect(run(state, 4).stdout).toBe('')
    expect(saved(state).lastRealId).toBe('new')
  })
}

describe('cache keepalive consumed transcript cursor', () => {
  registerCursorAppendLocks()
  registerCursorRecoveryLocks()
  registerTruncationLocks()
  registerDiscoveryBudgetLocks()
  registerUnfinishedLineLock()
})

function registerCadenceLocks() {
  it('keeps the known cadence anchor when a newer real call has unknown freshness', () => {
    const state = scaffold('unknown-cadence')
    writeFileSync(state.transcriptPath, assistant('a', 'claude-sonnet-4-5', 100) + '\n')
    expect(run(state, 101).stdout).toBe('')
    append(state, withoutTimestamp('b', 102))
    expect(run(state, 102).stdout).toBe('')
    expect(saved(state)).toMatchObject({ lastRealAtMs: null, lastCadenceAtMs: 100 * 60_000 })
  })

  it('updates the saved timestamp when an already-consumed call id is rewritten', () => {
    const state = sized('saved-time-rewrite', 10_000)
    expect(run(state, 1).stdout).toBe('')
    append(state, assistant('baseline', 'claude-sonnet-4-5', 100, HOUR))
    expect(run(state, 101).stdout).toBe('')
    expect(saved(state).lastRealAtMs).toBe(100 * 60_000)
    expect(run(state, 150).stdout).toContain('CACHE KEEPALIVE:')
  })

}

function registerReturningModelLock() {
  it('returns to a model with the same evidence and verdict as fresh discovery', () => {
    const state = sized('return-model', 250_000)
    expect(run(state, 1).stdout).toBe('')
    append(state, assistant('b', 'claude-opus-4-6', 10))
    expect(run(state, 11).stdout).toBe('')
    append(state, assistant('a-return', 'claude-sonnet-4-5', 20, { input_tokens: 250_000 }))
    expect(run(state, 21).stdout).toBe('')
    const persisted = run(state, 70).stdout
    const evidence = saved(state).cacheEvidence
    expect(persisted).toBe('')
    expect(evidence).toMatchObject({ oneHour: { callId: 'baseline', atMs: 0 } })
    rmSync(state.journalDir, { recursive: true })
    expect(run(state, 70).stdout).toBe(persisted)
    expect(saved(state).cacheEvidence).toEqual(evidence)
    expect(journal(state).at(-1)?.reason).toBe('native idle compaction applies')
  })

}

function registerLegacyOwnerLocks() {
  it.each([true, false])('resolves legacy evidence ownership with lastModel present=%s', (hasModel) => {
    const state = sized('legacy-owner', 10_000, {}, 'claude-opus-4-6')
    save(state, { lastRealId: 'baseline', lastRealAtMs: 0,
      ...(hasModel ? { lastModel: 'claude-sonnet-4-5' } : {}),
      cacheEvidence: { oneHour: { callId: 'missing-writer', atMs: 0 } } })
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    expect(saved(state).cacheEvidence).toEqual({})
    expect(saved(state).cacheEvidenceByModel).toEqual(hasModel
      ? { 'claude-sonnet-4-5': { oneHour: { callId: 'missing-writer', atMs: 0 } }, 'claude-opus-4-6': {} }
      : { 'claude-opus-4-6': {} })
  })

  it('uses transcript writer provenance before a contradictory legacy lastModel', () => {
    const state = sized('legacy-owner-conflict', 10_000)
    append(state, assistant('b', 'claude-opus-4-6', 120, { ...FIVE, input_tokens: 9_999 }))
    save(state, { lastRealId: 'baseline', lastRealAtMs: 0, lastModel: 'claude-opus-4-6',
      cacheEvidence: { oneHour: { callId: 'baseline', atMs: 0 } } })
    expect(run(state, 170).stdout).toBe('')
    expect(saved(state).cacheEvidence).not.toHaveProperty('oneHour')
    expect(journal(state).at(-1)?.reason).toBe('prompt cache freshness expired')
  })

}

function registerModelCapLock() {
  it('caps retained models at 32 and keeps the latest model', () => {
    const state = scaffold('model-cap')
    expect(run(state, 1).stdout).toBe('')
    for (let index = 0; index < 34; index += 1) {
      append(state, assistant(`call-${index}`, `claude-model-${index}`, index + 2, HOUR))
    }
    expect(run(state, 36).stdout).toBe('')
    const models = saved(state).cacheEvidenceByModel as Record<string, unknown>
    expect(Object.keys(models)).toHaveLength(32)
    expect(models).toHaveProperty('claude-model-33')
    expect(models).not.toHaveProperty('claude-sonnet-4-5')
  })
}

describe('cache keepalive cadence and model retention', () => {
  registerCadenceLocks()
  registerReturningModelLock()
  registerLegacyOwnerLocks()
  registerModelCapLock()
})

describe('cache keepalive documented fetching values', () => {
  const rows = [
    ['off', true], ['FALSE', true], ['No', true], ['ON', false], ['Yes', false], ['maybe', null], ['', true],
  ] as const
  it.each(['DISABLE_GROWTHBOOK', 'DO_NOT_TRACK', ...PROVIDER_KEYS])('reads boolean values directly for %s', async (key) => {
    const state = sized('boolean-reader', 250_000)
    const host = await import(pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/host/cache-keepalive-settings.mjs')).href)
    for (const [value, fetching] of rows) {
      const env = { [key]: value }
      const reading = await host.compactionSettings(state.configDir, state.projectDir,
        { managedFile: join(state.configDir, 'absent.json'), env })
      expect(reading.fetching, `${key}=${value}`).toBe(fetching)
      const isolated = sized('boolean-wake', 250_000)
      expect(run(isolated, 50, env).stdout.includes('CACHE KEEPALIVE:'), `${key}=${value}`).toBe(fetching !== true)
    }
  })

  it.each(['DISABLE_TELEMETRY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'])('reads empty and nonempty set-or-unset %s directly', async (key) => {
    const state = scaffold('set-unset-reader')
    const host = await import(pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/host/cache-keepalive-settings.mjs')).href)
    for (const value of ['', '0', 'false', 'maybe']) {
      const reading = await host.compactionSettings(state.configDir, state.projectDir,
        { managedFile: join(state.configDir, 'absent.json'), env: { [key]: value } })
      expect(reading.fetching, `${key}=${value}`).toBe(value === '')
    }
  })
})

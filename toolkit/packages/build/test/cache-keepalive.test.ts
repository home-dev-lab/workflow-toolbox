import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const MONITOR = join(REPO_ROOT, 'plugin/bin/wt-cache-keepalive.mjs')
const MONITORS_JSON = join(REPO_ROOT, 'plugin/monitors/monitors.json')
const roots: string[] = []

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
  return { configDir, journalDir, projectDir, sessionId, transcriptPath }
}

function run(state: ReturnType<typeof scaffold>, nowMinutes: number, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [MONITOR, '--once', '--now', String(nowMinutes * 60_000), '--project', state.projectDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: state.sessionId,
      CLAUDE_CONFIG_DIR: state.configDir,
      WT_CACHE_KEEPALIVE_ENABLED: 'true',
      WT_CACHE_KEEPALIVE_JOURNAL_DIR: state.journalDir,
      ...extraEnv,
    },
  })
}

function append(state: ReturnType<typeof scaffold>, line: string): void {
  writeFileSync(state.transcriptPath, `${readFileSync(state.transcriptPath, 'utf8')}${line}\n`)
}

function journal(state: ReturnType<typeof scaffold>): Array<Record<string, unknown>> {
  return readFileSync(join(state.journalDir, `${state.sessionId}.jsonl`), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('wt-cache-keepalive', () => {
  it('is off by default even though the monitor is always registered', () => {
    const state = scaffold('off')
    const result = spawnSync(process.execPath, [MONITOR, '--once', '--now', String(60 * 60_000), '--project', state.projectDir], {
      encoding: 'utf8',
      // The ambient opt-in must not leak in: a machine with the keepalive enabled would otherwise fail this default-off check.
      env: { ...process.env, WT_CACHE_KEEPALIVE_ENABLED: undefined, CLAUDE_CODE_SESSION_ID: state.sessionId, CLAUDE_CONFIG_DIR: state.configDir },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
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
    const state = scaffold('synthetic')
    expect(run(state, 50).stdout).toContain('CACHE KEEPALIVE:')
    expect(run(state, 75).stdout).toBe('')
    append(state, assistant('synthetic', '<synthetic>', 50.01, { input_tokens: 0, output_tokens: 0 }))
    expect(run(state, 99).stdout).toBe('')
    expect(journal(state).some((entry) => entry.kind === 'uncallable')).toBe(true)
    expect(run(state, 100).stdout).toContain('CACHE KEEPALIVE:')
    expect(journal(state).at(-1)).toMatchObject({ kind: 'wake', refreshCount: 2 })
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
    expect(help.stdout).toContain('WT_CACHE_KEEPALIVE_ENABLED=true')
    expect(badClock.status).toBe(2)
    expect(badClock.stderr).toContain('--now requires --once')
  })
})

describe('monitors.json registers cache-keepalive', () => {
  it('points at the executable and loads it for every session start', () => {
    const monitors = JSON.parse(readFileSync(MONITORS_JSON, 'utf8')) as Array<{ name: string; command: string; when: string }>
    const entry = monitors.find((monitor) => monitor.name === 'cache-keepalive')
    expect(entry?.command).toContain('wt-cache-keepalive.mjs')
    expect(entry?.when).toBe('always')
  })
})

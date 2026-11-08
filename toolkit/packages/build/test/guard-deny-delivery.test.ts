import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HELPER = fileURLToPath(new URL('./helpers/guard-deny-replay.mjs', import.meta.url))
const GUARDS = ['right-sized-spawn', 'plugin-release-record', 'concurrent-test', 'grounding-pre-send', 'release-push-evidence']
const DELIVERING = new Set(['plugin-release-record', 'release-push-evidence'])
const MAIN_BYTES: Record<string, string> = {
  'right-sized-spawn': '59c087b559dc6e77f93b72f7a88406799c2bb73aea62870cbfe0c4aec1701f78',
  'plugin-release-record': '8cfd97dbd8e5f84b6b7fda900fd6d2810527e3f8f913b2a179706294f113e6ff',
  'concurrent-test': '87cd5252f6eca7231c2e2249b7a01fd1240c5f1f5f4b031ec414598c18b51e36',
  'grounding-pre-send': '1b6ef6bb5335ec1ca129b8a3cdd78486ca37e2332ae8cdb6f547cfdb2821aaf6',
  'release-push-evidence': 'd8253355d5f4aeef2a5e95c8ace0d0b73e2a1401f4673f1f3aacde3c578faeff',
}
interface Replay { guard: string; actor: string; status: number; stdout: string; stderr: string; journal: string }
let enforced: Replay[]
let observed: Replay[]

function replay(mode: string): Replay[] {
  const script = `import { replayGuardCases } from ${JSON.stringify(pathToFileURL(HELPER).href)}; console.log(JSON.stringify(replayGuardCases(${JSON.stringify(ROOT)}, ${JSON.stringify(mode)})))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as Replay[]
}

beforeAll(() => { enforced = replay('enforce'); observed = replay('observe') })

describe('real guard processes: delegate denials and journal truth', () => {
  it.each(GUARDS)('%s delivers a deny only under its explicit delegate policy', (guard) => {
    const row = enforced.find((row) => row.guard === guard && row.actor === 'delegate')!
    expect(row.status).toBe(0)
    expect(row.stderr).toBe('')
    const record = JSON.parse(row.journal) as { decision: string; class: string }
    expect(record.decision).toBe(DELIVERING.has(guard) ? 'blocked' : 'silent')
    if (DELIVERING.has(guard)) {
      expect(JSON.parse(row.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    } else {
      expect(row.stdout).toBe('')
      expect(row.journal).not.toContain('"decision":"blocked"')
    }
    if (guard === 'grounding-pre-send') expect(record.class).toBe('would-refuse')
  })

  it.each(GUARDS)('%s preserves the pristine main-session stdout bytes', (guard) => {
    const row = enforced.find((row) => row.guard === guard && row.actor === 'main')!
    expect(row.status).toBe(0)
    expect(row.stderr).toBe('')
    const stdout = process.platform === 'win32' && guard === 'concurrent-test'
      ? row.stdout.replace('process enumeration is not supported on Windows', '`ps` is unavailable') : row.stdout
    expect(createHash('sha256').update(stdout).digest('hex')).toBe(MAIN_BYTES[guard])
    expect(JSON.parse(row.journal).decision).toBe('blocked')
  })
})

describe('real guard processes: observe mode keeps journal decisions truthful', () => {
  it.each(GUARDS)('%s journals muted delegate denials as silent in observe mode', (guard) => {
    const row = observed.find((row) => row.guard === guard && row.actor === 'delegate')!
    expect(row.status).toBe(0)
    expect(row.stdout).toBe('')
    expect(JSON.parse(row.journal).decision).toBe('silent')
  })

  it.each(GUARDS.filter((guard) => guard !== 'right-sized-spawn'))('%s keeps muted main-session refusals silent in stdout and journal', (guard) => {
    const row = observed.find((row) => row.guard === guard && row.actor === 'main')!
    expect(row.status).toBe(0)
    expect(row.stdout).toBe('')
    expect(JSON.parse(row.journal).decision).toBe('silent')
  })

  it('preserves the existing main-session spawn refusal even in observe mode', () => {
    const main = observed.find((row) => row.guard === 'right-sized-spawn' && row.actor === 'main')!
    expect(main.stdout).toBe(enforced.find((row) => row.guard === 'right-sized-spawn' && row.actor === 'main')!.stdout)
    expect(JSON.parse(main.journal).decision).toBe('blocked')
  })
})

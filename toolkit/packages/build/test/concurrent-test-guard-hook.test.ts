import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain ESM module without type declarations
import { currentPidNamespace } from '../../../../plugin/bin/lib/host/pid-namespace.mjs'
// @ts-expect-error -- plain ESM module without type declarations
import { lockParticipants } from '../../../../plugin/bin/lib/host/test-run-lock-host.mjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-concurrent-test-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

let journalDir: string
let sandbox: string
let journalSeen = 0

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'wt-concurrent-test-journal-'))
  sandbox = mkdtempSync(join(tmpdir(), 'wt-concurrent-test-sandbox-'))
  journalSeen = 0
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
  rmSync(sandbox, { recursive: true, force: true })
})

// This suite runs under the suite lease, which exports WT_SUITE_LEASE to every worker: a spawned hook
// would otherwise read every start as an inherited lease.
function hookEnv(env: NodeJS.ProcessEnv, keepLease = false) {
  const copy: NodeJS.ProcessEnv = { ...env, WT_GUARD_JOURNAL_DIR: journalDir }
  if (!keepLease) delete copy.WT_SUITE_LEASE
  return copy
}

function run(command: string, env: NodeJS.ProcessEnv = process.env, executable = process.execPath, payload: Record<string, unknown> = {}, keepLease = false) {
  const result = spawnSync(executable, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'concurrent-test-session',
      tool_input: { command },
      ...payload,
    }),
    encoding: 'utf8',
    env: hookEnv(env, keepLease),
  })
  const all = readdirSync(journalDir)
    .filter((file) => file.endsWith('.ndjson'))
    .flatMap((file) => readFileSync(join(journalDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
  // Only this call's records: several calls in one test share the journal directory.
  const entries = all.slice(journalSeen)
  journalSeen = all.length
  return { ...result, entries }
}

function injectedProcessListing(listing: string): NodeJS.ProcessEnv {
  const ps = join(journalDir, 'ps')
  writeFileSync(ps, `#!/bin/sh\n${listing}\n`)
  chmodSync(ps, 0o755)
  return { ...process.env, PATH: journalDir }
}

// A project directory whose vitest config takes the suite lease, or does not.
function project(name: string, leased: boolean) {
  const dir = join(sandbox, name)
  mkdirSync(dir, { recursive: true })
  const setup = leased ? './test-support/suite-lease.global-setup.mjs' : './setup.ts'
  writeFileSync(join(dir, 'vitest.config.mts'), `export default { test: { globalSetup: ['${setup}'] } }\n`)
  return dir
}

// A suite-lock directory whose holder.json and queue tickets name the given pids.
function lockRoot(holder: number | null, tickets: number[] = []) {
  const root = join(sandbox, 'lock-root')
  mkdirSync(join(root, 'queue.d'), { recursive: true })
  if (holder !== null) {
    mkdirSync(join(root, 'lock.d'))
    writeFileSync(join(root, 'lock.d', 'holder.json'), JSON.stringify({ pid: holder }))
  }
  tickets.forEach((pid, index) => writeFileSync(join(root, 'queue.d', `${String(index + 1).padStart(16, '0')}.json`), JSON.stringify({ pid })))
  return root
}

// A listing holding only the hook's own parent, which the hook excludes: a genuine zero.
const SELF_ONLY = "printf '%s 1 sh sh\\n' \"$PPID\""

function listing(rows: [number, number, string][]) {
  return rows.map(([pid, ppid, comm]) => `printf '%s %s %s %s run\\n' ${pid} ${ppid} ${comm} ${comm}`).join('\n')
}

describe('wt-concurrent-test-guard-hook', () => {
  it.skipIf(process.platform === 'win32')('SILENT + SELF-MATCH RED PROOF: reports zero from an injected self listing', () => {
    // `ps` is resolved from PATH. Its parent is the hook, so this record proves the hook excludes itself.
    const result = run('vitest run', injectedProcessListing("printf '%s 1 vitest vitest run\\n' \"$PPID\""))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      decision: 'silent',
      class: 'solo-test-start',
      evidence: { count: '0' },
    })
  })

  it.skipIf(process.platform === 'win32')('WARN: an injected concurrent runner is counted, legible, and never blocked', () => {
    const result = run(`cd ${project('covered', true)} && pnpm vitest run x`, { ...injectedProcessListing("printf '999999 1 vitest vitest run\\n'"), WT_SUITE_LOCK_DIR: lockRoot(null) }, process.execPath, { cwd: sandbox })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stdout).not.toContain('"deny"')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ decision: 'warned', evidence: { count: '1', outside: '1' } })
  })

  it.skipIf(process.platform === 'win32')('REAL MACHINE: reports the runner count it discovers without assuming it is alone', () => {
    const result = run('pnpm test')
    expect(result.status).toBe(0)
    expect(result.entries).toHaveLength(1)
    const count = Number(result.entries[0].evidence.count)
    expect(Number.isInteger(count)).toBe(true)
    expect(count).toBeGreaterThanOrEqual(0)
    expect(result.stdout).toBe('')
    // This suite's own `pnpm test` script wraps the suite lease, so the start is covered; it records
    // a journal-only warning only when a live runner is outside the lock.
    const evidence = result.entries[0].evidence
    expect(evidence.start).toBe('lease-script')
    const outside = Number(evidence.outside)
    expect(outside).toBeGreaterThanOrEqual(0)
    expect(outside).toBeLessThanOrEqual(count)
    const warned = count > 0 && outside > 0
    expect(result.entries[0]).toMatchObject({ decision: warned ? 'warned' : 'silent', evidence: { count: String(count) } })
  })

})

describe('concurrent-test guard runner recognition', () => {
  it.each(['pnpm -r test', 'pnpm vitest', 'pnpm exec vitest', 'pnpm --recursive test'])(
    'recognises required test-start form: %s',
    (command) => {
      const result = run(command, { ...process.env, PATH: '' })
      expect(result.stdout).toBe('')
      expect(result.entries[0]).toMatchObject({ decision: 'warned', class: 'enumeration-unavailable' })
    },
  )

  it('does not enumerate for mere mentions such as grep vitest', () => {
    const result = run('grep vitest README.md', { ...process.env, PATH: '' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.entries).toHaveLength(0)
  })

})

describe('concurrent-test guard enumeration failures', () => {
  it('WARN: unavailable process enumeration is unknown, never a silent zero', () => {
    const result = run('pnpm test', { ...process.env, PATH: '' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      decision: 'warned',
      class: 'enumeration-unavailable',
      evidence: { status: 'unavailable' },
    })
  })

  it('denies unavailable process enumeration in the role-closed environment', () => {
    const result = run('pnpm test', { ...process.env, PATH: '', WT_SDK_ROLE_GUARD_FAILURE: 'closed' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('could not enumerate existing test-runner processes')
    expect(result.stdout).toContain('"permissionDecision":"deny"')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ decision: 'blocked', class: 'enumeration-unavailable' })
  })

  it.each(['pnpm exec vitest --version', 'cd /x && pnpm exec vitest --version < /dev/null > /tmp/p.log 2>&1', 'vitest run --help'])(
    'NOT A RUN: a version or help query is neither enumerated nor journalled: %s',
    (command) => {
      const result = run(command, { ...process.env, PATH: '' })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.entries).toHaveLength(0)
    },
  )

})

describe('concurrent-test guard queued starts', () => {
  it.skipIf(process.platform === 'win32')('SILENT: a queued start next to the lock holder and a queued waiter is not contention', () => {
    const covered = project('covered', true)
    // This live process holds the lock and a queue ticket; both injected runners descend from it.
    const env = { ...injectedProcessListing(listing([[999003, process.pid, 'vitest'], [999002, process.pid, 'vitest']])), WT_SUITE_LOCK_DIR: lockRoot(process.pid, [process.pid]) }
    const result = run(`cd ${covered} && pnpm vitest run a.test.ts`, env)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      decision: 'silent',
      class: 'lock-queued-start',
      evidence: { count: '2', start: 'lease-config', outside: '0', lock: 'held', kind: 'vitest' },
    })
  })

  it.skipIf(process.platform === 'win32')('WARN: a queued start next to a runner the lock cannot place journals the outside count', () => {
    const covered = project('covered', true)
    const env = { ...injectedProcessListing(listing([[999003, process.pid, 'vitest'], [999004, 1, 'vitest']])), WT_SUITE_LOCK_DIR: lockRoot(process.pid) }
    const result = run(`cd ${covered} && pnpm vitest run a.test.ts`, env)
    expect(result.stdout).toBe('')
    expect(result.entries[0]).toMatchObject({ decision: 'warned', class: 'concurrent-test-start', evidence: { count: '2', start: 'lease-config', outside: '1' } })
  })

  it.skipIf(process.platform === 'win32')('WARN: a covered config with WT_SUITE_LOCK=0, or a watch run, does not queue', () => {
    const covered = project('covered', true)
    const env = { ...injectedProcessListing(listing([[999003, process.pid, 'vitest']])), WT_SUITE_LOCK_DIR: lockRoot(process.pid) }
    const bypassed = run(`cd ${covered} && WT_SUITE_LOCK=0 pnpm vitest run a.test.ts`, env)
    expect(bypassed.stdout).toBe('')
    expect(bypassed.entries[0]).toMatchObject({ decision: 'warned', evidence: { start: 'bypassed' } })
    const watching = run(`cd ${covered} && pnpm vitest --watch a.test.ts`, env)
    expect(watching.stdout).toBe('')
    expect(watching.entries[0]).toMatchObject({ decision: 'warned', evidence: { start: 'uncovered' } })
  })

})

describe('concurrent-test guard journal evidence', () => {
  it.skipIf(process.platform === 'win32')('WARN: one uncovered start in the command decides, even after a covered one', () => {
    const covered = project('covered', true)
    const plain = project('plain', false)
    const env = { ...injectedProcessListing(listing([[999003, process.pid, 'vitest']])), WT_SUITE_LOCK_DIR: lockRoot(process.pid) }
    const result = run(`cd ${covered} && pnpm vitest run a; cd ${plain} && pnpm vitest run b`, env)
    expect(result.stdout).toBe('')
    expect(result.entries[0]).toMatchObject({ decision: 'warned', evidence: { start: 'uncovered', starts: '2' } })
  })

  it.skipIf(process.platform === 'win32')('WARN: a start outside the lock next to any runner is journal-only', () => {
    const plain = project('plain', false)
    const result = run(`cd ${plain} && pnpm vitest run a.test.ts`, injectedProcessListing("printf '999999 1 vitest vitest run\\n'"))
    expect(result.stdout).toBe('')
    expect(result.entries[0]).toMatchObject({ decision: 'warned', class: 'concurrent-test-start', evidence: { start: 'uncovered' } })
  })

  it.skipIf(process.platform === 'win32')('CLASSIFIABLE ALONE: the record names the run directory and call id, never the command text', () => {
    const plain = project('plain', false)
    const result = run(`cd ${plain} && pnpm vitest run secret-looking-arg.test.ts`, injectedProcessListing("printf '999999 1 vitest vitest run\\n'"), process.execPath, { tool_use_id: 'toolu_01ABCDEF' })
    expect(result.entries[0].reason).toBe(`dir=${plain} tool=toolu_01ABCDEF`)
    expect(JSON.stringify(result.entries[0])).not.toContain('secret-looking-arg')
    expect(result.entries[0].evidence).toMatchObject({ kind: 'vitest', starts: '1' })
    expect(result.entries[0].evidence.lock).toMatch(/^(held|free|unknown)$/)
  })

  it.skipIf(process.platform === 'win32')('NO PERMISSION DECISION: a warning never approves the command', () => {
    const result = run('pnpm vitest run a', { ...injectedProcessListing("printf '999999 1 vitest vitest run\\n'"), WT_SUITE_LOCK_DIR: lockRoot(null) }, process.execPath, { cwd: sandbox })
    expect(result.stdout).toBe('')
    expect(result.stdout).not.toContain('permissionDecision')
    expect(result.entries[0]).toMatchObject({ decision: 'warned', class: 'concurrent-test-start' })
  })

})

describe('concurrent-test guard delegate starts', () => {
  it.skipIf(process.platform === 'win32')('DELEGATE: a sub-agent starting a run outside an in-use lock is journalled, never blocked', () => {
    const plain = project('plain', false)
    const env = { ...injectedProcessListing(SELF_ONLY), WT_SUITE_LOCK_DIR: lockRoot(null) }
    const result = run(`cd ${plain} && pnpm vitest run a.test.ts`, env, process.execPath, { agent_id: 'a123' })
    expect(result.stdout).toBe('')
    expect(result.stdout).not.toContain('permissionDecision')
    expect(result.entries[0]).toMatchObject({ decision: 'warned', class: 'uncovered-delegate-start', evidence: { count: '0', start: 'uncovered' } })
  })

  it.skipIf(process.platform === 'win32')('DELEGATE: silent when covered or the lock is unused; concurrent detection is journal-only', () => {
    const root = lockRoot(null)
    const covered = run(`cd ${project('covered', true)} && pnpm vitest run a`, { ...injectedProcessListing(SELF_ONLY), WT_SUITE_LOCK_DIR: root }, process.execPath, { agent_id: 'a123' })
    expect(covered.stdout).toBe('')
    expect(covered.entries[0]).toMatchObject({ decision: 'silent', class: 'solo-test-start', evidence: { start: 'lease-config' } })
    const unused = run(`cd ${project('plain', false)} && pnpm vitest run a`, { ...injectedProcessListing(SELF_ONLY), WT_SUITE_LOCK_DIR: join(sandbox, 'never-created') }, process.execPath, { agent_id: 'a123' })
    expect(unused.stdout).toBe('')
    expect(unused.entries[0]).toMatchObject({ decision: 'silent', class: 'solo-test-start', evidence: { start: 'uncovered' } })
    // `warned` classifies journal-only detection for sub-agents as well as main sessions.
    const concurrent = run(`cd ${project('plain', false)} && pnpm vitest run a`, { ...injectedProcessListing("printf '999999 1 vitest vitest run\\n'"), WT_SUITE_LOCK_DIR: root }, process.execPath, { agent_id: 'a123' })
    expect(concurrent.stdout).toBe('')
    expect(concurrent.entries[0]).toMatchObject({ decision: 'warned', class: 'concurrent-test-start' })
    const worker = run(`cd ${project('plain', false)} && pnpm vitest run a`, { ...injectedProcessListing("printf '999999 1 vitest vitest run\\n'"), WT_SUITE_LOCK_DIR: root }, process.execPath, { agent_id: 'a123', agent_type: 'workflow-subagent@session' })
    expect(worker.stdout).toBe('')
    expect(worker.entries[0]).toMatchObject({ decision: 'warned', class: 'concurrent-test-start' })
  })

})

describe('concurrent-test guard lock-domain overrides', () => {
  it.skipIf(process.platform === 'win32')('lock-domain overrides, watch, inherited lease and unresolved cd warn beside an inside runner', () => {
    const covered = project('covered', true)
    const env = { ...injectedProcessListing(listing([[999003, process.pid, 'vitest']])), WT_SUITE_LOCK_DIR: lockRoot(process.pid) }
    for (const prefix of ['WT_SUITE_LOCK_DIR=/tmp/iso', 'WT_SUITE_LOCK="0"', 'HOME=/tmp/h', 'WT_SUITE_LEASE=x']) {
      const result = run(`cd ${covered} && ${prefix} pnpm vitest run x`, env)
      expect(result.entries[0]).toMatchObject({ decision: 'warned', evidence: { start: 'bypassed', outside: '0' } })
      expect(result.stdout).toBe('')
    }
    const watching = run(`cd ${covered} && pnpm vitest --watch x`, env)
    expect(watching.stdout).toBe('')
    expect(watching.entries[0]).toMatchObject({ decision: 'warned', evidence: { start: 'uncovered', outside: '0' } })
    const inherited = run(`cd ${covered} && pnpm vitest run x`, { ...env, WT_SUITE_LEASE: 'fs|abc' }, process.execPath, {}, true)
    expect(inherited.entries[0]).toMatchObject({ decision: 'warned', evidence: { start: 'inherited-lease' } })
    expect(inherited.stdout).toBe('')
    const unresolved = run('cd "$X" && pnpm vitest run x', env)
    expect(unresolved.stdout).toBe('')
    expect(unresolved.entries[0]).toMatchObject({ decision: 'warned', evidence: { start: 'unknown' } })
  })

})

describe('concurrent-test guard unreadable and stale records', () => {
  it.skipIf(process.platform === 'win32')('stale and foreign lock records cannot place runners inside', () => {
    const covered = project('covered', true)
    const env = { ...injectedProcessListing(listing([[999003, 2147480000, 'vitest']])), WT_SUITE_LOCK_DIR: lockRoot(2147480000, [2147480000]) }
    const stale = run(`cd ${covered} && pnpm vitest run x`, env)
    expect(stale.entries[0]).toMatchObject({ decision: 'warned', evidence: { outside: '1' } })
    if (currentPidNamespace()) {
      writeFileSync(join(env.WT_SUITE_LOCK_DIR, 'lock.d', 'holder.json'), JSON.stringify({ pid: process.pid, pidNamespace: 'pid:[999999999]' }))
      writeFileSync(join(env.WT_SUITE_LOCK_DIR, 'queue.d', '0000000000000001.json'), JSON.stringify({ pid: process.pid, pidNamespace: 'pid:[999999999]' }))
      const foreign = run(`cd ${covered} && pnpm vitest run x`, { ...env, ...injectedProcessListing(listing([[999003, process.pid, 'vitest']])) })
      expect(foreign.entries[0]).toMatchObject({ decision: 'warned', evidence: { outside: '1' } })
    }
  })

  it.skipIf(process.platform === 'win32')('unreadable holder and queue leave every runner outside', () => {
    const covered = project('covered', true)
    const root = lockRoot(process.pid)
    const env = { ...injectedProcessListing(listing([[999003, process.pid, 'vitest']])), WT_SUITE_LOCK_DIR: root }
    rmSync(join(root, 'lock.d', 'holder.json'))
    const missing = run(`cd ${covered} && pnpm vitest run x`, env)
    expect(missing.entries[0]).toMatchObject({ decision: 'warned', evidence: { lock: 'held', outside: '1' } })
    writeFileSync(join(root, 'lock.d', 'holder.json'), JSON.stringify({ pid: process.pid }))
    rmSync(join(root, 'queue.d'), { recursive: true })
    writeFileSync(join(root, 'queue.d'), 'unreadable')
    const unreadable = run(`cd ${covered} && pnpm vitest run x`, env)
    expect(unreadable.entries[0]).toMatchObject({ decision: 'warned', evidence: { lock: 'unknown', outside: '1' } })
  })

})

describe('concurrent-test guard lock participants', () => {
  it('a live record from another pid namespace places no pid inside; the same record in ours does', () => {
    const root = lockRoot(null)
    mkdirSync(join(root, 'lock.d'))
    const record = JSON.stringify({ pid: process.pid, pidNamespace: 'pid:[1]' })
    writeFileSync(join(root, 'lock.d', 'holder.json'), record)
    writeFileSync(join(root, 'queue.d', '0000000000000001.json'), record)
    const env = { ...process.env, WT_SUITE_LOCK_DIR: root }
    const probes = (namespace: string) => ({ namespace, stale: { pidNamespace: namespace, namespaceHasProcesses: () => true } })
    expect(lockParticipants(env, probes('pid:[2]'))).toMatchObject({ state: 'held', participants: new Set() })
    expect(lockParticipants(env, probes('pid:[1]'))).toMatchObject({ state: 'held', participants: new Set([process.pid]) })
  })

  it('an unreadable holder adds no pid but a readable ticket still counts', () => {
    const root = lockRoot(process.pid, [process.pid])
    rmSync(join(root, 'lock.d', 'holder.json'))
    expect(lockParticipants({ ...process.env, WT_SUITE_LOCK_DIR: root })).toMatchObject({ state: 'held', participants: new Set([process.pid]) })
  })

})

describe('concurrent-test guard observe mode and registration', () => {
  it('role-closed observe mode records silent when refusal is muted', () => {
    const result = run('pnpm test', { ...process.env, PATH: '', WT_GUARD_MODE: 'observe', WT_SDK_ROLE_GUARD_FAILURE: 'closed' })
    expect(result.stdout).toBe('')
    expect(result.entries[0]).toMatchObject({ decision: 'silent', class: 'enumeration-unavailable' })
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const wired = (manifest.hooks?.PreToolUse ?? [])
      .filter((entry: { matcher?: string }) => entry.matcher === 'Bash')
      .flatMap((entry: { hooks?: { command?: string }[] }) => entry.hooks ?? [])
      .some((hook: { command?: string }) => hook.command?.includes('wt-concurrent-test-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
const lib = process.env.WT_IDLE_REVIEW_LIB ?? new URL('../../../../plugin/bin/lib/', import.meta.url).href
const { scanWorktree } = await import(new URL('host/lane-worktree-scan.mjs', lib))
const { scanIdleWorktree = scanWorktree } = await import(new URL('host/lane-worktree-scan.mjs', lib))
const { readLinuxIdleProcProcesses: readLinuxProcProcesses, readLinuxProcProcesses: readBaseProcesses } = await import(new URL('host/linux.mjs', lib))
const { activityEvidence } = await import(new URL('lane-deadline-core.mjs', lib))

test('native worktree scanner: missing and incomplete trees are unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-worktree-native-'))
  try {
    assert.equal(scanWorktree(join(root, 'absent')).status, 'unknown')
    writeFileSync(join(root, 'file'), '')
    assert.equal(scanWorktree(root, { readStat: () => { throw new Error('unreadable') } }).status, 'unknown')
    assert.equal(scanWorktree(root, { maxEntries: 0 }).status, 'unknown')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native worktree scanner: fingerprint detects a non-maximum file write', () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-worktree-native-'))
  try {
    const future = join(root, 'future')
    const file = join(root, 'working')
    writeFileSync(future, '')
    utimesSync(future, 4_000_000_000, 4_000_000_000)
    writeFileSync(file, 'a')
    const before = scanWorktree(root)
    writeFileSync(file, 'b')
    utimesSync(file, 10, 10)
    const after = scanWorktree(root)
    assert.equal(before.at, after.at)
    assert.notEqual(before.fingerprint, after.fingerprint)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native worktree scanner: excluded state directories do not feed back', () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-worktree-native-'))
  try {
    const state = join(root, '.lane', 'supervision')
    mkdirSync(state, { recursive: true })
    const before = scanWorktree(root)
    writeFileSync(join(state, 'state.json'), '{}')
    assert.deepEqual(scanWorktree(root), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native worktree scanner: symlinks do not sample external state', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-worktree-native-'))
  try {
    const worktree = join(root, 'tree')
    mkdirSync(worktree)
    const state = join(root, 'state.json')
    writeFileSync(state, '{}')
    symlinkSync(state, join(worktree, 'status.json'))
    const before = scanWorktree(worktree)
    writeFileSync(state, '{"changed":true}')
    assert.deepEqual(scanWorktree(worktree), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Linux family signal includes minor faults from automatically reaped forks', () => {
  const read = (faults) => readLinuxProcProcesses({
    readLink: () => String(process.pid),
    observedAt: 20_000,
    readDirectory: () => [{ name: '4', isDirectory: () => true }],
    readFile: (file) => {
      if (file === '/proc/uptime') return '10 1'
      if (file.endsWith('/cmdline')) return 'worker\0'
      const fields = ['S', '1', ...Array(18).fill('0')]
      fields[7] = String(faults)
      fields[19] = '100'
      return `4 (worker) ${fields.join(' ')}`
    },
  }).processes[0]
  assert.equal(read(20).cpuTicks, read(40).cpuTicks)
  assert.equal(read(20).activityTicks, 20)
  assert.equal(read(40).activityTicks, 40)
})

function procInput(parent) {
  let reads = 0
  return {
    readLink: () => String(process.pid),
    observedAt: 20_000,
    readDirectory: () => [{ name: '5', isDirectory: () => true }],
    readFile: (file) => {
      if (file === '/proc/uptime') return '10 1'
      if (file.endsWith('/cmdline')) return 'worker\0'
      const fields = ['S', ++reads === 1 ? parent : '4', ...Array(18).fill('0')]
      fields[19] = '100'
      return `5 (worker) ${fields.join(' ')}`
    },
  }
}

test('default Linux reader retains first parent and base row shape across reparenting', () => {
  assert.deepEqual(readBaseProcesses(procInput('9')), {
    unknownPids: [],
    processes: [{ pid: 5, ppid: 9, command: 'worker', elapsedMs: 9000, startTime: 11000, startIdentity: 100 }],
  })
  assert.equal(readLinuxProcProcesses(procInput('9')).processes[0].ppid, 4)
})

for (const parent of ['-1', 'bad', '1.5', '9007199254740992']) {
  test(`default Linux reader keeps base parent conversion: ${parent}`, () => {
    const snapshot = readBaseProcesses(procInput(parent))
    assert.deepEqual(snapshot.unknownPids, [])
    assert.equal(snapshot.processes[0].ppid, Number(parent))
  })
}

test('idle identity union excludes state and receipt hard links while observing output targets', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-worktree-native-'))
  try {
    const tree = join(root, 'tree')
    mkdirSync(tree)
    const files = ['state', 'receipt'].map((name) => join(root, name))
    for (const file of files) { writeFileSync(file, ''); linkSync(file, join(tree, basename(file))) }
    const output = join(root, 'output')
    writeFileSync(output, '')
    symlinkSync(output, join(tree, 'output'))
    const before = scanIdleWorktree(tree, { excludedFiles: files })
    for (const file of files) { writeFileSync(file, 'supervisor publication'); utimesSync(file, 10, 10) }
    assert.deepEqual(scanIdleWorktree(tree, { excludedFiles: files }), before)
    writeFileSync(output, 'legitimate output')
    assert.notEqual(scanIdleWorktree(tree, { excludedFiles: files }).fingerprint, before.fingerprint)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('idle target read failure is named unknown', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-worktree-native-'))
  try {
    symlinkSync(join(root, 'absent'), join(root, 'dangling'))
    assert.equal(scanIdleWorktree(root).status, 'unknown')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('idle union observes churn in directories excluded from the deadline scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-worktree-native-'))
  try {
    const dir = join(root, 'node_modules')
    mkdirSync(dir)
    const before = scanIdleWorktree(root)
    writeFileSync(join(dir, 'temp'), 'work')
    rmSync(join(dir, 'temp'))
    utimesSync(dir, 10, 10)
    assert.notEqual(scanIdleWorktree(root).fingerprint, before.fingerprint)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const [pid, parent, unknownPids, status] of [[1, '0', [], 'known'], [1, '-1', [], 'unknown'], [5, '0', [], 'unknown'], [1, '0', [6], 'unknown']]) {
  test(`idle namespace ancestry: pid=${pid} parent=${parent} unreadable=${unknownPids.join(',') || 'none'} is ${status}`, () => {
    const snapshot = readLinuxProcProcesses({
      readLink: () => String(process.pid),
      observedAt: 20_000,
      readDirectory: () => [String(pid), '4'].map((name) => ({ name, isDirectory: () => true })),
      readFile: (file) => {
        if (file === '/proc/uptime') return '10 1'
        if (file.endsWith('/cmdline')) return 'worker\0'
        const id = Number(file.split('/')[2])
        const fields = ['S', id === pid ? parent : '1', ...Array(18).fill('0')]
        fields[19] = '100'
        return `${id} (worker) ${fields.join(' ')}`
      },
    })
    snapshot.unknownPids.push(...unknownPids)
    assert.equal(activityEvidence({ snapshot, rootPid: 4, worktree: { status: 'known' } }).status, status)
  })
}

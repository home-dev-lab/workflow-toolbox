// owned-lane-process.test.ts — locks the fake-lane helper the real pgrep and /proc tests depend on:
// the process it starts keeps the lane name and stays alive, even where a copied binary refuses
// to run under a foreign name (uutils coreutils dispatches on its executable name).

import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultFakeLaneCandidates, prepareFakeLane } from './helpers/owned-lane-process.js'

const roots: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) { try { child.kill('SIGKILL') } catch { /* already gone */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'wt-owned-lane-'))
  roots.push(root)
  return root
}

/** A stand-in for a multicall binary: it refuses to run under any name it was not built for. */
function refusingBinary(root: string) {
  const path = join(root, 'multicall')
  writeFileSync(path, "#!/bin/sh\necho \"coreutils: unknown program '$(basename \"$0\")'\" >&2\nexit 1\n")
  chmodSync(path, 0o755)
  return path
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** After `ms`, the child must still be running; on Linux, also return its kernel process name. */
async function aliveNameAfter(child: ChildProcess, ms: number) {
  await settle(ms)
  expect(child.exitCode).toBeNull()
  expect(child.signalCode).toBeNull()
  if (process.platform !== 'linux') return null
  try { return readFileSync(`/proc/${child.pid}/comm`, 'utf8').trim() } catch { return 'gone' }
}

function startOwned(fake: { executable: string, args: string[] }) {
  const child = spawn(fake.executable, fake.args, { stdio: 'ignore' })
  children.push(child)
  if (!child.pid) throw new Error('fake lane has no pid')
  return child
}

describe.skipIf(process.platform === 'win32')('prepareFakeLane', () => {
  it('skips a candidate that refuses its new name and starts the next one under that name', async () => {
    const root = scratch()
    const fake = prepareFakeLane(root, 'opencode', [
      { source: refusingBinary(root), args: ['30'], probeArgs: ['0'] },
      ...defaultFakeLaneCandidates(),
    ])
    expect(fake.executable).toBe(join(root, 'opencode'))
    expect(fake.source).not.toBe(join(root, 'multicall'))
    const child = startOwned(fake)
    const name = await aliveNameAfter(child, 300)
    if (process.platform === 'linux') {
      expect(name).toBe('opencode')
      expect(readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0')[0]).toBe(fake.executable)
    }
  })

  // The shell fallback is what runs where coreutils is uutils; force it so GNU hosts exercise it too.
  it.skipIf(process.platform !== 'linux')('the shell fallback alone gives a live process named opencode [requires Linux /proc]', async () => {
    const root = scratch()
    const shell = defaultFakeLaneCandidates()[1]
    const fake = prepareFakeLane(root, 'opencode', [{ source: refusingBinary(root), args: ['30'], probeArgs: ['0'] }, shell])
    expect(fake.source).toBe(shell.source)
    expect(await aliveNameAfter(startOwned(fake), 1_500)).toBe('opencode')
  })

  it('refuses, naming every candidate, when none runs under the name', () => {
    const root = scratch()
    const refusing = refusingBinary(root)
    const missing = join(root, 'absent-binary')
    expect(() => prepareFakeLane(root, 'opencode', [
      { source: refusing, args: [], probeArgs: [] },
      { source: missing, args: [], probeArgs: [] },
    ])).toThrow(new RegExp(`no candidate runs under the name opencode: ${refusing}: .*unknown program 'opencode'.*; ${missing}: `))
    expect(existsSync(join(root, 'opencode'))).toBe(false)
  })

  it.skipIf(process.platform !== 'linux')('the default candidates on this host give a live process named opencode [requires Linux /proc]', async () => {
    const root = scratch()
    expect(await aliveNameAfter(startOwned(prepareFakeLane(root)), 300)).toBe('opencode')
  })
})

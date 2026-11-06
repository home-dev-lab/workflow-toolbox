// A fake /proc tree for the loaded-version check: real directories, files and symlinks under
// os.tmpdir(), shaped like the Linux entries the scanner reads (stat, cmdline, cwd, exe, fd/<n>, self).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function loadedVersionModule(relative) {
  return new URL(`../../plugin/${relative}`, import.meta.url).href
}

function lockFiles(dir, row) {
  const locked = []
  if (row.unreadableCommandLine) locked.push(join(dir, 'cmdline'))
  if (row.unreadableDescriptors) locked.push(join(dir, 'fd'))
  for (const path of locked) chmodSync(path, 0o000)
  return locked
}

function writeProcess(proc, row) {
  const dir = join(proc, String(row.pid))
  mkdirSync(join(dir, 'fd'), { recursive: true })
  writeFileSync(join(dir, 'stat'), `${row.pid} (${row.comm}) ${row.state ?? 'S'} ${row.ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 100\n`)
  writeFileSync(join(dir, 'status'), `Name:\t${row.comm}\nUid:\t${row.uid ?? process.getuid()}\t0\t0\t0\n`)
  writeFileSync(join(dir, 'cmdline'), (row.argv ?? []).map(arg => `${arg}\0`).join(''))
  for (const link of ['cwd', 'exe']) if (row[link]) symlinkSync(row[link], join(dir, link))
  ;(row.fds ?? []).forEach((target, index) => symlinkSync(target, join(dir, 'fd', String(index + 3))))
  writeFileSync(join(dir, 'environ'), 'SECRET_TOKEN=must-never-be-read\0')
  return lockFiles(dir, row)
}

export function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), 'wt-loaded-version-'))
}

// spec: { selfPid, selfLink?, processes: [{ pid, ppid, comm, state?, argv?, cwd?, exe?, fds?, ... }] }
export function procTree(root, spec) {
  const proc = join(root, 'proc')
  mkdirSync(proc)
  symlinkSync(String(spec.selfLink ?? spec.selfPid), join(proc, 'self'))
  const locked = spec.processes.flatMap(row => writeProcess(proc, row))
  return { root, proc, locked }
}

// A profile directory with a plugins/cache tree; `versions` creates real version directories.
export function profileDir(root, name, plugin = 'demo', versions = []) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'plugins', 'cache'), { recursive: true })
  for (const version of versions) mkdirSync(join(dir, 'plugins', 'cache', 'market', plugin, version), { recursive: true })
  return dir
}

export function serverScript(profile, version, plugin = 'demo') {
  return join(profile, 'plugins', 'cache', 'market', plugin, version, 'start.mjs')
}

export function cleanup(tree) {
  for (const path of tree.locked ?? []) chmodSync(path, 0o700)
  rmSync(tree.root, { recursive: true, force: true })
}

#!/usr/bin/env node
// Real-data e2e for the test-orphan reaper: run real test files under Vitest, SIGKILL the Vitest
// main process mid-run (what a killed or timed-out run does), and list every process the run
// started that is still alive afterwards.
//
// Two instruments that fail differently, both printed:
//   1. descendant snapshot: every process seen under the Vitest process tree while it ran,
//      identified by pid + start time, re-checked after the kill;
//   2. worktree cwd scan: every node process whose cwd lies inside this checkout.
// Only observed descendants belong to this run and may be killed by exact pid.
// Cwd-only matches are reported, but never signaled.
//
// Linux only: it reads /proc. Usage (from toolkit/, under the suite lock):
//   node ../plugin/bin/wt-suite-lock.mjs run -- node scripts/orphan-leak-e2e.mjs [--kill-after-s N] [--grace-s N] <test files...>
// Exit 0 = no survivor, 1 = survivors found, 2 = usage or platform error,
// 3 = Vitest exited before the kill point (inconclusive).
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const TOOLKIT = resolve(import.meta.dirname, '..')
const CHECKOUT = resolve(TOOLKIT, '..')

if (process.platform !== 'linux') {
  process.stderr.write(`orphan-leak-e2e: unavailable on ${process.platform} (reads /proc)\n`)
  process.exit(2)
}

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  args.splice(index, 2)
  return value
}
const killAfterS = option('--kill-after-s', 12)
const graceS = option('--grace-s', 6)
const files = args
if (files.length === 0 || !Number.isFinite(killAfterS) || killAfterS <= 0 || !Number.isFinite(graceS) || graceS <= 0) {
  process.stderr.write('usage: orphan-leak-e2e.mjs [--kill-after-s N] [--grace-s N] <test files...>\n')
  process.exit(2)
}

function stat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    return { state: fields[0], ppid: Number(fields[1]), start: fields[19] }
  } catch { return null }
}
function cmdline(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') } catch { return '' }
}
function cwd(pid) {
  try { return readlinkSync(`/proc/${pid}/cwd`) } catch { return '' }
}
function pids() {
  return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number)
}

const vitest = spawn(process.execPath, [resolve(TOOLKIT, 'node_modules/vitest/vitest.mjs'), 'run', ...files], {
  cwd: TOOLKIT,
  stdio: ['ignore', 'inherit', 'inherit'],
})
const root = vitest.pid
const rootStart = stat(root)?.start
const seen = new Map()
const selfAncestors = new Set()
for (let pid = process.pid; pid > 1;) { selfAncestors.add(pid); pid = stat(pid)?.ppid ?? 0 }

function snapshot() {
  const table = new Map()
  for (const pid of pids()) { const s = stat(pid); if (s) table.set(pid, s) }
  const tree = new Set([root])
  let grew = true
  while (grew) {
    grew = false
    for (const [pid, s] of table) if (!tree.has(pid) && tree.has(s.ppid)) { tree.add(pid); grew = true }
  }
  for (const pid of tree) if (pid !== root && !seen.has(pid) && table.get(pid)?.state !== 'Z') seen.set(pid, { start: table.get(pid).start, cmd: cmdline(pid) })
}

const poll = setInterval(snapshot, 100)
await new Promise((done) => {
  const timer = setTimeout(done, killAfterS * 1000)
  vitest.once('exit', () => { clearTimeout(timer); done() })
})
snapshot()
const killed = stat(root)?.start === rootStart && stat(root)?.state !== 'Z'
if (killed) { process.stdout.write(`\n[e2e] SIGKILL vitest main pid ${root} after ${killAfterS}s\n`); vitest.kill('SIGKILL') }
else process.stdout.write('\n[e2e] vitest exited before the kill point; nothing was killed\n')
clearInterval(poll)
await new Promise((done) => setTimeout(done, graceS * 1000))

const survivors = new Map()
for (const [pid, record] of seen) {
  const current = stat(pid)
  if (current?.start === record.start && current.state !== 'Z') survivors.set(pid, { ...record, via: 'descendant' })
}
for (const pid of pids()) {
  if (pid === process.pid || selfAncestors.has(pid) || survivors.has(pid)) continue
  const dir = cwd(pid)
  const cmd = cmdline(pid)
  if ((dir === CHECKOUT || dir.startsWith(CHECKOUT + sep)) && /(^|\/)node(\s|$)/.test(cmd.split(' ')[0] + ' ') && stat(pid)?.state !== 'Z') {
    survivors.set(pid, { cmd, via: 'worktree-cwd' })
  }
}

process.stdout.write(`[e2e] descendants observed while running: ${seen.size}\n`)
process.stdout.write(`[e2e] survivors after ${graceS}s grace: ${survivors.size}\n`)
for (const [pid, record] of survivors) {
  process.stdout.write(`[e2e]   pid ${pid} (${record.via}) cwd=${cwd(pid)} cmd=${record.cmd.slice(0, 160)}\n`)
}
let reaped = 0
for (const [pid, record] of survivors) {
  const current = stat(pid)
  if (record.via === 'descendant' && current?.start === record.start && current.state !== 'Z') {
    try { process.kill(pid, 'SIGKILL'); reaped++ } catch {}
  }
}
if (reaped) process.stdout.write(`[e2e] ${reaped} observed descendants killed by exact pid\n`)
process.stdout.write(`[e2e] VERDICT ${!killed ? 'INCONCLUSIVE' : survivors.size === 0 ? 'NO-ORPHAN' : 'ORPHANS-LEFT'}\n`)
process.exit(!killed ? 3 : survivors.size === 0 ? 0 : 1)

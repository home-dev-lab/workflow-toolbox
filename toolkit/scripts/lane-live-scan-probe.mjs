#!/usr/bin/env node
import { scanLiveLaneProcesses, worktreeActivity } from '../../plugin/bin/lib/lane-live-scan.mjs'

let minutes = 3
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--minutes' && process.argv[index + 1]) minutes = Number(process.argv[++index])
}
if (!Number.isFinite(minutes) || minutes <= 0) {
  process.stderr.write('lane-live-scan-probe: --minutes must be a positive number\n')
  process.exit(2)
}

const scan = scanLiveLaneProcesses()
if (scan.status === 'unknown') {
  process.stdout.write('lane scan unavailable: /proc is Linux-only or unreadable\n')
  process.exit(0)
}
if (scan.processes.length === 0) {
  process.stdout.write(`no live opencode run or codex exec processes with --dir found (last ${minutes}min)\n`)
  process.exit(0)
}

const cutoff = Date.now() - minutes * 60_000
for (const processInfo of scan.processes) {
  const activity = worktreeActivity(processInfo.dir, cutoff)
  process.stdout.write(`pid=${processInfo.pid} command=${processInfo.command} dir=${processInfo.dir} activity=${activity}\n`)
}

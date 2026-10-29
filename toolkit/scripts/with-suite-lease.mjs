#!/usr/bin/env node
// Package-script boundary: claim a suite lease, or the separate static semaphore for analysis.
// Direct Vitest runs also claim one in globalSetup. An already-leased parent (certification or
// test script) passes its live lease to nested pnpm scripts without deadlocking on itself.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { spawnNeedsShell } from '../../plugin/bin/lib/suite-lock.mjs'
import { staticLaneEnabled } from '../../plugin/bin/lib/suite-lock-static.mjs'

const args = process.argv.slice(2)
// --light asks for queue priority: a short run goes before younger full suites (order only, one holder at a time).
const flags = []
while (['--light', '--static', '--unleased-when-disabled'].includes(args[0])) flags.push(args.shift())
if (args.shift() !== '--' || !args.length) throw new Error('usage: node scripts/with-suite-lease.mjs [--light] [--static] [--unleased-when-disabled] -- <command> [args...]')
const cli = fileURLToPath(new URL('../../plugin/bin/wt-suite-lock.mjs', import.meta.url))
// Opt in only for scripts that ran unleased before static scheduling was introduced.
const direct = flags.includes('--unleased-when-disabled') && flags.includes('--static') && !staticLaneEnabled()
const command = direct ? args : [process.execPath, cli, 'run', ...flags.filter((flag) => flag !== '--unleased-when-disabled'), '--', ...args]
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: spawnNeedsShell(command[0]) })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.once('error', (error) => { process.stderr.write(`suite lease: ${error.message}\n`); process.exitCode = 2 })
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143) })

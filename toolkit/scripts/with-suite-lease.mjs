#!/usr/bin/env node
// Package-script boundary: claim an exclusive lease before build, typecheck, lint, quality or tests.
// Direct Vitest runs also claim one in globalSetup. An already-leased parent (certification or
// test script) passes its live lease to nested pnpm scripts without deadlocking on itself.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { spawnNeedsShell } from '../../plugin/bin/lib/suite-lock.mjs'

const args = process.argv.slice(2)
if (args.shift() !== '--' || !args.length) throw new Error('usage: node scripts/with-suite-lease.mjs -- <command> [args...]')
const cli = fileURLToPath(new URL('../../plugin/bin/wt-suite-lock.mjs', import.meta.url))
const command = [process.execPath, cli, 'run', '--', ...args]
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: spawnNeedsShell(command[0]) })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.once('error', (error) => { process.stderr.write(`suite lease: ${error.message}\n`); process.exitCode = 2 })
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143) })

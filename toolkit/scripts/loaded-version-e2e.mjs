#!/usr/bin/env node
// Real-host e2e for wt-loaded-version: runs the CLI against this machine's live sessions.
// Usage: node toolkit/scripts/loaded-version-e2e.mjs <plugin> [<profile-dir>...]
// Prints each run's output and exit code, then an independent session count taken by a
// different route (pgrep -x claude, pids only) so the CLI's census can be compared with it.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../../plugin/bin/wt-loaded-version.mjs', import.meta.url))
const [plugin = 'context-mode', ...rest] = process.argv.slice(2)
const profiles = rest.length ? rest : [join(homedir(), '.claude'), join(homedir(), '.claude-work')]

function run(label, args) {
  const result = spawnSync(process.execPath, [cli, '--plugin', plugin, ...args], { encoding: 'utf8' })
  process.stdout.write(`$ wt-loaded-version --plugin ${plugin} ${args.join(' ')}   # ${label}\n${result.stdout}${result.stderr}exit=${result.status}\n\n`)
  return result
}

const listing = run('every profile, listing only', ['--list', '--json'])
const parsed = JSON.parse(listing.stdout)
run('every profile, text', ['--list'])
for (const profile of profiles) run(`profile ${profile}`, ['--list', '--profile', profile])
const loaded = [...new Set(parsed.sessions.flatMap(session => session.versions))]
if (loaded.length === 1) {
  const clean = run('expect the version actually loaded', ['--expect', loaded[0]])
  const wrong = run('expect a version nobody loads', ['--expect', `${loaded[0]}-not-released`])
  process.stdout.write(`real-host verdicts as expected (0 then 1): ${clean.status === 0 && wrong.status === 1 ? 'yes' : 'NO'}\n\n`)
}
// Synthetic stale session on a REAL process tree: a process named `claude` holding a descriptor on a
// throw-away profile, whose child server runs from a version directory deleted after it started.
async function syntheticStale() {
  const root = mkdtempSync(join(tmpdir(), 'wt-loaded-version-e2e-'))
  const profile = join(root, '.claude-synthetic')
  const oldRoot = join(profile, 'plugins', 'cache', 'market', plugin, '0.0.1-old')
  mkdirSync(oldRoot, { recursive: true })
  writeFileSync(join(oldRoot, 'start.mjs'), 'setInterval(() => {}, 1000)\n')
  const fake = `process.title = 'claude'; const fs = require('node:fs'); fs.opendirSync(${JSON.stringify(profile)});
    require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(oldRoot, 'start.mjs'))}], { cwd: ${JSON.stringify(oldRoot)}, stdio: 'ignore' });
    setInterval(() => {}, 1000)`
  const session = spawn(process.execPath, ['-e', fake], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  rmSync(oldRoot, { recursive: true, force: true })
  const stale = run('synthetic session, version dir deleted after start', ['--profile', profile, '--expect', '0.0.2'])
  const asExpected = stale.status === 1 && stale.stdout.includes(`stale session=unknown profile=${profile}`) && stale.stdout.includes('version=0.0.1-old')
  process.stdout.write(`synthetic stale verdict as expected (exit 1, version 0.0.1-old): ${asExpected ? 'yes' : 'NO'}\n\n`)
  const children = spawnSync('pgrep', ['-P', String(session.pid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  for (const pid of children) process.kill(Number(pid), 'SIGTERM')
  session.kill('SIGTERM')
  rmSync(root, { recursive: true, force: true })
}

const pgrep = spawnSync('pgrep', ['-x', '-u', String(process.getuid()), 'claude'], { encoding: 'utf8' })
const pids = pgrep.stdout.split('\n').filter(Boolean).sort()
const census = parsed.sessions.map(session => String(session.pid)).sort()
process.stdout.write(`independent census (pgrep -x claude): ${pids.length} pid(s) [${pids.join(' ')}]\n`)
process.stdout.write(`wt-loaded-version census: ${census.length} session(s) [${census.join(' ')}]\n`)
process.stdout.write(`censuses agree: ${JSON.stringify(pids) === JSON.stringify(census) ? 'yes' : 'NO'}\n`)
await syntheticStale()

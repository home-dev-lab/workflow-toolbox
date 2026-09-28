#!/usr/bin/env node
// e2e (card 1873010979835479490): a REAL `wt-second-opinion.mjs --route astra` call on this machine, with
// a fake Codex companion that starts a detached broker (which starts an app-server), records it in
// broker.json once the app-server exists, and exits at once. Prints the broker and app-server PIDs
// before cleanup and their state after the call, then scans the process table for ANY process still
// running from this e2e's fake plugin directory (a second instrument that needs no pid file).
// Exit 0 = no broker or app-server process survived the call. POSIX only (uses `ps`).
//
//   node toolkit/scripts/second-opinion-fast-companion-e2e.mjs                    # unsandboxed
//   WT_LANE_SANDBOX= node toolkit/scripts/second-opinion-fast-companion-e2e.mjs   # host default (bwrap on Linux)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin/bin/wt-second-opinion.mjs')
const root = mkdtempSync(join(tmpdir(), 'wt-second-opinion-e2e-'))
const repo = join(root, 'repo')
const config = join(root, 'config')
const scripts = join(config, 'plugins', 'cache', 'openai-codex', 'codex', '1.0.0', 'scripts')
mkdirSync(repo)
mkdirSync(scripts, { recursive: true })
writeFileSync(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'workflow-toolbox@e2e': { options: { executor_lane_consent: true } } } }))
// Pid files go to the repo when it is writable (unsandboxed); inside the sandbox the repo is read-only
// and those pids would be namespace pids anyway, so only the process-table scan speaks there.
const mark = "const mark = (name, value) => { try { writeFileSync(name, String(value)) } catch {} }"
writeFileSync(join(scripts, 'app-server-broker.mjs'), [
  "import { spawn } from 'node:child_process'",
  "import { writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  mark,
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'app-server', import.meta.dirname], { stdio: 'ignore' })",
  "mark('app-server.pid', child.pid)",
  "writeFileSync(join(process.env.CLAUDE_PLUGIN_DATA, 'app-server-ready'), String(child.pid))",
  "process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0) })",
  'setInterval(() => {}, 1000)',
].join('\n'))
writeFileSync(join(scripts, 'codex-companion.mjs'), [
  "import { spawn } from 'node:child_process'",
  "import { existsSync, mkdirSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  mark,
  "const broker = spawn(process.execPath, [join(import.meta.dirname, 'app-server-broker.mjs')], { detached: true, stdio: 'ignore' })",
  'broker.unref()',
  "mark('broker.pid', broker.pid)",
  "const stateDir = join(process.env.CLAUDE_PLUGIN_DATA, 'state', 'e2e')",
  "const ready = setInterval(() => { if (!existsSync(join(process.env.CLAUDE_PLUGIN_DATA, 'app-server-ready'))) return; clearInterval(ready); mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, 'broker.json'), JSON.stringify({ pid: broker.pid })); console.log('fake astra answer'); process.exit(0) }, 5)",
].join('\n'))
const request = join(root, 'request.md')
const out = join(root, 'answer.log')
writeFileSync(request, 'e2e question')

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return !existsSync(`/proc/${pid}/stat`) || !/^\d+ \(.+\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch { return false }
}
const pidIn = (name) => { try { return Number(readFileSync(join(repo, name), 'utf8')) } catch { return 0 } }
const until = (check, ms) => { const end = Date.now() + ms; while (!check() && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); return check() }
// Every live process whose command line names this e2e's fake plugin directory (broker and app-server).
const survivors = () => String(spawnSync('ps', ['-eo', 'pid=,stat=,args='], { encoding: 'utf8' }).stdout ?? '')
  .split('\n').filter((line) => line.includes(scripts) && !/^\s*\d+\s+Z/.test(line)).map((line) => line.trim())

const started = Date.now()
const call = spawn(process.execPath, [cli, '--request', request, '--out', out, '--route', 'astra', '--repo', repo], {
  env: { ...process.env, CLAUDE_CONFIG_DIR: config, WT_LANE_SANDBOX: process.env.WT_LANE_SANDBOX ?? 'off' },
  stdio: 'ignore',
})
const before = []
const watch = setInterval(() => {
  if (before.length) return
  const broker = pidIn('broker.pid')
  const app = pidIn('app-server.pid')
  if (broker && app && alive(broker) && alive(app)) before.push(`before cleanup (${Date.now() - started} ms): broker pid ${broker} running, app-server pid ${app} running`)
}, 2)
const status = await new Promise((done) => call.once('close', (code) => done(code)))
clearInterval(watch)
const brokerPid = pidIn('broker.pid')
const appPid = pidIn('app-server.pid')
console.log(`cli: ${cli}`)
console.log(`cli exit ${status} after ${Date.now() - started} ms`)
console.log(before.length ? before.join('\n') : 'before cleanup: broker family not observed while the call ran')
console.log('--- answer.log ---')
console.log(existsSync(out) ? readFileSync(out, 'utf8').trimEnd() : '(no answer.log)')
console.log('--- after the call ---')
if (brokerPid) console.log(`broker     pid ${brokerPid}: ${until(() => !alive(brokerPid), 3_000) ? 'gone' : 'STILL RUNNING'}`)
if (appPid) console.log(`app-server pid ${appPid}: ${until(() => !alive(appPid), 3_000) ? 'gone' : 'STILL RUNNING'}`)
until(() => survivors().length === 0, 3_000)
const left = survivors()
console.log(`process-table scan for ${scripts}: ${left.length ? left.join(' | ') : 'none'}`)
for (const line of left) {
  const pid = Number(line.split(/\s+/)[0])
  try { process.kill(pid, 'SIGKILL') } catch {}
}
rmSync(root, { recursive: true, force: true })
// Unsandboxed, the broker must have been SEEN running, or "none survived" would prove nothing.
const sandboxed = process.env.WT_LANE_SANDBOX !== undefined && process.env.WT_LANE_SANDBOX !== 'off'
const ok = (sandboxed || before.length > 0) && left.length === 0
console.log(ok ? 'E2E OK: no broker process survived the call' : 'E2E FAILED: a broker process survived the call, or none was ever observed')
process.exitCode = ok ? 0 : 1

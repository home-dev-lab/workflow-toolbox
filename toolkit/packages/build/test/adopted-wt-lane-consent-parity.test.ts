import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { resolveConsent } from '../../../../plugin/bin/lib/lane-consent-check-core.mjs'
// @ts-expect-error ESM runtime module
import { laneHostDir } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const INSTALLER = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const roots: string[] = []
// Completion is the child's close event; this cross-platform ceiling only detects a real hang.
const CHILD_TIMEOUT_MS = 60_000
const LAUNCH_TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS * 2 + 15_000
const CONSENT_ACCOUNTS = [
  { name: 'settings true', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'true' } } },
  { name: 'settings false', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'false' } } },
  { name: 'settings absent', settings: {} },
  { name: 'userConfig true', settings: { pluginConfigs: { 'workflow-toolbox@fixture': { options: { executor_lane_consent: true } } } } },
  { name: 'userConfig false', settings: { pluginConfigs: { 'workflow-toolbox@fixture': { options: { executor_lane_consent: false } } } } },
]
const CONSENT_PROJECTS = [
  { name: 'project absent', settings: null },
  { name: 'project permits', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'true' } } },
  { name: 'project narrows', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'false' } } },
]
const CONSENT_MATRIX_TIMEOUT_MS = LAUNCH_TEST_TIMEOUT_MS * CONSENT_ACCOUNTS.length * CONSENT_PROJECTS.length
// This one test chains four real spawns (installer, launcher, its own opencode/wt-suite-lock
// children, and a final help child) plus a receipt event. Run 36239956154 timed it at >20s on a
// GitHub Actions Windows runner (whole file: 278s for 19 tests) — genuinely slow spawning, not a
// hang: the vitest default testTimeout (20_000ms, see toolkit/vitest.config.mts) has no margin
// left for that many sequential child processes on that host.
const SUITE_LOCK_CHILD_TIMEOUT_MS = CHILD_TIMEOUT_MS * 3 + 15_000

// A started launcher returns while its detached worker is still recording the run in the host
// directory; teardown waits for every started worker to exit so it never removes that directory
// under a live writer (ENOTEMPTY on macOS, run 36341392712).
type LaneWorker = { pid: number, project: string | null }
const workers: LaneWorker[] = []
const WORKER_EXIT_PATIENCE_MS = 30_000
const workerAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }
// Windows hands the pid of an exited worker to a new process, so a liveness probe alone can keep
// reporting a finished worker alive. The worker's last write to its lane log is `EXIT=<n>`, which
// only the worker writes: that line settles it, whatever the pid now names.
const workerLogExited = (project: string | null) => project !== null && /^EXIT=\d+$/.test(laneLogTail(project, 1))
async function waitForWorkerExit(worker: LaneWorker, { alive = workerAlive, tick }: { alive?: (pid: number) => boolean, tick?: () => Promise<void> } = {}) {
  const done = () => !alive(worker.pid) || workerLogExited(worker.project)
  const deadline = Date.now() + WORKER_EXIT_PATIENCE_MS
  while (!done() && Date.now() < deadline) await (tick ? tick() : new Promise((resolve) => setTimeout(resolve, 25)))
  if (!done()) {
    const tail = worker.project === null ? '<unavailable>' : laneLogTail(worker.project, 20)
    throw new Error(`timed out waiting for adopted lane worker pid=${worker.pid} to exit before teardown; lane log tail: ${tail}`)
  }
}

afterEach(async () => {
  for (const worker of workers.splice(0)) await waitForWorkerExit(worker)
  // On Windows the EXIT= line can be readable a moment before the worker releases its log handle.
  for (const root of roots.splice(0)) { rmSync(laneHostDir(join(root, 'project')), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, WORKER_EXIT_PATIENCE_MS * 2)

function laneLogTail(project: string, lines = 8) {
  try { return readFileSync(join(laneHostDir(project), 'run.log'), 'utf8').trim().split(/\r?\n/).slice(-lines).join(' | ') || '<empty>' } catch { return '<unavailable>' }
}

function projectWithLaneLog(log: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-adopted-worker-exit-')); roots.push(root)
  const project = join(root, 'project'); mkdirSync(project)
  mkdirSync(laneHostDir(project), { recursive: true }); writeFileSync(join(laneHostDir(project), 'run.log'), log)
  return project
}

// A pid that stays alive for good stands for a reused one; the clock advances a second per poll, so
// the 30 s patience runs out in thirty polls and no real time passes.
async function waitBehindReusedPid(project: string) {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try { await waitForWorkerExit({ pid: 424242, project }, { alive: () => true, tick: async () => { now += 1000 } }) } finally { clock.mockRestore() }
}

type ChildResult = { status: number | null, stdout: string, stderr: string, error: Error | undefined }
function childFailureMessage(name: string, timeoutMs: number, result: ChildResult, project: string | null) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/).at(-1) || '<no output>'
  const laneTail = project === null ? '<unavailable>' : laneLogTail(project)
  return `${name} failed after ${timeoutMs}ms: ${result.error!.message}; last output: ${output}; lane log tail: ${laneTail}`
}

async function runChild(name: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = CHILD_TIMEOUT_MS) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(timeoutMs),
    killSignal: 'SIGKILL',
  })
  const result = { status: null as number | null, stdout: '', stderr: '', error: undefined as Error | undefined }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { result.stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { result.stderr += chunk })
  child.on('error', (error) => { result.error = error; child.stdout.destroy(); child.stderr.destroy() })
  // Close drains both pipes and reaps the child, including after the abort backstop kills it.
  await new Promise<void>((resolve) => child.once('close', (status) => { result.status = status; resolve() }))
  // Every door that starts a lane (launch() and the direct launcher calls alike) announces its
  // detached worker as pid=<n>; teardown waits for each one (ENOTEMPTY on macOS, run 36345651918).
  const worker = /^pid=(\d+)$/m.exec(result.stdout ?? '')?.[1]
  const dirIndex = args.indexOf('--dir')
  const project = dirIndex >= 0 ? args[dirIndex + 1]! : null
  if (result.status === 0 && worker) workers.push({ pid: Number(worker), project })
  if (result.error) throw new Error(childFailureMessage(name, timeoutMs, result, project))
  return result
}

function waitForReceipt(file: string, project: string) {
  // Creation can precede the writer's write syscall; the receipt must have content before reading it.
  const ready = () => { try { return readFileSync(file, 'utf8').length > 0 } catch { return false } }
  return new Promise<void>((resolve, reject) => {
    // Register before checking so a write between setup and the first check cannot be missed.
    const watcher = watch(dirname(file), { signal: AbortSignal.timeout(CHILD_TIMEOUT_MS) }, () => {
      if (ready()) { watcher.close(); resolve() }
    })
    watcher.on('error', (error) => { watcher.close(); reject(error) })
    watcher.on('close', () => {
      if (ready()) resolve()
      else reject(new Error(`the lane child never wrote ${file}; lane log tail: ${laneLogTail(project, 20)}`))
    })
    if (ready()) { watcher.close(); resolve() }
  })
}

function writeFakeOpencode(bin: string) {
  mkdirSync(bin)
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fixture-1\n'; exit 0; fi
if [ "$1" = "--pure" ]; then printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\n'; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then printf '[]\n'; exit 0; fi
exit 0
`)
  writeFileSync(join(bin, 'opencode.cmd'), `@echo off\r\n@"${process.execPath}" "%~dp0opencode-fixture.mjs" %*\r\n`)
  writeFileSync(join(bin, 'opencode-fixture.mjs'), `
import fs from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === '--version') process.stdout.write('fixture-1\\n')
else if (args[0] === '--pure') process.stdout.write('[{"name":"workflow-toolbox-allowed-sentinel"}]\\n')
else if (args[0] === 'debug' && args[1] === 'skill') process.stdout.write('[]\\n')
else if (process.env.WT_ADOPTED_SEEN_FENCE) fs.writeFileSync(process.env.WT_ADOPTED_SEEN_FENCE, String(process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS) + '\\n')
else if (process.env.WT_ADOPTED_SEEN_LOCK) fs.writeFileSync(process.env.WT_ADOPTED_SEEN_LOCK, String(process.env.WT_SUITE_LOCK_CMD ?? 'unset'))
`)
  chmodSync(join(bin, 'opencode'), 0o755)
}

function copyPluginFiles(pluginRoot: string, transformSource?: (source: string) => string) {
  mkdirSync(join(pluginRoot, 'bin', 'lib'), { recursive: true })
  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true })
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  mkdirSync(join(pluginRoot, 'skills', 'adopt', 'scripts'), { recursive: true })
  writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'workflow-toolbox', version: '0.0.0' }))
  cpSync(INSTALLER, join(pluginRoot, 'skills', 'adopt', 'scripts', 'install.mjs'))
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'lib'), join(pluginRoot, 'bin', 'lib'), { recursive: true })
  const launcher = readFileSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-lane.mjs'), 'utf8')
  writeFileSync(join(pluginRoot, 'bin', 'wt-lane.mjs'), transformSource ? transformSource(launcher) : launcher)
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-lane-wait.mjs'), join(pluginRoot, 'bin', 'wt-lane-wait.mjs'))
  for (const file of ['wt-arc-watch.mjs', 'wt-quota-watch.mjs']) writeFileSync(join(pluginRoot, 'bin', file), '// unused fixture watcher\n')
  // The suite-lock runner a lane's WT_SUITE_LOCK_CMD runs, with the CLI and library it imports.
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-suite-lock.mjs'), join(pluginRoot, 'bin', 'wt-suite-lock.mjs'))
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-suite-lock.cmd'), join(pluginRoot, 'bin', 'wt-suite-lock.cmd'))
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-suite-lock-run.mjs'), join(pluginRoot, 'bin', 'wt-suite-lock-run.mjs'))
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-suite-lock-run.cmd'), join(pluginRoot, 'bin', 'wt-suite-lock-run.cmd'))
  for (const file of readdirSync(join(REPO_ROOT, 'plugin', 'bin', 'lib')).filter((name) => /^(suite-lock.*|artifact-server)\.mjs$/.test(name))) cpSync(join(REPO_ROOT, 'plugin', 'bin', 'lib', file), join(pluginRoot, 'bin', 'lib', file))
}

async function fixture(transformSource?: (source: string) => string, install = true) {
  const root = mkdtempSync(join(tmpdir(), 'wt-adopted-lane-consent-'))
  roots.push(root)
  const config = join(root, 'config')
  const project = join(root, 'project')
  const pluginRoot = join(root, 'plugin')
  const bin = join(root, 'bin')
  const installed = join(root, 'scripts', 'wt-lane.mjs')
  mkdirSync(join(config, 'plugins'), { recursive: true })
  mkdirSync(join(project, '.claude'), { recursive: true })
  writeFakeOpencode(bin)
  copyPluginFiles(pluginRoot, transformSource)
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'workflow-toolbox@fixture': [{ scope: 'user', installPath: pluginRoot, version: '0.0.0' }] },
  }))
  // The launcher resolves consent solely through these fixture-owned locations. Do not
  // inherit a developer's config, home, or lane settings into the child process.
  // Launcher mechanics are exercised with a fake opencode the lane sandbox cannot see (by design);
  // the sandbox itself is locked in lane-sandbox.test.ts.
  const env: NodeJS.ProcessEnv = { WT_LANE_SANDBOX: 'off', CLAUDE_CONFIG_DIR: config, HOME: join(root, 'home'), PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, XDG_STATE_HOME: join(root, 'state'), ...(process.env.WT_LANE_HOST_STATE ? { WT_LANE_HOST_STATE: process.env.WT_LANE_HOST_STATE } : {}) }
  if (install) {
    const result = await runChild('adopt installer', [join(pluginRoot, 'skills', 'adopt', 'scripts', 'install.mjs'), '--set', 'scripts', '--install', '--dir', join(root, 'scripts')], env)
    expect(result.status, result.stderr).toBe(0)
  }
  return { root, config, project, pluginRoot, installed, env, installer: join(pluginRoot, 'skills', 'adopt', 'scripts', 'install.mjs') }
}

function launch(f: Awaited<ReturnType<typeof fixture>>, model = 'openai/gpt-5.6-luna', extra: string[] = []) {
  const brief = join(f.project, 'brief.md')
  writeFileSync(brief, '# brief\n## Gates\npnpm test\n')
  return runChild('adopted wt-lane launcher', [f.installed, '--dir', f.project, '--model', model, '--brief', brief, '--allow-no-git', ...extra], f.env)
}

function registerChildTests() {
  it('derives the same protected state for the adopted child and its supervising test', async () => {
    const f = await fixture()
    const helper = new URL('../../../../plugin/bin/lib/host/lane-host-dir.mjs', import.meta.url).href
    const child = await runChild('adopted host-state reader', ['--input-type=module', '--eval', `import { laneHostDir } from ${JSON.stringify(helper)}; process.stdout.write(laneHostDir(process.argv[1], { insideSandbox: false }))`, f.project], f.env)
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toBe(laneHostDir(f.project, { insideSandbox: false }))
  }, LAUNCH_TEST_TIMEOUT_MS)

  it('names a timed-out child and includes its last output line', async () => {
    await expect(runChild(
      'fixture hanging child',
      ['--input-type=module', '--eval', "process.stdout.write('waiting\\n'); setTimeout(() => {}, 30_000)"],
      {},
      // Long enough for a cold node start on a loaded Windows runner to print its line (100 ms raced it:
      // run 36223779031 saw `<no output>`), still far below the child's own 30 s hang.
      5000,
    )).rejects.toThrow(/fixture hanging child failed after 5000ms:.*last output: waiting/)
  })

  it('includes the durable lane log tail when a launcher times out', async () => {
    const project = mkdtempSync(join(tmpdir(), 'wt-adopted-timeout-')); roots.push(project)
    mkdirSync(join(project, '.lane'))
    mkdirSync(laneHostDir(project), { recursive: true }); writeFileSync(join(laneHostDir(project), 'run.log'), 'first\n2026-09-17T00:00:00.000Z stage=inspect-launcher-start\n')
    await expect(runChild(
      'fixture launcher',
      ['--input-type=module', '--eval', 'setTimeout(() => {}, 30_000)', '--', '--dir', project],
      {},
      100,
    )).rejects.toThrow(/lane log tail: first \| 2026-09-17T00:00:00.000Z stage=inspect-launcher-start/)
  })

}

function registerReceiptTests() {
  it.each(['absent', 'empty', 'ready'])('awaits a receipt whose initial state is %s', async (state) => {
    const project = projectWithLaneLog('receipt fixture\n')
    const receipt = join(project, 'receipt')
    if (state !== 'absent') writeFileSync(receipt, state === 'ready' ? 'ready' : '')
    const ready = waitForReceipt(receipt, project)
    if (state !== 'ready') setImmediate(() => writeFileSync(receipt, 'ready'))
    await ready
    expect(readFileSync(receipt, 'utf8')).toBe('ready')
  })

  it('observes a child receipt arriving after the former three-second window', async () => {
    const project = projectWithLaneLog('slow receipt fixture\n')
    const receipt = join(project, 'receipt')
    const writer = runChild('slow receipt writer', ['--input-type=module', '--eval', `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(receipt)}, 'ready'), 4000)`], {})
    const [written] = await Promise.all([writer, waitForReceipt(receipt, project)])
    expect(written.status).toBe(0)
    expect(readFileSync(receipt, 'utf8')).toBe('ready')
  }, CHILD_TIMEOUT_MS + 15_000)

  it('fails a missing receipt at the hang backstop with the lane log tail', async () => {
    const project = projectWithLaneLog('receipt never arrived\n')
    const controller = new AbortController()
    const backstop = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    try {
      const ready = expect(waitForReceipt(join(project, 'missing'), project)).rejects.toThrow(/the lane child never wrote .*; lane log tail: receipt never arrived/)
      controller.abort()
      await ready
    } finally { backstop.mockRestore() }
  })

}

function registerWorkerAndConsentTests() {
  it('treats a worker whose lane log ends with EXIT= as exited while its reused pid still reads alive', async () => {
    const project = projectWithLaneLog('2026-09-17T00:00:00.000Z stage=worker-identity-capture-done\nEXIT=0\n')
    await expect(waitBehindReusedPid(project)).resolves.toBeUndefined()
  })

  it('names the pid and the lane log tail when a live worker never writes EXIT=', async () => {
    const project = projectWithLaneLog('first\n2026-09-17T00:00:00.000Z stage=worker-identity-capture-done\n')
    await expect(waitBehindReusedPid(project)).rejects.toThrow(/pid=424242 to exit before teardown; lane log tail: first \| 2026-09-17T00:00:00.000Z stage=worker-identity-capture-done/)
  })

  it('installs only the generic shim and runs the canonical consent gate fail-closed', async () => {
    const f = await fixture()
    const adopted = readFileSync(f.installed, 'utf8')
    expect(adopted).not.toContain('./lib/')
    expect(adopted).not.toContain('resolveConsent')
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'false' } }))
    const refused = await launch(f)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('Refused: this command routes work to the external executor lane, and consent is not given')
  }, LAUNCH_TEST_TIMEOUT_MS)

  it('refuses a missing canonical launcher before execution', async () => {
    const f = await fixture()
    rmSync(join(f.pluginRoot, 'bin', 'wt-lane.mjs'))
    const actual = await launch(f)
    expect(actual.status).toBe(2)
    expect(actual.stdout).toBe(actual.stderr)
    expect(actual.stdout).toContain('bin/wt-lane.mjs')
  }, LAUNCH_TEST_TIMEOUT_MS)

}

function registerInstallAndAdapterTests() {
  // Three isolated Linux runs: 1.49s, 1.50s, 1.51s; Windows runner's 20s expiry
  // spans installer + launcher child spawns and worker teardown under much slower CI load.
  it('installs and starts the adopted launcher when the resolved plugin root has every runtime module', async () => {
    const f = await fixture(undefined, false)
    const install = await runChild('adopt installer', [f.installer, '--set', 'scripts', '--install', '--dir', join(f.root, 'scripts')], f.env)
    expect(install.status, `${install.stdout}${install.stderr}`).toBe(0)

    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const started = await launch(f)
    expect(started.status, started.stderr).toBe(0)
  }, LAUNCH_TEST_TIMEOUT_MS)

  it.each([
    ['hostAdapter export', 'export const unrelated = {}\n'],
    ['readAvailableMemory capability', 'export const hostAdapter = {}\n'],
  ])('matches direct execution for an installed host adapter without the required %s', async (_name, source) => {
    const f = await fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    writeFileSync(join(f.pluginRoot, 'bin', 'lib', 'host', 'adapter.mjs'), source)

    const result = await launch(f)
    const direct = await runChild('canonical host adapter refusal', [join(f.pluginRoot, 'bin', 'wt-lane.mjs'), '--dir', f.project, '--model', 'openai/gpt-5.6-luna', '--brief', join(f.project, 'brief.md'), '--allow-no-git'], f.env)

    expect(result.status).toBe(1)
    expect(result.status).toBe(direct.status)
    expect(result.stderr).toBe(direct.stderr)
  }, SUITE_LOCK_CHILD_TIMEOUT_MS)

}

function registerStaleAndModelTests() {
  it('preserves stale-brief refusal and acknowledgement evidence in the adopted launcher', async () => {
    const f = await fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const brief = join(f.project, 'brief.md')
    writeFileSync(brief, '# adopted brief\n## Gates\npnpm test\n')
    const old = new Date(Date.now() - 15 * 60_000)
    utimesSync(brief, old, old)

    const refused = await runChild('adopted wt-lane stale-brief refusal', [f.installed, '--dir', f.project, '--model', 'openai/gpt-5.6-luna', '--brief', brief, '--allow-no-git', '--max-brief-age', '600'], f.env)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('--acknowledge-stale-brief')
    const acknowledged = await runChild('adopted wt-lane stale-brief acknowledgement', [f.installed, '--dir', f.project, '--model', 'openai/gpt-5.6-luna', '--brief', brief, '--allow-no-git', '--max-brief-age', '600', '--acknowledge-stale-brief'], f.env)
    expect(acknowledged.status, acknowledged.stderr).toBe(0)
    expect(acknowledged.stdout).toMatch(/brief_sha256=[0-9a-f]{64}\n/)
    // Windows worst 22689 ms on cross-os runs 36967768077/36971793287/36974201587.
  }, SUITE_LOCK_CHILD_TIMEOUT_MS)

  it.each([0, 11_000])('refuses an unlisted model through the plugin runtime before the adopted launcher spawns (%dms startup delay)', async (delayMs) => {
    const f = await fixture((source) => `await new Promise((resolve) => setTimeout(resolve, ${delayMs}))\n${source.replace(/^#![^\n]*\n/, '')}`)
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const refused = await launch(f, 'google/gemini-3.6-flash')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('is not in the lane model allow-list')
    expect(refused.stdout).not.toMatch(/^pid=\d+$/m)
  }, LAUNCH_TEST_TIMEOUT_MS)

}

function registerConsentMatrixTests() {
  it('uses the plugin model option before the env fallback in the adopted launcher', async () => {
    const f = await fixture()
    f.env.WT_LANE_MODELS = 'env/model'
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({
      pluginConfigs: { 'workflow-toolbox@fixture': { options: { executor_lane_consent: true, lane_models: 'openai/gpt-5.6-luna' } } },
    }))
    expect((await launch(f)).status).toBe(0)
    // Windows worst 26791 ms on cross-os runs 36967768077/36971793287/36974201587.
  }, LAUNCH_TEST_TIMEOUT_MS)

  it('uses the real resolver for account and project consent fixtures', async () => {
    for (const account of CONSENT_ACCOUNTS) {
      for (const project of CONSENT_PROJECTS) {
        const f = await fixture()
        writeFileSync(join(f.config, 'settings.json'), JSON.stringify(account.settings))
        if (project.settings) writeFileSync(join(f.project, '.claude', 'settings.local.json'), JSON.stringify(project.settings))
        const expected = resolveConsent(f.project, f.env).outcome
        const actual = await launch(f)
        expect(actual.status, `${account.name}; ${project.name}: ${actual.stderr}`).toBe(expected === 'true' ? 0 : 1)
      }
    }
  }, CONSENT_MATRIX_TIMEOUT_MS)

}

function registerMissingPluginAndWorkerTests() {
  it('refuses when no installed plugin root can provide the real resolver', async () => {
    const f = await fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    rmSync(join(f.config, 'plugins', 'installed_plugins.json'))
    const actual = await launch(f)
    expect(actual.status).toBe(2)
    expect(actual.stdout).toBe(actual.stderr)
    expect(actual.stdout).toContain('installed_plugins.json')
  }, LAUNCH_TEST_TIMEOUT_MS)

  it('prints help without an installed plugin', async () => {
    const f = await fixture()
    rmSync(join(f.config, 'plugins', 'installed_plugins.json'))
    const actual = await runChild('adopted wt-lane help', [f.installed, '--help'], f.env)
    expect(actual.status, actual.stderr).toBe(0)
    expect(actual.stdout).toContain('launcher for the installed workflow-toolbox plugin; plugin not found')
  }, LAUNCH_TEST_TIMEOUT_MS)

  it('records a detached worker that fails before its first stage in the lane log', async () => {
    const f = await fixture((source) => source.replace(
      "  const worker = process.argv[2] === '--worker'\n",
      "  const worker = process.argv[2] === '--worker'\n  if (worker) throw new Error('worker-early-failure-probe')\n",
    ))
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const started = await launch(f)
    expect(started.status, started.stderr).toBe(0)
    for (const worker of workers) await waitForWorkerExit(worker)
    expect(laneLogTail(f.project, 40)).toContain('worker-early-failure-probe')
    // Windows worst 16418 ms on cross-os runs 36967768077/36971793287/36974201587.
  }, LAUNCH_TEST_TIMEOUT_MS)

}

function registerFenceTest() {
  it('forces the fence in an adopted launcher child', async () => {
    const f = await fixture()
    const bin = join(f.root, 'bin')
    const seen = join(f.root, 'seen-fence')
    if (process.platform !== 'win32') writeFileSync(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fixture-1\n'; exit 0; fi
if [ "$1" = "--pure" ]; then printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\n'; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then printf '[]\n'; exit 0; fi
printf '%s\n' "$OPENCODE_DISABLE_CLAUDE_CODE_SKILLS" > ${JSON.stringify(seen)}
`)
    chmodSync(join(bin, 'opencode'), 0o755)
    f.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
    f.env.WT_ADOPTED_SEEN_FENCE = seen
    f.env.WT_EXTERNAL_MODEL_ENV_ALLOW = 'WT_ADOPTED_SEEN_FENCE'
    f.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'false'
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const started = await launch(f)
    expect(started.status, started.stderr).toBe(0)
    await waitForReceipt(seen, f.project)
    expect(existsSync(seen), `the lane child never wrote ${seen}; lane log tail: ${laneLogTail(f.project, 20)}`).toBe(true)
    expect(readFileSync(seen, 'utf8')).toBe('true\n')
    // Windows worst 22579 ms on cross-os runs 36967768077/36971793287/36974201587.
  }, SUITE_LOCK_CHILD_TIMEOUT_MS)

}

function registerSuiteLockReceiptTest() {
  it('hands the adopted lane child an executable WT_SUITE_LOCK_CMD for the installed plugin suite-lock runner', async () => {
    const f = await fixture()
    const bin = join(f.root, 'bin')
    const seen = join(f.root, 'seen-lock')
    if (process.platform !== 'win32') writeFileSync(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fixture-1\\n'; exit 0; fi
if [ "$1" = "--pure" ]; then printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\\n'; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then printf '[]\\n'; exit 0; fi
printf '%s' "\${WT_SUITE_LOCK_CMD-unset}" > ${JSON.stringify(seen)}
`)
    chmodSync(join(bin, 'opencode'), 0o755)
    f.env.WT_ADOPTED_SEEN_LOCK = seen
    f.env.WT_EXTERNAL_MODEL_ENV_ALLOW = 'WT_ADOPTED_SEEN_LOCK'
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const started = await launch(f)
    expect(started.status, started.stderr).toBe(0)
    await waitForReceipt(seen, f.project)
    // Node resolves a module URL through symlinks, so the launcher reports the REAL path (macOS tmpdir is
    // /var -> /private/var); the expectation compares against the same real path.
    const cli = realpathSync(join(f.pluginRoot, 'bin', process.platform === 'win32' ? 'wt-suite-lock-run.cmd' : 'wt-suite-lock-run.mjs'))
    expect(existsSync(seen), `the lane child never wrote ${seen}; lane log tail: ${laneLogTail(f.project, 20)}`).toBe(true)
    expect(readFileSync(seen, 'utf8')).toBe(cli)
    expect(existsSync(cli)).toBe(true)
  }, SUITE_LOCK_CHILD_TIMEOUT_MS)

}

function registerMissingCliAndImportTests() {
  it('refuses to launch when the installed plugin root lacks the suite-lock CLI', async () => {
    const f = await fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    rmSync(join(f.pluginRoot, 'bin', process.platform === 'win32' ? 'wt-suite-lock-run.cmd' : 'wt-suite-lock-run.mjs'))

    const result = await launch(f)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('wt-lane: Refused: the suite-lock CLI is missing at')
    expect(result.stderr).toContain('update or reinstall workflow-toolbox')
  }, LAUNCH_TEST_TIMEOUT_MS)

  it('runs a launcher with reworded consent imports without rewriting its body', async () => {
    const f = await fixture((source) => source.replace(
      "import { resolveConsent } from './lib/lane-consent-check-core.mjs'",
      "import { resolveConsent as resolveLaneConsent } from './lib/lane-consent-check-core.mjs'",
    ).replace('return { resolveConsent,', 'return { resolveConsent: resolveLaneConsent,'), false)
    const install = await runChild('adopt installer canonical-source adoption', [f.installer, '--set', 'scripts', '--install', '--dir', join(f.root, 'scripts')], f.env)

    expect(install.status, install.stderr).toBe(0)
    const refused = await launch(f)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('consent is not given')
  }, LAUNCH_TEST_TIMEOUT_MS)
}

describe('adopted wt-lane consent resolver', () => {
  registerChildTests()
  registerReceiptTests()
  registerWorkerAndConsentTests()
  registerInstallAndAdapterTests()
  registerStaleAndModelTests()
  registerConsentMatrixTests()
  registerMissingPluginAndWorkerTests()
  registerFenceTest()
  registerSuiteLockReceiptTest()
  registerMissingCliAndImportTests()
})

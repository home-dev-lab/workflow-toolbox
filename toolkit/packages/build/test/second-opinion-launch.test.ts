import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error executable .mjs test companion
import { cleanupLaunch, documentedLaunch, launchFixture, pluginRoot, skillPath } from '../../../scripts/second-opinion-launch-e2e.mjs'
// @ts-expect-error executable .mjs test companion
import { completed, launchDiagnostics, runShell, terminatePid, waitForLaunch } from '../../../scripts/second-opinion-launch-lifecycle.mjs'

// Cover shell startup, cold-child completion, and the ready/release cleanup regression.
vi.setConfig({ testTimeout: process.platform === 'win32' ? 240_000 : 60_000,
  hookTimeout: process.platform === 'win32' ? 45_000 : 20_000 })

const fixtures: ReturnType<typeof launchFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await cleanupLaunch(f)
    rmSync(f.root, { recursive: true, force: true })
  }
})

function fixture() {
  const f = launchFixture()
  fixtures.push(f)
  return f
}

function stub(source: string) {
  const f = fixture()
  mkdirSync(join(f.plugin, 'bin'))
  writeFileSync(join(f.plugin, 'bin/wt-second-opinion.mjs'), source)
  return f
}

function shell(f: ReturnType<typeof fixture>, source: string, shellTimeoutMs = 10_000) {
  return runShell(f, process.execPath, ['--input-type=module', '-e', source], { env: f.env, shellTimeoutMs })
}

it('the documented launch preserves a missing CLI startup error beside --out', async () => {
  const f = fixture()
  const result = await documentedLaunch(f)
  expect(result.out, result.diagnostics).toBeNull()
  expect(existsSync(`${f.out}.launch.log`), `documented launch must preserve startup diagnostics beside --out; ${result.diagnostics}`).toBe(true)
  expect(result.log, result.diagnostics).toMatch(/MODULE_NOT_FOUND|Cannot find module/)
})

it.each([
  ['missing import', "import './missing-dependency.mjs'", /MODULE_NOT_FOUND|Cannot find module/],
  ['syntax error in an import', "import './bad.mjs'", /SyntaxError/],
] as const)('the documented launch preserves a %s before --out can be written', async (_name, source, error) => {
  const f = stub(source)
  writeFileSync(join(f.plugin, 'bin/bad.mjs'), 'export const = broken')
  const result = await documentedLaunch(f)
  expect(result.out, result.diagnostics).toBeNull()
  expect(result.log, result.diagnostics).toMatch(error)
})

it('the documented launch runs the real CLI with a sealed no-consent profile', async () => {
  const f = fixture()
  const result = await documentedLaunch(f, { env: { WT_PLUGIN_ROOT: pluginRoot } })
  expect(result.out, result.diagnostics).toBe('REFUSED: Astra requires active GPT lane consent.\nEXIT=1\n')
})

it.skipIf(process.platform !== 'linux')('the documented launch captures a missing node executable', async () => {
  const f = fixture()
  const bin = join(f.root, 'bin')
  mkdirSync(bin)
  for (const tool of ['setsid', 'nohup']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool))
  const result = await documentedLaunch(f, { env: { PATH: bin } })
  expect(result.out, result.diagnostics).toBeNull()
  expect(result.log, result.diagnostics).toMatch(/node/)
  expect(result.log, result.diagnostics).toMatch(/No such file|not found/)
})

it('the documented launch captures stdout as well as stderr before the CLI writes --out', async () => {
  const f = stub("console.log('startup stdout'); console.error('REFUSED: startup stderr')")
  const result = await documentedLaunch(f)
  expect(result.out, result.diagnostics).toBeNull()
  if (process.platform === 'win32') {
    expect(readFileSync(`${f.out}.launch.stdout.log`, 'utf8'), result.diagnostics).toContain('startup stdout')
  } else expect(result.log, result.diagnostics).toContain('startup stdout')
  expect(result.log, result.diagnostics).toContain('REFUSED: startup stderr')
})

function registry(f: ReturnType<typeof fixture>, entries: unknown[]) {
  mkdirSync(join(f.config, 'plugins'), { recursive: true })
  writeFileSync(join(f.config, 'plugins/installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'workflow-toolbox@test': entries },
  }))
}

it('loaded skill text resolves an updated registry after its old plugin root is removed', async () => {
  const f = fixture()
  const loaded = join(f.root, 'loaded-skill.md')
  writeFileSync(loaded, readFileSync(skillPath, 'utf8'))
  registry(f, [{ scope: 'user', installPath: f.plugin }])
  rmSync(f.plugin, { recursive: true })
  registry(f, [{ scope: 'user', installPath: pluginRoot }])
  const result = await documentedLaunch(f, { skill: loaded, env: { WT_PLUGIN_ROOT: undefined } })
  expect(result.out, result.diagnostics).toBe('REFUSED: Astra requires active GPT lane consent.\nEXIT=1\n')
})

it.each(['project', 'local'])('the current %s installation ranks above user and unrelated project entries', async (scope) => {
  const f = fixture()
  registry(f, [
    { scope, projectPath: f.config, installPath: f.plugin },
    { scope: 'user', installPath: f.plugin },
    { scope, projectPath: f.root, installPath: pluginRoot },
  ])
  const result = await documentedLaunch(f, { env: { WT_PLUGIN_ROOT: undefined } })
  expect(result.out, result.diagnostics).toBe('REFUSED: Astra requires active GPT lane consent.\nEXIT=1\n')
})

it('a broken selected installation refuses with diagnostics rather than falling back', async () => {
  const f = fixture()
  registry(f, [{ scope: 'user', installPath: pluginRoot }])
  const result = await documentedLaunch(f)
  expect(result.out, result.diagnostics).toBeNull()
  expect(result.log, result.diagnostics).toContain('wt-second-opinion.mjs')
  expect(result.log, result.diagnostics).toMatch(/MODULE_NOT_FOUND|Cannot find module/)
})

it.skipIf(process.platform === 'win32')('the stock macOS nohup launch form also captures a missing CLI', async () => {
  const result = await documentedLaunch(fixture(), { platform: 'darwin' })
  expect(result.out, result.diagnostics).toBeNull()
  expect(result.log, result.diagnostics).toMatch(/MODULE_NOT_FOUND|Cannot find module/)
})

it('the Windows form detaches with file-backed streams and records launch failures', () => {
  const text = readFileSync(skillPath, 'utf8')
  const block = text.match(/```powershell\r?\n([\s\S]*?)```/)?.[1]
  expect(block).toContain("openSync(log, 'a')")
  expect(block).toContain("openSync(out + '.launch.stdout.log', 'a')")
  expect(block).toContain("stdio: ['ignore', ...fds]")
  expect(block).toContain('detached: true')
  expect(block).toContain('child.unref()')
  expect(block).toContain('-ErrorAction Stop')
  expect(block).toContain('[IO.File]::AppendAllText("${out}.launch.log"')
})

it('completion polling waits beyond the old five-second bound for a cold child', async () => {
  const f = stub(`import { writeFileSync } from 'node:fs'
setTimeout(() => writeFileSync(process.argv[process.argv.indexOf('--out') + 1], 'delayed completion\\nEXIT=0\\n'), 5500)`)
  const result = await documentedLaunch(f, { completionTimeoutMs: 10_000 })
  expect(result.out, result.diagnostics).toBe('delayed completion\nEXIT=0\n')
})

it('a silent child times out with timing/file diagnostics and is killed before removal', async () => {
  const f = stub('setInterval(() => {}, 1000)')
  await expect(documentedLaunch(f, { completionTimeoutMs: 100 })).rejects.toThrow(
    /launch completion timed out; shell=.*shellExitMs=\d+ shellStatus=0.*out\(exists=false bytes=0\).*launchLog\(exists=true bytes=0\).*elapsedMs=\d+/,
  )
  expect(await cleanupLaunch(f, { graceMs: 0 })).toEqual({ killed: 1 })
})

it('cleanup waits for an incomplete child even after its startup log is readable', async () => {
  const f = stub(`import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
const out = process.argv[process.argv.indexOf('--out') + 1]
console.error('REFUSED: startup marker')
while (!existsSync(out + '.release')) await setTimeout(10)
writeFileSync(out + '.finished', 'done')`)
  const result = await documentedLaunch(f)
  expect(result.log, result.diagnostics).toContain('REFUSED: startup marker')
  const cleaning = cleanupLaunch(f)
  writeFileSync(`${f.out}.release`, 'release')
  expect(await cleaning).toEqual({ killed: 0 })
  expect(existsSync(`${f.out}.finished`)).toBe(true)
})

it('a shell timeout reports its own step and cleanup observes its termination', async () => {
  const f = fixture()
  const result = await shell(f, 'setInterval(() => {}, 1000)', 100)
  expect(result.error, launchDiagnostics(f)).toBe('ETIMEDOUT')
  expect(await cleanupLaunch(f, { graceMs: 0 })).toEqual({ killed: 1 })
})

it('a missing launch shell reports ENOENT without needing child cleanup', async () => {
  const f = fixture()
  const result = await runShell(f, join(f.root, 'missing-executable'), [], { env: f.env, shellTimeoutMs: 1000 })
  expect(result.error, launchDiagnostics(f)).toBe('ENOENT')
  expect(await cleanupLaunch(f)).toEqual({ killed: 0 })
})

it('shell stdout and stderr are regular files rather than inherited pipes', async () => {
  const f = fixture()
  expect((await shell(f, "console.log('stdout'); console.error('stderr')")).status, launchDiagnostics(f)).toBe(0)
  expect(readFileSync(`${f.out}.shell.stdout.log`, 'utf8')).toBe('stdout\n')
  expect(readFileSync(`${f.out}.shell.stderr.log`, 'utf8')).toBe('stderr\n')
})

it('cleanup reports a surviving child instead of removing its directory', async () => {
  const f = stub("console.error('REFUSED: holding'); setInterval(() => {}, 1000)")
  await documentedLaunch(f)
  try {
    await expect(cleanupLaunch(f, { graceMs: 0, killWaitMs: 30, terminate: () => {} })).rejects.toThrow(/fixture children still alive/)
    expect(existsSync(f.root)).toBe(true)
  } finally {
    await cleanupLaunch(f, { graceMs: 0 })
  }
})

it('Windows tree cleanup targets the recorded PID before its cold descendants can be orphaned', async () => {
  const f = stub("console.error('REFUSED: holding'); setInterval(() => {}, 1000)")
  await documentedLaunch(f)
  const pid = Number(readFileSync(`${f.out}.child.pid`, 'utf8'))
  const run = vi.fn(() => { process.kill(pid, 'SIGKILL'); return { status: 0 } })
  terminatePid(pid, { tree: true, run })
  expect(run).toHaveBeenCalledWith('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore', windowsHide: true, timeout: 10_000,
  })
  await cleanupLaunch(f)
})

it('failed Windows tree termination retains the fixture with a named failure', async () => {
  const f = stub("console.error('REFUSED: holding'); setInterval(() => {}, 1000)")
  await documentedLaunch(f)
  const pid = Number(readFileSync(`${f.out}.child.pid`, 'utf8'))
  expect(() => terminatePid(pid, { tree: true, run: () => ({ status: 1, error: { code: 'ESPAWN' } }) }))
    .toThrow(/fixture process-tree termination failed:.*error=ESPAWN/)
  expect(existsSync(f.root)).toBe(true)
  await cleanupLaunch(f, { graceMs: 0 })
})

it('Windows tree cleanup accepts a PID that exits before taskkill finds it', async () => {
  const f = fixture()
  await shell(f, '')
  expect(() => terminatePid(f.shellChild.pid, { tree: true, run: () => ({ status: 128 }) })).not.toThrow()
})

it('partial output is not complete until its EXIT line arrives', async () => {
  const f = fixture()
  writeFileSync(f.out, 'partial\n')
  expect(completed(f.out)).toBeNull()
  const waiting = waitForLaunch(f, 15_000)
  writeFileSync(f.out, 'done\nEXIT=0\n')
  expect(await waiting).toBe('out')
})

it.skipIf(process.platform !== 'linux')('cleanup treats a real unreaped zombie as exited', async () => {
  const f = fixture()
  const launching = shell(f, '')
  // Keep the event loop paused so libuv cannot reap the exact zombie state under test.
  const deadline = performance.now() + 15_000
  let zombie = false
  while (!zombie && performance.now() < deadline) {
    zombie = /^ Z /.test(readFileSync(`/proc/${f.shellChild.pid}/stat`, 'utf8').split(')').at(-1) ?? '')
    if (!zombie) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  expect(zombie).toBe(true)
  expect(await cleanupLaunch(f, { graceMs: 0, killWaitMs: 0 })).toEqual({ killed: 0 })
  await launching
})

it('the Windows detacher exits while its file-backed child remains alive', async () => {
  const f = fixture()
  const text = readFileSync(skillPath, 'utf8')
  const source = text.match(/\$detach = @'\r?\n([\s\S]*?)\r?\n'@/)?.[1]
  expect(source).toBeTruthy()
  const bootstrap = `${f.out}.launch.mjs`
  writeFileSync(bootstrap, `import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
writeFileSync(${JSON.stringify(`${f.out}.child.pid`)}, String(process.pid))
writeFileSync(${JSON.stringify(`${f.out}.ready`)}, 'ready')
while (!existsSync(${JSON.stringify(`${f.out}.release`)})) await setTimeout(10)
console.log('startup stdout'); console.error('startup stderr')
writeFileSync(${JSON.stringify(f.out)}, 'done\\nEXIT=0\\n')`)
  const result = await runShell(f, process.execPath, ['--input-type=module', '-e', source, '--', bootstrap, '--out', f.out], {
    env: f.env, shellTimeoutMs: process.platform === 'win32' ? 60_000 : 10_000,
  })
  expect(result.status, launchDiagnostics(f)).toBe(0)
  const deadline = performance.now() + (process.platform === 'win32' ? 120_000 : 15_000)
  while (!existsSync(`${f.out}.ready`) && performance.now() < deadline) await delay(20)
  expect(existsSync(`${f.out}.ready`), launchDiagnostics(f)).toBe(true)
  expect(completed(f.out), launchDiagnostics(f)).toBeNull()
  writeFileSync(`${f.out}.release`, 'release')
  await waitForLaunch(f, 15_000)
  await cleanupLaunch(f)
  expect(readFileSync(`${f.out}.launch.stdout.log`, 'utf8')).toBe('startup stdout\n')
  expect(readFileSync(`${f.out}.launch.log`, 'utf8')).toBe('startup stderr\n')
})

it.each([
  ['C:\\work tree\\', '"C:\\work tree\\\\"'],
  ['C:\\work\\', '"C:\\work\\\\"'],
  ['C:\\work tree\\\\', '"C:\\work tree\\\\\\\\"'],
  ['C:\\work\\\\', '"C:\\work\\\\\\\\"'],
] as const)('Windows legacy argument quoting preserves trailing backslashes in %j', (repo, argument) => {
  const block = readFileSync(skillPath, 'utf8').match(/```powershell\r?\n([\s\S]*?)```/)?.[1]
  const escape = block?.match(/ForEach-Object \{ '"' \+ \(\$_ -replace '([^']+)', '([^']+)'\) \+ '"' \}/)
  expect(escape, 'Windows legacy arguments must double trailing backslashes before quoting').toBeTruthy()
  const [, pattern = '', replacement = ''] = escape ?? []
  expect(`"${repo.replace(new RegExp(pattern), replacement)}"`).toBe(argument)
  expect(block).toContain("(Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue) -notin @('Standard', 'Windows')")
})

it.skipIf(process.platform !== 'win32')('the documented Windows launch preserves a repository trailing separator', async () => {
  const f = stub(`import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(args) + '\\nEXIT=0\\n')`)
  f.repo += '\\'
  const result = await documentedLaunch(f)
  expect(JSON.parse(result.out!.split('\n')[0]!), result.diagnostics).toEqual([
    '--request', f.request, '--out', f.out, '--effort', 'low', '--route', 'astra', '--repo', f.repo,
  ])
})

it('the Windows detacher returns while its child runs when the PID record cannot be written', async () => {
  const f = fixture()
  const source = readFileSync(skillPath, 'utf8').match(/\$detach = @'\r?\n([\s\S]*?)\r?\n'@/)?.[1]
  expect(source).toBeTruthy()
  const bootstrap = `${f.out}.launch.mjs`
  writeFileSync(bootstrap, `import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
writeFileSync(${JSON.stringify(`${f.out}.child.pid`)}, String(process.pid))
writeFileSync(${JSON.stringify(`${f.out}.ready`)}, 'ready')
while (!existsSync(${JSON.stringify(`${f.out}.release`)})) await setTimeout(10)`)
  mkdirSync(`${f.out}.launch.pid`)
  const shellTimeoutMs = process.platform === 'win32' ? 60_000 : 10_000
  try {
    const started = performance.now()
    const result = await runShell(f, process.execPath, ['--input-type=module', '-e', source, '--', bootstrap, '--out', f.out], {
      env: f.env, shellTimeoutMs,
    })
    const elapsedMs = performance.now() - started
    expect(result.error, launchDiagnostics(f)).toBeNull()
    expect(result.status, launchDiagnostics(f)).toBe(1)
    expect(elapsedMs, launchDiagnostics(f)).toBeLessThan(shellTimeoutMs)
    const deadline = performance.now() + (process.platform === 'win32' ? 120_000 : 15_000)
    while (!existsSync(`${f.out}.ready`) && performance.now() < deadline) await delay(20)
    expect(existsSync(`${f.out}.ready`), launchDiagnostics(f)).toBe(true)
    const pid = Number(readFileSync(`${f.out}.child.pid`, 'utf8'))
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(existsSync(`${f.out}.release`)).toBe(false)
    const log = readFileSync(`${f.out}.launch.log`, 'utf8')
    expect(log).toMatch(/EISDIR|EACCES|EPERM/)
    expect(log).toContain('.launch.pid')
  } finally {
    rmSync(`${f.out}.launch.pid`, { recursive: true, force: true })
    writeFileSync(`${f.out}.release`, 'release')
  }
})

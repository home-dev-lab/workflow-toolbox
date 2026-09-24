import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = process.env.WT_ADOPT_PIN_SCRIPT ?? join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const PLUGIN = join(REPO_ROOT, 'plugin')
const RULE = 'wt-delegation-ladder.md'
const ENV_ROOT = join(tmpdir(), `wt-adopt-refactor-pins-env-${process.pid}`)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
afterAll(() => rmSync(ENV_ROOT, { recursive: true, force: true }))

function tempDir(prefix = 'wt-adopt-refactor-pin-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function env(config: string, plugin = PLUGIN): NodeJS.ProcessEnv {
  return sealedPluginCliEnv(ENV_ROOT, { CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: plugin })
}

function run(
  args: string[],
  options: { cwd?: string; config?: string; plugin?: string; script?: string } = {},
) {
  const config = options.config ?? tempDir('wt-adopt-refactor-config-')
  const result = spawnSync(process.execPath, [options.script ?? SCRIPT, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: env(config, options.plugin),
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function fixturePlugin(): { root: string; script: string } {
  const root = tempDir('wt-adopt-refactor-plugin-')
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin/plugin.json'), '{"version":"1.2.3"}\n')
  const script = join(root, 'skills/adopt/scripts/install.mjs')
  mkdirSync(join(root, 'skills/adopt/scripts'), { recursive: true })
  cpSync(SCRIPT, script)
  return { root, script }
}

function mutateScript(replacements: Array<[string, string]>): string {
  const root = tempDir('wt-adopt-refactor-mutant-')
  const script = join(root, 'install.mjs')
  let source = readFileSync(SCRIPT, 'utf8')
  for (const [from, to] of replacements) {
    expect(source).toContain(from)
    source = source.replace(from, to)
  }
  writeFileSync(script, source)
  return script
}

describe('adopt installer refactor pins', () => {
  it('P1 streams truthful recovery state before a middle migration move can continue', async () => {
    const root = tempDir()
    const flat = join(root, 'rules')
    const wt = join(flat, 'wt')
    const config = tempDir('wt-adopt-refactor-config-')
    const files = readdirSync(join(PLUGIN, 'rules')).filter((file) => file.endsWith('.md') && file !== 'README.md').sort().slice(0, 3)
    mkdirSync(flat)
    for (const file of files) {
      expect(run(['--set', 'rules', '--install', '--file', file, '--dir', flat], { config }).status).toBe(0)
    }
    const mutant = mutateScript([
      [
        'function moveFileVerified(from, to) {',
        `function moveFileVerified(from, to) {\n  if (path.basename(from) === ${JSON.stringify(files[1])}) {\n    while (!fs.existsSync(${JSON.stringify(join(root, 'release-second-move'))})) {}\n    throw new Error('PINNED MOVE FAILURE')\n  }`,
      ],
    ])

    const release = join(root, 'release-second-move')
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string; movedWhileRunning: boolean }>((resolve) => {
      const child = spawn(process.execPath, [mutant, '--migrate', '--execute', '--dir', wt, '--ignore-secondary'], {
        env: env(config),
      })
      let stdout = ''
      let stderr = ''
      let movedWhileRunning = false
      let released = false
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (!released && stdout.includes(`MOVED ${files[0]}`)) {
          movedWhileRunning = child.exitCode === null
          released = true
          writeFileSync(release, '')
        }
      })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
      child.on('close', (status) => {
        clearTimeout(timeout)
        resolve({ status, stdout, stderr, movedWhileRunning })
      })
    })

    expect(result.movedWhileRunning).toBe(true)
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      `[migrate --execute] flat root=${flat}  →  new location=${wt}\n` +
      `  MOVED ${files[0]}: ${join(flat, files[0]!)} -> ${join(wt, files[0]!)}\n` +
      `  FAILED ${files[1]}: PINNED MOVE FAILURE\n\n` +
      'adopt:migrate --execute: 1 of 3 planned file(s) moved, 1 of 3 confirmed present at destination and absent from origin.\n' +
      `1 file(s) NOT REACHED (a prior move failed; stopped):\n  NOT REACHED ${files[2]}\n` +
      `destination: ${wt}\n` +
      'adopt:migrate --execute: EXITING NON-ZERO — not every planned move is confirmed.\n',
    )
    expect(existsSync(join(wt, files[0]!))).toBe(true)
    expect(existsSync(join(flat, files[1]!))).toBe(true)
    expect(existsSync(join(flat, files[2]!))).toBe(true)
  })

  it('P2 preserves an opted-in symlink replacement when rendering fails', () => {
    const fixture = fixturePlugin()
    const targetDir = tempDir()
    const linkTarget = join(tempDir(), 'pilot.md')
    writeFileSync(linkTarget, 'target stays intact\n')
    symlinkSync(linkTarget, join(targetDir, 'pilot.md'))

    const result = run(
      ['--set', 'agents', '--install', '--replace-symlinks', '--file', 'pilot.md', '--dir', targetDir],
      { plugin: fixture.root, script: fixture.script },
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('agents source not found:')
    expect(lstatSync(join(targetDir, 'pilot.md')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(targetDir, 'pilot.md'))).toBe(linkTarget)
    expect(readFileSync(linkTarget, 'utf8')).toBe('target stays intact\n')
  })

  it('P2 preserves an opted-in symlink replacement when atomic publication fails', () => {
    const fixture = fixturePlugin()
    const sourceDir = join(fixture.root, 'agent-templates')
    mkdirSync(sourceDir)
    cpSync(join(PLUGIN, 'agent-templates/pilot.md'), join(sourceDir, 'pilot.md'))
    const source = readFileSync(fixture.script, 'utf8')
    expect(source).toContain('moveFileVerified(temp, target)')
    writeFileSync(fixture.script, source.replace('moveFileVerified(temp, target)', "throw new Error('PINNED RENAME FAILURE')"))
    const targetDir = tempDir()
    const linkTarget = join(tempDir(), 'pilot.md')
    const targetBytes = 'target stays intact\n'
    writeFileSync(linkTarget, targetBytes)
    symlinkSync(linkTarget, join(targetDir, 'pilot.md'))

    const result = run(
      ['--set', 'agents', '--install', '--replace-symlinks', '--file', 'pilot.md', '--dir', targetDir],
      { plugin: fixture.root, script: fixture.script },
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('PINNED RENAME FAILURE')
    expect(lstatSync(join(targetDir, 'pilot.md')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(targetDir, 'pilot.md'))).toBe(linkTarget)
    expect(readFileSync(linkTarget, 'utf8')).toBe(targetBytes)
    expect(readdirSync(targetDir)).toEqual(['pilot.md'])
  })

  it('P3 does not let a shipped-fingerprint catch swallow a one-shot fatal error', () => {
    const fixture = fixturePlugin()
    cpSync(join(PLUGIN, 'bin'), join(fixture.root, 'bin'), { recursive: true })
    let source = readFileSync(fixture.script, 'utf8')
    source = source.replace(
      "function fail(msg) {\n  process.stdout.write(`adopt: ${msg}\\n`)\n  process.exit(1)\n}",
      "function fail(msg) { throw new AdoptFatalError(msg) }",
    )
    source = source.replace(
      'function itemContent(set, item, root) {',
      "function itemContent(set, item, root) {\n  if (item.file === 'wt-lane-wait.mjs' && !globalThis.__fatalPinThrown) { globalThis.__fatalPinThrown = true; fail('PINNED ONE-SHOT FATAL') }",
    )
    writeFileSync(fixture.script, source)
    const target = tempDir()

    const result = run(['--set', 'scripts', '--install', '--file', 'wt-lane-wait.mjs', '--dir', target], {
      plugin: fixture.root,
      script: fixture.script,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('SKIPPED')
    expect(result.stderr).toContain('PINNED ONE-SHOT FATAL')
    expect(existsSync(join(target, 'wt-lane-wait.mjs'))).toBe(false)
  })

  it('U1 preserves last-option and last-mode precedence', () => {
    const target = tempDir()
    const result = run(['--install', '--check', '--set', 'agents', '--set', 'rules', '--dir', target])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('mode=check · set=rules')
    expect(result.stdout).toContain(`[rules] target=${target}`)
    expect(existsSync(join(target, RULE))).toBe(false)
  })

  it('U3 writes through a linked settings file and preserves its target mode', () => {
    const config = tempDir('wt-adopt-refactor-config-')
    const target = join(tempDir(), 'real-settings.json')
    writeFileSync(target, '{"theme":"dark"}\n')
    chmodSync(target, 0o640)
    symlinkSync(target, join(config, 'settings.json'))

    const result = run(['--set', 'rules', '--install', '--dir', tempDir()], { config })

    expect(result.status).toBe(0)
    expect(lstatSync(join(config, 'settings.json')).isSymbolicLink()).toBe(true)
    expect(statSync(target).mode & 0o777).toBe(0o640)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ theme: 'dark', env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3' } })
  })

  it('U4 preserves ignored unknown tokens and a missing --dir value fallback', () => {
    const cwd = tempDir()
    const result = run(['--unknown-token', '--check', '--dir'], { cwd })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`[rules] target=${join(cwd, '.claude/rules/wt')}`)
  })

  it.each(['toString', 'constructor', '__proto__'])('U4 ignores inherited object-property argv token %s', (token) => {
    const cwd = tempDir()
    const expected = run(['--set', 'docs', '--check', '--dir', join(cwd, 'target')], { cwd })
    const actual = run(['--set', 'docs', '--check', '--dir', join(cwd, 'target'), token], { cwd })
    expect(actual).toEqual(expected)
  })

  it('U5 treats an invalid settings trace as unavailable and replaces it on install', () => {
    const config = tempDir('wt-adopt-refactor-config-')
    const trace = join(config, 'workflow-toolbox/adopt-settings-trace.json')
    mkdirSync(join(config, 'workflow-toolbox'))
    writeFileSync(trace, '{')
    const checked = run(['--set', 'rules', '--check', '--dir', tempDir()], { config })
    expect(checked.stdout).toContain('ABSENT (would be added on --install)')
    const installed = run(['--set', 'rules', '--install', '--dir', tempDir()], { config })
    expect(installed.status).toBe(0)
    expect(JSON.parse(readFileSync(trace, 'utf8')).keys.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH.value).toBe('3')
  })

  it('U6 prints the absent hint before the independent symlink advisory', () => {
    const target = tempDir()
    const linked = join(tempDir(), RULE)
    writeFileSync(linked, 'linked\n')
    symlinkSync(linked, join(target, RULE))
    const result = run(['--set', 'rules', '--check', '--dir', target])
    expect(result.stdout.indexOf('run with --install to write the ABSENT item(s)')).toBeLessThan(
      result.stdout.indexOf('symlinked target(s) present'),
    )
  })

  it('U7 follows a migration destination symlink when deciding that it exists', () => {
    const flat = tempDir()
    const wt = join(flat, 'wt')
    const config = tempDir('wt-adopt-refactor-config-')
    expect(run(['--set', 'rules', '--install', '--file', RULE, '--dir', flat], { config }).status).toBe(0)
    mkdirSync(wt)
    const destination = join(tempDir(), RULE)
    writeFileSync(destination, 'destination\n')
    symlinkSync(destination, join(wt, RULE))
    const result = run(['--migrate', '--dry-run', '--dir', wt], { config })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`destination already exists at ${join(wt, RULE)}`)
    expect(readFileSync(destination, 'utf8')).toBe('destination\n')
  })

  it('U8 keeps ordinary and fatal diagnostics on stdout with stderr empty', () => {
    const success = run(['--set', 'docs', '--check', '--dir', tempDir()])
    const failure = run(['--audit-overlap'])
    expect(success.status).toBe(0)
    expect(success.stdout).toContain('adopt: workflow-toolbox')
    expect(success.stderr).toBe('')
    expect(failure.status).toBe(1)
    expect(failure.stdout).toBe('adopt: --user-dir is required with --audit-overlap\n')
    expect(failure.stderr).toBe('')
  })

  it('U9 normalizes trailing EOF whitespace when classifying managed content', () => {
    const target = tempDir()
    const config = tempDir('wt-adopt-refactor-config-')
    expect(run(['--set', 'rules', '--install', '--file', RULE, '--dir', target], { config }).status).toBe(0)
    const file = join(target, RULE)
    writeFileSync(file, `${readFileSync(file, 'utf8').replace(/[ \t\r\n]+$/u, '')} \t\n\n`)
    const result = run(['--set', 'rules', '--check', '--dir', target], { config })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`${RULE}: UP-TO-DATE`)
    expect(result.stdout).not.toContain(`${RULE}: EDITED`)
  })

  it('keeps registered-agent discovery output sorted', () => {
    const result = run(['--set', 'agents', '--check', '--dir', tempDir()])
    const names = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('  - workflow-toolbox:') && !line.includes(' is shadowed'))
      .map((line) => line.slice('  - workflow-toolbox:'.length))
    expect(names.length).toBeGreaterThan(1)
    expect(names).toEqual([...names].sort())
  })

  it('loads the manifest before refusing multi-set target flags', () => {
    const script = join(tempDir(), 'install.mjs')
    cpSync(SCRIPT, script)
    const result = run(['--set', 'all', '--check', '--dir', tempDir()], { script })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('adopt: could not locate the plugin manifest (.claude-plugin/plugin.json) above this script\n')
  })

  it('keeps backup basenames in the Date.now public format', () => {
    const config = tempDir('wt-adopt-refactor-config-')
    writeFileSync(join(config, 'settings.json'), '{}\n')
    const result = run(['--set', 'rules', '--install', '--dir', tempDir()], { config })
    const match = result.stdout.match(/backup (settings\.json\.workflow-toolbox\.bak\.\d+) created/)
    expect(match).not.toBeNull()
    expect(existsSync(join(config, basename(match![1]!)))).toBe(true)
  })

  it('verifies the exact intended settings additions before publication', () => {
    const config = tempDir('wt-adopt-refactor-config-')
    const settings = join(config, 'settings.json')
    const trace = join(config, 'workflow-toolbox/adopt-settings-trace.json')
    writeFileSync(settings, '{"theme":"dark"}\n')
    mkdirSync(join(config, 'workflow-toolbox'))
    writeFileSync(trace, '{"schemaVersion":1,"tool":"workflow-toolbox","owner":"adopt","keys":{}}\n')
    const settingsBefore = readFileSync(settings)
    const traceBefore = readFileSync(trace)
    const backupsBefore = readdirSync(config).filter((file) => file.startsWith('settings.json.workflow-toolbox.bak.'))
    const fixture = fixturePlugin()
    cpSync(join(PLUGIN, 'rules'), join(fixture.root, 'rules'), { recursive: true })
    const source = readFileSync(fixture.script, 'utf8')
    writeFileSync(
      fixture.script,
      source.replace(
        'for (const requirement of plannedWrites) nextValue.env[requirement.key] = requirement.value',
        "for (const requirement of plannedWrites) nextValue.env[requirement.key] = 'MUTATED'",
      ),
    )
    const result = run(['--set', 'rules', '--install', '--dir', tempDir()], { config, plugin: fixture.root, script: fixture.script })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('settings write verification failed')
    expect(result.stdout).toContain('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH')
    expect(readFileSync(settings)).toEqual(settingsBefore)
    expect(readFileSync(trace)).toEqual(traceBefore)
    expect(readdirSync(config).filter((file) => file.startsWith('settings.json.workflow-toolbox.bak.'))).toEqual(backupsBefore)
  })

  it('preserves replacement metacharacters in an adopted script transformation', () => {
    const fixture = fixturePlugin()
    cpSync(join(PLUGIN, 'bin'), join(fixture.root, 'bin'), { recursive: true })
    const marker = "replacement tokens: $` $& $' $$"
    const generatedImport = "import os from 'node:os'\nimport { pathToFileURL } from 'node:url'"
    const source = readFileSync(fixture.script, 'utf8')
    expect(source).toContain(generatedImport)
    const markerInTemplateSource = marker.split('`').join('\\`')
    writeFileSync(fixture.script, source.replace(generatedImport, () => `${generatedImport}\n// ${markerInTemplateSource}`))
    const target = tempDir()

    const result = run(['--set', 'scripts', '--install', '--file', 'wt-lane-wait.mjs', '--dir', target], {
      plugin: fixture.root,
      script: fixture.script,
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(readFileSync(join(target, 'wt-lane-wait.mjs'), 'utf8')).toContain(`// ${marker}`)
  })
})

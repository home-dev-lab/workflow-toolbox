import { spawnSync } from '../../../test-support/bounded-hook-spawn.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The render-props schema lock compares the props the pane may use with a committed copy of the host
// declarations. The installed declarations are read only by the separate drift detector, which warns
// by default so that an update of the host alone never turns the suite red.
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FIXTURES = join(REPO_ROOT, 'toolkit', 'packages', 'build', 'test', 'fixtures', 'what-is-running')
const SELFTEST = join(FIXTURES, 'hooks.selftest.mjs')
const DECLARATIONS_FIXTURE = join(FIXTURES, 'render-props.host.d.ts')

let scratch = ''
let drifted = ''

function runSelftest(filter: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [SELFTEST], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: join(scratch, 'home'),
      XDG_STATE_HOME: join(scratch, 'state'),
      CLAUDE_CONFIG_DIR: join(scratch, 'config'),
      CLAUDE_PLUGIN_DATA: join(scratch, 'plugin-data'),
      NPM_CONFIG_PREFIX: join(scratch, 'npm'),
      WT_WIR_HOST_DRIFT_STRICT: '', ...env, WT_WIR_SELFTEST_FILTER: filter, NODE_NO_WARNINGS: '1',
    },
  })
}

// A copy of the committed declarations where the host adds one Box prop, written where the installed
// host keeps its declarations under a scratch config dir.
function writeDriftedHost(root: string) {
  const source = readFileSync(DECLARATIONS_FIXTURE, 'utf8')
  const changed = source.replace(/(export\s+type\s+BoxProps\s*=\s*\{\r?\n)/, "$1    overflowX?: 'visible' | 'scroll';\n")
  expect(changed).not.toBe(source)
  const typesDir = join(root, 'config', 'plugins', 'marketplaces', 'claude-code-plugins', 'mods', 'types')
  mkdirSync(typesDir, { recursive: true })
  writeFileSync(join(typesDir, 'claude-code.d.ts'), changed)
  return join(typesDir, 'claude-code.d.ts')
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wir-render-props-'))
  for (const name of ['home', 'state', 'config', 'plugin-data', 'npm']) mkdirSync(join(scratch, name), { recursive: true })
  drifted = writeDriftedHost(scratch)
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

describe('what-is-running render-props lock and host drift detector', () => {
  it('the schema lock stays green when the installed host declarations drift', () => {
    const result = runSelftest('[blank pane fix schema lock]', {
      WT_HOST_CLAUDE_CONFIG_DIR: join(scratch, 'config'),
      WT_WIR_HOST_DECLARATIONS: drifted,
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('PASS [blank pane fix schema lock] checked-in render props match the committed host declarations')
    expect(result.stdout).not.toContain('WARN host drift')
  })

  it('the drift detector warns, names the installed version and how to refresh, and passes', () => {
    const result = runSelftest('[host drift detector]', { WT_WIR_HOST_DECLARATIONS: drifted, WT_WIR_HOST_VERSION: '9.9.9-test' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('WARN host drift')
    expect(result.stdout).toContain('installed Claude Code 9.9.9-test')
    expect(result.stdout).toContain('Box.props +overflowX')
    expect(result.stdout).toContain('render-props.host.d.ts')
    expect(result.stdout).toContain('Remedy:')
    expect(result.stdout).toContain('tests: 1/1')
  })

  it('the drift detector fails on drift only in strict mode', () => {
    const result = runSelftest('[host drift detector]', {
      WT_WIR_HOST_DECLARATIONS: drifted, WT_WIR_HOST_VERSION: '9.9.9-test', WT_WIR_HOST_DRIFT_STRICT: '1',
    })
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout).toContain('FAIL [host drift detector]')
    expect(result.stdout).toContain('Box.props +overflowX')
  })

  it('the drift detector turns unreadable declarations into a warning, not a failure', () => {
    const result = runSelftest('[host drift detector]', { WT_WIR_HOST_DECLARATIONS: scratch, WT_WIR_HOST_VERSION: '9.9.9-test' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('WARN host drift')
    expect(result.stdout).toContain('no longer parse')
  })

})

describe('what-is-running host version probe and installed declarations', () => {
  it.skipIf(process.platform === 'win32')('the drift detector ends a version probe that ignores SIGTERM', () => {
    const bin = join(scratch, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'claude'), "#!/bin/sh\ntrap '' TERM\nexec sleep 40\n", { mode: 0o755 })
    const startedAt = Date.now()
    const result = runSelftest('[host drift detector]', { WT_WIR_HOST_DECLARATIONS: drifted, WT_WIR_HOST_VERSION: '', PATH: `${bin}:${process.env.PATH}` })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('installed Claude Code unknown (claude --version ETIMEDOUT')
    expect(Date.now() - startedAt).toBeLessThan(30_000)
  }, 60_000)

  it('the real host drift detector passes whatever the installed declarations say, and shows its warning', () => {
    const result = runSelftest('[host drift detector]', {
      HOME: process.env.HOME ?? '',
      XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? '',
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? '',
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA ?? '',
      NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX ?? '',
    })
    for (const line of result.stdout.split('\n')) if (line.startsWith('WARN host drift')) console.warn(line)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('tests: 1/1')
  }, 30_000)

  it('the drift detector is silent when the installed declarations match the committed copy', () => {
    const result = runSelftest('[host drift detector]', { WT_WIR_HOST_DECLARATIONS: DECLARATIONS_FIXTURE, WT_WIR_HOST_VERSION: '9.9.9-test' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).not.toContain('WARN host drift')
    expect(result.stdout).toContain('tests: 1/1')
  })
})

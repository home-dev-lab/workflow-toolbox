import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime module
import { loadedVersionModule } from '../../../test-support/loaded-version-fixture.mjs'

const cli = fileURLToPath(loadedVersionModule('bin/wt-loaded-version.mjs'))
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000 })

describe('wt-loaded-version CLI', () => {
  it('--help prints usage and exits 0', () => {
    const result = run('--help')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^Usage: wt-loaded-version --plugin <name>/)
  })

  it('a missing --plugin is exit 2 with the reason', () => {
    const result = run('--expect', '1.0.0')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--plugin <name> is required')
  })

  it('a plugin name that is not a path segment is exit 2', () => {
    const result = run('--plugin', '../etc', '--list')
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/plugin name must match/)
  })

  it('neither --expect nor --list is exit 2, never a silent listing', () => {
    const result = run('--plugin', 'demo')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('exactly one of --expect <version> or --list')
  })

  it('an unknown argument is exit 2', () => {
    const result = run('--plugin', 'demo', '--bogus')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unexpected argument "--bogus"')
  })

  it('a real scan prints the summary line first and exits with its own code', () => {
    const result = run('--plugin', 'no-such-plugin-for-this-test', '--expect', '1.0.0')
    const summary = result.stdout.split('\n')[0]
    const exitField = /EXIT=(\d+)/.exec(summary)?.[1]
    expect(summary).toMatch(/^loaded-version: plugin=no-such-plugin-for-this-test expect=1\.0\.0 sessions=\d+ /)
    expect(String(result.status)).toBe(exitField)
    if (process.platform === 'linux') expect(result.status).not.toBe(1)
    else expect(result.status).toBe(2)
  })

  it('--json prints one parseable object', () => {
    const result = run('--plugin', 'no-such-plugin-for-this-test', '--list', '--json')
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toMatchObject({ plugin: 'no-such-plugin-for-this-test', expect: null, exitCode: result.status })
  })
})

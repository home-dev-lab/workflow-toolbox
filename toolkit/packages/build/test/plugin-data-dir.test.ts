import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import { resolvePluginDataDir } from '../../../../plugin/bin/lib/plugin-data-dir.mjs'

const ROOT = join(import.meta.dirname, '../../../..')

function carryOverFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-legacy-carryover-'))
  const name = 'workflow-toolbox'
  const configDir = join(root, 'config')
  const fallback = join(root, 'state', name)
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
    [`${name}@marketplace`]: { version: '999.0.0' },
  }))
  mkdirSync(fallback, { recursive: true })
  writeFileSync(join(fallback, 'original.ndjson'), '{"original":true}\n')
  return { root, fallback, options: { env: {}, configDir, pluginName: name, fallback,
    minimumVersion: '1.0.0', stderr: { write() {} } } }
}

describe('plugin data directory resolver', () => {
  it('accepts only this plugin data directory and preserves the XDG fallback', () => {
    const result = spawnSync(process.execPath, [join(ROOT, 'plugin/bin/lib/plugin-data-dir.selftest.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), 'wt-plugin-data-test-')) },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('11 passed')
  })

  it('preserves a late legacy writer when removing the emptied legacy directory', () => {
    const { root, fallback, options } = carryOverFixture()
    const row = '{"late":true}\n'
    function beforeRemoval(path: fs.PathLike) {
      const value = relative(root, String(path))
      if (value.startsWith('..') || isAbsolute(value)) throw new Error('removal outside scratch root')
      if (String(path) === fallback) writeFileSync(join(fallback, 'late.ndjson'), row)
    }
    try {
      const injectedFs = {
        ...fs,
        rmSync(path: fs.PathLike, opts?: fs.RmOptions) { beforeRemoval(path); return fs.rmSync(path, opts) },
        rmdirSync(path: fs.PathLike, opts?: fs.RmDirOptions) { beforeRemoval(path); return fs.rmdirSync(path, opts) },
      }
      const result = resolvePluginDataDir({ ...options, fs: injectedFs })
      expect(existsSync(join(fallback, 'late.ndjson'))).toBe(true)
      expect(readFileSync(join(fallback, 'late.ndjson'), 'utf8')).toBe(row)
      expect(readFileSync(join(result.dir, 'original.ndjson'), 'utf8')).toBe('{"original":true}\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes the empty legacy directory after carrying over its original file', () => {
    const { root, fallback, options } = carryOverFixture()
    try {
      const result = resolvePluginDataDir(options)
      expect(existsSync(fallback)).toBe(false)
      expect(readFileSync(join(result.dir, 'original.ndjson'), 'utf8')).toBe('{"original":true}\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

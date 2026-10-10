import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const modulePath = process.env.WT_SKILL_SIZE_TEST_MODULE ?? join(root, 'toolkit/scripts/skill-size.mjs')
const implementation = await import(pathToFileURL(resolve(modulePath)).href)
const checker = () => implementation
const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-skill-size-'))
  temporary.push(dir)
  return dir
}

function put(rootDir: string, name: string, text: string) {
  const dir = join(rootDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), text)
}

describe('skill size threshold', () => {
  it('uses the named 8000 default and rejects malformed overrides', () => {
    const { DEFAULT_SKILL_SIZE_WARN_CHARS, skillSizeThreshold } = checker()
    expect(DEFAULT_SKILL_SIZE_WARN_CHARS).toBe(8000)
    for (const value of [undefined, '', 'oops', '8000oops', '-1', 'Infinity', '9007199254740992']) {
      expect(skillSizeThreshold({ WT_SKILL_SIZE_WARN_CHARS: value })).toBe(8000)
    }
  })

  it('honours valid overrides including zero', () => {
    const { skillSizeThreshold } = checker()
    expect(skillSizeThreshold({ WT_SKILL_SIZE_WARN_CHARS: ' 123 ' })).toBe(123)
    expect(skillSizeThreshold({ WT_SKILL_SIZE_WARN_CHARS: '0' })).toBe(0)
  })
})

describe('authoring skill size report', () => {
  it('reports every oversized body with exact Unicode characters and remedy', () => {
    const dir = fixture()
    put(dir, 'alpha', '😀'.repeat(8001))
    put(dir, 'beta', 'é'.repeat(8002))
    put(dir, 'boundary', 'x'.repeat(8000))
    const lines: string[] = []
    expect(checker().reportSkillSizes(dir, (line: string) => lines.push(line), {})).toBe(0)
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('alpha: 8001 characters')
    expect(lines[1]).toContain('beta: 8002 characters')
    for (const line of lines) {
      expect(line).toContain('references/')
      expect(line).toContain('keep the body short')
    }
  })

  it('applies overrides to the scan and falls back for unparsable text', () => {
    const dir = fixture()
    put(dir, 'reference', 'x'.repeat(8001))
    const scan = checker().oversizedSkills
    expect(scan(dir, { WT_SKILL_SIZE_WARN_CHARS: '8001' }).length).toBe(0)
    expect(scan(dir, { WT_SKILL_SIZE_WARN_CHARS: '8000oops' }).length).toBe(1)
    expect(scan(dir, { WT_SKILL_SIZE_WARN_CHARS: '0' })[0].characters).toBe(8001)
  })
})

describe('skill scan scope', () => {
  it('skips symlinked directories and bodies rather than reading outside the scan', (context) => {
    const dir = fixture()
    const outside = fixture()
    put(outside, 'external', 'x'.repeat(9000))
    mkdirSync(join(dir, 'body-link'))
    try {
      symlinkSync(join(outside, 'external'), join(dir, 'directory-link'), 'junction')
      symlinkSync(join(outside, 'external/SKILL.md'), join(dir, 'body-link/SKILL.md'), 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('symlink permission unavailable'); return }
      throw error
    }
    expect(checker().oversizedSkills(dir, {}).length).toBe(0)
  })
})

describe('shipped skill quality report', () => {
  it('reports shipped skills through the CLI without failing the gate', () => {
    const result = spawnSync(process.execPath, [join(root, 'toolkit/scripts/skill-size-check.mjs')], {
      encoding: 'utf8', env: { ...process.env, WT_SKILL_SIZE_WARN_CHARS: '8000' }, timeout: 5000,
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('pilot-wave:')
    expect(result.stdout).toContain('characters')
    expect(readFileSync(join(root, 'toolkit/scripts/script-gates.mjs'), 'utf8')).toContain('scripts/skill-size-check.mjs')
  })
})

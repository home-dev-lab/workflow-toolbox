import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// A shipped plugin must never register a pointer listener. Claude Code answers one by
// asking the terminal for pixel mouse reports; a multiplexer that only knows cells then
// sends cell coordinates that are read as pixels, and every click lands far from where
// the user clicked. Use the host's native Button for click targets instead.
//
// The scan refuses the bare token in any shipped code file, so every spelling of the
// call (optional chaining, bracket access, destructuring, aliasing) is caught. A Client
// module must live inside the plugin, so it is one of the scanned files too. The host's own
// type stubs, which Claude Code writes (git-ignored) into .claude-plugin/types/ when it loads
// the plugin from a checkout, declare onPointer and are not shipped code.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/
const POINTER_TOKEN = /\bonPointer\b/

function shippedRoots(root: string): string[] {
  const roots = [join(root, 'plugin')]
  const plugins = join(root, 'plugins')
  if (existsSync(plugins)) {
    for (const name of readdirSync(plugins)) {
      const dir = join(plugins, name)
      if (lstatSync(dir).isDirectory()) roots.push(dir)
    }
  }
  return roots
}

function codeFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const path = join(dir, name)
    if (path.endsWith(join('.claude-plugin', 'types'))) continue
    const stat = lstatSync(path)
    if (stat.isDirectory()) codeFiles(path, found)
    else if (stat.isFile() && CODE_FILE.test(name)) found.push(path)
  }
  return found
}

function pointerListenerViolations(root: string): string[] {
  return shippedRoots(root).flatMap((shipped) => codeFiles(shipped))
    .filter((file) => POINTER_TOKEN.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file))
}

const SPELLINGS: Array<[string, string]> = [
  ['direct call', 'surface.onPointer((event) => {})'],
  ['optional call', 'surface.onPointer?.((event) => {})'],
  ['optional chain', 'surface?.onPointer((event) => {})'],
  ['bracket access', "surface['onPointer']((event) => {})"],
  ['destructured alias', 'const { onPointer: listen } = surface; listen(() => {})'],
  ['stored reference', 'const listen = surface.onPointer; listen.call(surface, () => {})'],
]

describe('no shipped plugin registers a pointer listener', () => {
  const temps: string[] = []
  afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  function fixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'no-pointer-'))
    temps.push(root)
    mkdirSync(join(root, 'plugin/hooks'), { recursive: true })
    writeFileSync(join(root, 'plugin/hooks/hooks.js'), 'export const register = () => {}\nconst supervisionPointer = 1\n')
    return root
  }

  it('scans plugin/ and every plugins/* directory of this repository', () => {
    const roots = shippedRoots(repoRoot).map((dir) => relative(repoRoot, dir))
    expect(roots).toContain('plugin')
    expect(roots.length).toBeGreaterThan(1)
  })

  it('finds no onPointer in any shipped code file', () => {
    expect(pointerListenerViolations(repoRoot)).toEqual([])
  })

  it('accepts a clean tree whose identifiers merely contain the letters', () => {
    expect(pointerListenerViolations(fixtureRoot())).toEqual([])
  })

  it('skips the host type stubs Claude Code generates under .claude-plugin/types', () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'plugin/.claude-plugin/types/claude-code'), { recursive: true })
    writeFileSync(join(root, 'plugin/.claude-plugin/types/claude-code/index.d.ts'), 'onPointer(listener: () => void): void\n')
    expect(pointerListenerViolations(root)).toEqual([])
  })

  it.each(SPELLINGS)('refuses the %s spelling in plugin/', (_name, code) => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'plugin/hooks/button.ts'), `export default (props, surface) => { ${code} }\n`)
    expect(pointerListenerViolations(root)).toEqual(['plugin/hooks/button.ts'])
  })

  it('refuses a pointer-listening Client module in a plugins/* directory', () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'plugins/other/hooks'), { recursive: true })
    writeFileSync(join(root, 'plugins/other/hooks/entry.tsx'), '<Client module="./press.ts" />\n')
    writeFileSync(join(root, 'plugins/other/hooks/press.ts'), 'export default (p, surface) => surface.onPointer(() => {})\n')
    expect(pointerListenerViolations(root)).toEqual(['plugins/other/hooks/press.ts'])
  })
})

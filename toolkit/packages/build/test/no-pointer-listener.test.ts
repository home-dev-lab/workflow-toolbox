import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A shipped plugin must never register a pointer listener. Claude Code answers one by
// asking the terminal for pixel mouse reports; a multiplexer that only knows cells then
// sends cell coordinates that are read as pixels, and every click lands far from where
// the user clicked. Use the host's native Button for click targets instead.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/
const POINTER_CALL = /\bonPointer\s*\(/
const CLIENT_MODULE = /<Client\b[^>]*\bmodule\s*=\s*["']([^"']+)["']|\bClient\s*\(\s*\{[^}]*\bmodule\s*:\s*["']([^"']+)["']/g

export function shippedRoots(root: string): string[] {
  const roots = [join(root, 'plugin')]
  const plugins = join(root, 'plugins')
  if (existsSync(plugins)) {
    for (const name of readdirSync(plugins)) {
      const dir = join(plugins, name)
      if (statSync(dir).isDirectory()) roots.push(dir)
    }
  }
  return roots
}

function codeFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) codeFiles(path, found)
    else if (CODE_FILE.test(name)) found.push(path)
  }
  return found
}

function clientModuleViolations(file: string, source: string, root: string): string[] {
  const violations: string[] = []
  for (const match of source.matchAll(CLIENT_MODULE)) {
    const target = resolve(dirname(file), match[1] ?? match[2] ?? '')
    if (existsSync(target) && POINTER_CALL.test(readFileSync(target, 'utf8'))) {
      violations.push(`${relative(root, file)} renders Client module ${relative(root, target)}, which calls onPointer`)
    }
  }
  return violations
}

export function pointerListenerViolations(root: string): string[] {
  const violations: string[] = []
  for (const shipped of shippedRoots(root)) {
    for (const file of codeFiles(shipped)) {
      const source = readFileSync(file, 'utf8')
      if (POINTER_CALL.test(source)) violations.push(`${relative(root, file)} calls onPointer`)
      violations.push(...clientModuleViolations(file, source, root))
    }
  }
  return violations
}

describe('no shipped plugin registers a pointer listener', () => {
  it('scans plugin/ and every plugins/* directory', () => {
    const roots = shippedRoots(repoRoot).map((dir) => relative(repoRoot, dir))
    expect(roots).toContain('plugin')
    expect(roots.length).toBeGreaterThan(1)
  })

  it('finds no onPointer call and no Client module that makes one', () => {
    expect(pointerListenerViolations(repoRoot)).toEqual([])
  })

  it('the What is running hooks manifest loads the plain module with native buttons', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'plugin/hooks/hooks.json'), 'utf8'))
    expect(manifest.modules).toEqual(['./hooks.js'])
  })
})

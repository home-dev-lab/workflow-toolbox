import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../../../plugin')
const HOST_ROOT = join(ROOT, 'bin', 'lib', 'host')
const GENERATED = new Set([join(ROOT, 'bin', 'wt-observe.mjs')])
const RAW_PARENT_TABLE = /(?:\[['"]-eo['"],\s*['"]pid=,ppid=['"]\]|Get-CimInstance\s+Win32_Process[^\n]*ParentProcessId)/

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return path === HOST_ROOT ? [] : sourceFiles(path)
    return entry.isFile() && extname(path) === '.mjs' && !GENERATED.has(path) ? [path] : []
  })
}

describe('pid to parent-pid host perimeter', () => {
  it('keeps the raw process-table primitive inside the host adapter', () => {
    const perimeter = sourceFiles(ROOT)
    const violations = perimeter.filter((path) => RAW_PARENT_TABLE.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path).replaceAll('\\', '/'))
    // external-model-env.mjs expands the perimeter; provider-definitions.mjs remains behind HOST_ROOT.
    expect({ perimeterFiles: perimeter.length, violations }).toEqual({ perimeterFiles: 215, violations: [] })
  })
})

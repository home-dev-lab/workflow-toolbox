import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DEBUGGER_ENTRIES } from '../build-bundles.js'

// The shipped plugin/bin artifact must equal the toolkit/bin source-of-truth; this guard
// catches MANUAL drift only — regenerate both by hand with `pnpm debugger:build` at ship time.
const here = dirname(fileURLToPath(import.meta.url)) // packages/debugger/test
const toolkitRoot = join(here, '..', '..', '..') // toolkit
const repoRoot = join(toolkitRoot, '..')

// Every shipped node CLI, DERIVED from the single source of truth in build-bundles.ts — not a
// parallel hardcoded list, so adding/renaming a CLI wires up this twin-integrity gate automatically.
const BINS = DEBUGGER_ENTRIES.map((e) => e.out)

describe.each(BINS)('bundled artifact integrity — %s', (bin) => {
  const toolkitBin = join(toolkitRoot, 'bin', bin)
  const pluginBin = join(repoRoot, 'plugin', 'bin', bin)

  it('both bin copies exist (run `pnpm debugger:build` if missing)', () => {
    expect(existsSync(toolkitBin)).toBe(true)
    expect(existsSync(pluginBin)).toBe(true)
  })

  it(`plugin/bin/${bin} is byte-identical to toolkit/bin/${bin}`, () => {
    expect(readFileSync(pluginBin, 'utf8')).toBe(readFileSync(toolkitBin, 'utf8'))
  })

  it('the shipped artifact carries the node shebang and bundles zero npm deps', () => {
    const src = readFileSync(pluginBin, 'utf8')
    expect(src.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(src).not.toMatch(/node_modules/)
  })
})

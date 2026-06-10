// globals-typecheck.test.ts — validates packages/runtime/globals.d.ts compiles
// cleanly and that the glue snippet's free variables all resolve to declared
// ambient globals.
//
// This is the FIRST place globals.d.ts has ever been compiled — previously it
// was never included in any tsconfig. The TypeScript compiler API is used here
// so we can assert on diagnostics without actually emitting files.

import { describe, it, expect, afterEach } from 'vitest'
import * as ts from 'typescript'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SANDBOX_GLOBAL_NAMES } from '../src/bundle.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Path to the real globals.d.ts (outside src/, at package root).
// From packages/build/test/ -> ../../runtime/globals.d.ts (sibling package).
const GLOBALS_DTS = path.resolve(__dirname, '../../runtime/globals.d.ts')

// CompilerOptions that match how the glue snippet will be consumed:
// strict, noEmit, ES2022, ESNext modules, bundler resolution.
const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
}

const tmpFiles: string[] = []

function writeTmp(content: string, suffix = '.ts'): string {
  const tmpDir = os.tmpdir()
  const file = path.join(tmpDir, `wt-typecheck-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`)
  fs.writeFileSync(file, content, 'utf8')
  tmpFiles.push(file)
  return file
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f) } catch { /* ignore */ }
  }
})

function getDiagnostics(snippetFile: string): ts.Diagnostic[] {
  const program = ts.createProgram([snippetFile, GLOBALS_DTS], COMPILER_OPTIONS)
  return ts.getPreEmitDiagnostics(program).filter(d => d.file?.fileName === snippetFile) as ts.Diagnostic[]
}

// ---------------------------------------------------------------------------
// POSITIVE case: glue snippet using SANDBOX_GLOBAL_NAMES names resolves cleanly
// ---------------------------------------------------------------------------

describe('globals-typecheck — positive: glue snippet typechecks', () => {
  it('zero diagnostics for a snippet using all SANDBOX_GLOBAL_NAMES globals', () => {
    // Generate a snippet referencing every SANDBOX_GLOBAL_NAMES name — these are declared
    // in globals.d.ts; the snippet must typecheck with zero errors.
    const snippet = [
      `const __rt = { ${SANDBOX_GLOBAL_NAMES.join(', ')} };`,
      `const __a: unknown = typeof args !== 'undefined' ? args : undefined;`,
      `export {}`,
    ].join('\n')

    const snippetFile = writeTmp(snippet)
    const diagnostics = getDiagnostics(snippetFile)

    expect(diagnostics).toHaveLength(0)
  })

  it('globals.d.ts itself compiles without errors', () => {
    // A minimal snippet that just imports — verifies the .d.ts is self-consistent
    const snippet = `export {}`
    const snippetFile = writeTmp(snippet)
    const program = ts.createProgram([snippetFile, GLOBALS_DTS], COMPILER_OPTIONS)
    const allDiag = ts.getPreEmitDiagnostics(program)
    // Filter to diagnostics originating in globals.d.ts
    const globalsErrors = Array.from(allDiag).filter(
      d => d.file?.fileName === GLOBALS_DTS,
    )
    expect(globalsErrors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// NEGATIVE case: the check must have teeth
// ---------------------------------------------------------------------------

describe('globals-typecheck — negative: bogus global produces diagnostic', () => {
  it('diagnostics.length > 0 for a snippet referencing zzyzx (non-existent global)', () => {
    const snippet = [
      `const __bad = zzyzx;`,
      `export {}`,
    ].join('\n')

    const snippetFile = writeTmp(snippet)
    const diagnostics = getDiagnostics(snippetFile)

    expect(diagnostics.length).toBeGreaterThan(0)
  })

  it('diagnostic message mentions zzyzx', () => {
    const snippet = [
      `const __bad = zzyzx;`,
      `export {}`,
    ].join('\n')

    const snippetFile = writeTmp(snippet)
    const diagnostics = getDiagnostics(snippetFile)

    const messages = diagnostics.map(d =>
      ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    )
    expect(messages.some(m => m.includes('zzyzx'))).toBe(true)
  })
})

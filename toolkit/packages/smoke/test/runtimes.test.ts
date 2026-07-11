import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { claudeBinCandidates, resolveClaudeBinary, resolveClaudeRuntime } from '../src/runtimes.js'

// resolveClaudeRuntime probes candidates with `--version` and must surface BOTH the
// path and the parsed version from that ONE probe (the observe-ui dev server reports
// them in /api/health — S1 version observability). Hermetic via $CLAUDE_BIN pointing
// at throwaway fixture scripts; the fall-through cases only assert the fixture is
// NOT picked (what PATH then resolves is machine-dependent).

let dir: string
const savedClaudeBin = process.env['CLAUDE_BIN']
const isWin = process.platform === 'win32'

// execFileSync (no shell) needs the file's REAL extension to find and run it — a
// POSIX shebang script with no extension isn't natively spawnable on win32 at all
// (unlike a bare PATH lookup, there is no PATHEXT-style resolution here). Fixtures
// are written as .cmd batch files on win32, matching what the prod probe
// (resolveClaudeRuntime → execFileSync(bin, ['--version'])) can actually execute
// there; POSIX shell scripts are unchanged elsewhere.
function fixtureBin(name: string, posixScript: string, cmdScript: string): string {
  const p = join(dir, isWin ? `${name}.cmd` : name)
  writeFileSync(p, isWin ? cmdScript : posixScript, 'utf8')
  chmodSync(p, 0o755)
  return p
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'runtimes-test-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  if (savedClaudeBin === undefined) delete process.env['CLAUDE_BIN']
  else process.env['CLAUDE_BIN'] = savedClaudeBin
})

describe('resolveClaudeRuntime', () => {
  it('resolves $CLAUDE_BIN and parses its version from the SAME probe', () => {
    const bin = fixtureBin('claude-ok',
      '#!/bin/sh\necho "9.9.9 (Claude Code)"\n',
      '@echo off\r\necho 9.9.9 (Claude Code)\r\n')
    process.env['CLAUDE_BIN'] = bin
    expect(resolveClaudeRuntime()).toEqual({ path: bin, version: '9.9.9' })
    // the path-only wrapper agrees
    expect(resolveClaudeBinary()).toBe(bin)
  })

  it('a binary that answers but prints no parseable version resolves with version null', () => {
    const bin = fixtureBin('claude-noversion',
      '#!/bin/sh\necho "hello"\n',
      '@echo off\r\necho hello\r\n')
    process.env['CLAUDE_BIN'] = bin
    expect(resolveClaudeRuntime()).toEqual({ path: bin, version: null })
  })

  it('a failing $CLAUDE_BIN falls through to the next candidate (never returned)', () => {
    const bin = fixtureBin('claude-broken',
      '#!/bin/sh\nexit 1\n',
      '@echo off\r\nexit /b 1\r\n')
    process.env['CLAUDE_BIN'] = bin
    expect(resolveClaudeRuntime()?.path).not.toBe(bin)
  })

  it('a RELATIVE $CLAUDE_BIN is refused (never returned — cwd-dependent exec surface)', () => {
    process.env['CLAUDE_BIN'] = './claude'
    expect(resolveClaudeRuntime()?.path).not.toBe('./claude')
  })

  it('path AND version come from ONE probe — the binary is spawned exactly once', () => {
    const counter = join(dir, 'spawn-count')
    writeFileSync(counter, '', 'utf8')
    const bin = fixtureBin('claude-counting',
      `#!/bin/sh\necho x >> ${counter}\necho "9.9.9 (Claude Code)"\n`,
      `@echo off\r\necho x>>"${counter}"\r\necho 9.9.9 (Claude Code)\r\n`)
    process.env['CLAUDE_BIN'] = bin
    expect(resolveClaudeRuntime()).toEqual({ path: bin, version: '9.9.9' })
    // one line = one spawn; cmd's `echo` always terminates with CRLF on win32.
    expect(readFileSync(counter, 'utf8')).toBe(isWin ? 'x\r\n' : 'x\n')
  })
})

// Cross-OS I4 review fix: the isAbsolute acceptance rule, testable from any OS via the
// injected platform (bare node:path would judge 'C:\...' under the TEST host's semantics).
describe('claudeBinCandidates', () => {
  it("win32: an absolute 'C:\\...' CLAUDE_BIN is ACCEPTED as first candidate", () => {
    const r = claudeBinCandidates('C:\\Users\\u\\claude.exe', 'win32', 'C:\\Users\\u')
    expect(r.rejectedRelative).toBeNull()
    expect(r.candidates[0]).toBe('C:\\Users\\u\\claude.exe')
  })

  it('win32: a relative CLAUDE_BIN is rejected (reported, not silently dropped)', () => {
    const r = claudeBinCandidates('bin\\claude.exe', 'win32', 'C:\\Users\\u')
    expect(r.rejectedRelative).toBe('bin\\claude.exe')
    expect(r.candidates[0]).toBe('claude')
  })

  it('linux: POSIX semantics unchanged — /abs accepted, relative rejected', () => {
    expect(claudeBinCandidates('/opt/claude', 'linux', '/home/u').candidates[0]).toBe('/opt/claude')
    expect(claudeBinCandidates('./claude', 'linux', '/home/u').rejectedRelative).toBe('./claude')
  })
})

// runtimes.ts — resolve the runtime FACTS the canary matrix needs: which Claude
// Code binary each target drives, the installed Agent SDK version, and the latest
// SDK published on npm. Impure (spawns, fs, optional network) — kept out of
// `pnpm test`. The version of the binary that actually RAN is read from each run's
// init message (lib.readInitVersion); this module only resolves the binary PATH
// and the SDK package versions.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, posix as posixPath, win32 as win32Path } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunnerOptions } from './lib.js'
import { parseClaudeVersion } from './version.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// src → smoke → packages → toolkit → repo root
export const MARKER_PATH = join(HERE, '..', '..', '..', '..', '.upgrade-canary-state.json')
export const SDK_PKG = '@anthropic-ai/claude-agent-sdk'

export type TargetName = 'system' | 'bundled'
export interface Target {
  name: TargetName
  opts: RunnerOptions
}

/** Resolve a working `claude` CLI: $CLAUDE_BIN → PATH → ~/.local/bin/claude.
 *  Returns the first candidate that answers `--version`, else null. Each probe is
 *  TIMEBOXED — a stalling shim/wrapper must not hang the caller (the observe-ui
 *  dev server resolves this synchronously at startup, before listen()). A relative
 *  $CLAUDE_BIN is refused (it would resolve against an arbitrary cwd and then be
 *  handed to the SDK as the executable driving permission-bypassed runs). */
const PROBE_TIMEOUT_MS = 5_000

/** The resolved interpreter: its path AND the version parsed from the SAME
 *  `--version` probe (never a second spawn). `version` is null when the binary
 *  answers but prints nothing parseable. */
export interface ClaudeRuntime {
  path: string
  version: string | null
}

/** PURE candidate list for the claude-binary probe — extracted so the per-platform
 *  absoluteness rule is unit-testable from any OS (review finding: `isAbsolute` from
 *  bare node:path judges 'C:\...' non-absolute when the TEST runs on POSIX, so the
 *  win32 acceptance can only be asserted via an injected platform). At runtime the
 *  caller passes process.platform, which selects the semantics the OS actually has. */
export function claudeBinCandidates(envBin: string | undefined, platform: NodeJS.Platform, home: string): { candidates: string[]; rejectedRelative: string | null } {
  const abs = platform === 'win32' ? win32Path.isAbsolute : posixPath.isAbsolute
  const rejectedRelative = envBin !== undefined && envBin.length > 0 && !abs(envBin) ? envBin : null
  const candidates = [
    envBin !== undefined && abs(envBin) ? envBin : undefined,
    // Bare 'claude': PATH lookup. On win32 CreateProcess resolves claude.exe (native
    // installer) but NOT a claude.cmd npm shim — for that, set CLAUDE_BIN to the real
    // executable (documented in known-issues).
    'claude',
    join(home, '.local', 'bin', 'claude'),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0)
  return { candidates, rejectedRelative }
}

export function resolveClaudeRuntime(): ClaudeRuntime | null {
  const { candidates, rejectedRelative } = claudeBinCandidates(process.env['CLAUDE_BIN'], process.platform, homedir())
  if (rejectedRelative !== null) {
    console.warn(`[runtimes] ignoring relative CLAUDE_BIN ${JSON.stringify(rejectedRelative)} — set an absolute path`)
  }
  for (const bin of candidates) {
    try {
      // win32 (CVE-2024-27980, Node >=18.20.2/20.12.2/21.7.3): spawning a .cmd/.bat
      // WITHOUT shell:true now throws EINVAL outright — even given the full absolute
      // path, there is no shell-free way to run one. shell:true is safe here: the args
      // array is the fixed literal ['--version'], never user- or env-controlled, so
      // there is no injection surface. Without this, an EXPLICIT CLAUDE_BIN pointing at
      // an npm-installed claude.cmd shim was silently swallowed by the catch below and
      // always fell through to the next candidate — a real prod gap, not just a test one.
      const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
      const out = execFileSync(bin, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: PROBE_TIMEOUT_MS,
        ...(needsShell ? { shell: true } : {}),
      })
      return { path: bin, version: parseClaudeVersion(out) }
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** Path-only view of resolveClaudeRuntime (kept for callers that don't need the version). */
export function resolveClaudeBinary(): string | null {
  return resolveClaudeRuntime()?.path ?? null
}

/** The interactive `claude` CLI version (system runtime), or null if unresolved. */
export function getClaudeVersion(): string | null {
  return resolveClaudeRuntime()?.version ?? null
}

/** The INSTALLED Agent SDK version. The SDK does not export `./package.json`, so
 *  resolve its main entry and walk up to the owning package.json — robust against
 *  pnpm's symlinked store layout. */
export function getSdkVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    let dir = dirname(require.resolve(SDK_PKG))
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        const pkg: unknown = JSON.parse(readFileSync(candidate, 'utf8'))
        if (
          typeof pkg === 'object' &&
          pkg !== null &&
          (pkg as Record<string, unknown>)['name'] === SDK_PKG &&
          typeof (pkg as Record<string, unknown>)['version'] === 'string'
        ) {
          return (pkg as Record<string, unknown>)['version'] as string
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // fall through
  }
  return null
}

/** Absolute path to the installed SDK's `sdk.d.ts` — the ground-truth type source the
 *  schema-drift canary reads `AgentDefinition` / `Options` from. Resolves the SDK entry
 *  then walks up to the package root (where the `.d.ts` sits next to package.json),
 *  robust to pnpm's nested store layout. Null when unresolved → the drift check degrades
 *  to "schema source unavailable" rather than throwing. */
export function getSdkTypesPath(): string | null {
  try {
    const require = createRequire(import.meta.url)
    let dir = dirname(require.resolve(SDK_PKG))
    for (let i = 0; i < 10; i++) {
      const dts = join(dir, 'sdk.d.ts')
      if (existsSync(dts) && existsSync(join(dir, 'package.json'))) return dts
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // fall through
  }
  return null
}

/** The latest SDK version published on npm. Network + offline-graceful: any
 *  failure (offline, proxy, timeout, non-zero exit) returns null — this is a
 *  report line, never a gate, so it must not throw. Uses pnpm for registry-config
 *  parity with how the dep is installed. */
export function getLatestSdkVersion(): string | null {
  try {
    const out = execFileSync('pnpm', ['view', SDK_PKG, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    })
    const v = out.trim().match(/\d+\.\d+\.\d+/)?.[0]
    return v ?? null
  } catch {
    return null
  }
}

/** Build the requested runtime targets. `system` carries the resolved CLI binary
 *  via pathToClaudeCodeExecutable; `bundled` leaves it unset (SDK built-in). A
 *  system target with no resolvable binary is skipped with a warning. */
export function resolveTargets(selection: 'system' | 'bundled' | 'both'): Target[] {
  const targets: Target[] = []
  if (selection === 'system' || selection === 'both') {
    const sys = resolveClaudeBinary()
    if (sys !== null) targets.push({ name: 'system', opts: { pathToClaudeCodeExecutable: sys } })
    else console.warn('[canary] system target skipped: no `claude` binary ($CLAUDE_BIN / PATH / ~/.local/bin/claude)')
  }
  if (selection === 'bundled' || selection === 'both') {
    targets.push({ name: 'bundled', opts: {} })
  }
  return targets
}

/** Parse `--target system|bundled|both` from argv (default both). */
export function parseTargetSelection(argv: readonly string[]): 'system' | 'bundled' | 'both' {
  const i = argv.indexOf('--target')
  const v = i !== -1 ? argv[i + 1] : undefined
  return v === 'system' || v === 'bundled' ? v : 'both'
}

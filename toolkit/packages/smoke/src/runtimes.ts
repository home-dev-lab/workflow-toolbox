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
import { dirname, join } from 'node:path'
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
 *  Returns the first candidate that answers `--version`, else null. */
export function resolveClaudeBinary(): string | null {
  const candidates = [process.env['CLAUDE_BIN'], 'claude', join(homedir(), '.local', 'bin', 'claude')].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  )
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return bin
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** The interactive `claude` CLI version (system runtime), or null if unresolved. */
export function getClaudeVersion(): string | null {
  const bin = resolveClaudeBinary()
  if (bin === null) return null
  try {
    return parseClaudeVersion(execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
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

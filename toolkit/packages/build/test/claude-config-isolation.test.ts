import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CREDENTIAL_ENV_KEYS, sealedClaudeEnv } from '../../../test-support/claude-config-isolation'

// Locks card 1884998532654433637: a suite run from a developer's session started the real `claude` on that
// session's config dir and its login file lost its tokens. See test-support/claude-config-isolation.ts.

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

// A stand-in for `claude` that rewrites the login file of the config dir it resolves and reports which credential
// variables reached it (names compared case-insensitively, as a Windows child would see them). 'config' resolves
// like Claude Code (CLAUDE_CONFIG_DIR, else the home default); 'home' ignores the variable, so the seal must also
// hold through the home fallback.
const stub = (resolve: 'config' | 'home') => `
const fs = require('node:fs'), path = require('node:path')
const home = path.join(process.env.HOME || process.env.USERPROFILE, '.claude')
const dir = ${resolve === 'config' ? 'process.env.CLAUDE_CONFIG_DIR || home' : 'home'}
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{}}')
const names = Object.keys(process.env).map((k) => k.toUpperCase())
process.stdout.write(JSON.stringify({ dir, credentials: ${JSON.stringify(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'])}.filter((k) => names.includes(k)) }))
`

function fakeDeveloper() {
  const root = mkdtempSync(join(tmpdir(), 'wt-fake-developer-'))
  const home = join(root, 'home')
  const config = join(home, '.claude')
  mkdirSync(config, { recursive: true })
  const sentinel = '{"claudeAiOauth":{"accessToken":"sentinel-a","refreshToken":"sentinel-r"}}'
  writeFileSync(join(config, '.credentials.json'), sentinel)
  return { root, home, config, sentinel }
}

describe('a test worker never hands the developer\'s Claude config dir to a child', () => {
  it('runs every worker on a suite-owned CLAUDE_CONFIG_DIR with no credential variable', () => {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? ''
    expect(dirname(dir), `CLAUDE_CONFIG_DIR=${dir}`).toBe(tmpdir())
    expect(basename(dir).startsWith('wt-claude-suite-'), `CLAUDE_CONFIG_DIR=${dir}`).toBe(true)
    // Not the developer's default dir either: that one is neither under tmpdir() nor named wt-claude-suite-*.
    // Presence only: a failed assertion must never print a credential.
    const present = Object.keys(process.env).filter((k) => (CREDENTIAL_ENV_KEYS as readonly string[]).includes(k.toUpperCase()))
    expect(present).toEqual([])
    // Host declarations stay readable (a path only, never handed to a child): the schema selftest reads them.
    expect(process.env.WT_HOST_CLAUDE_CONFIG_DIR ?? '').not.toBe('')
    expect(process.env.WT_HOST_CLAUDE_CONFIG_DIR).not.toBe(dir)
  })

  for (const [variant, resolve] of [['config dir named', 'config'], ['config dir unset', 'config'], ['home fallback only', 'home']] as const) {
    it(`sealedClaudeEnv leaves the developer's login file byte-identical: ${variant}`, () => {
      const dev = fakeDeveloper()
      const base: NodeJS.ProcessEnv = { ...process.env, HOME: dev.home, USERPROFILE: dev.home, claude_code_oauth_token: 'developer-token',
        ANTHROPIC_API_KEY: 'developer-key', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: developer', CLAUDE_SECURESTORAGE_CONFIG_DIR: dev.config }
      if (variant === 'config dir named') base.CLAUDE_CONFIG_DIR = dev.config
      else delete base.CLAUDE_CONFIG_DIR
      const sealed = sealedClaudeEnv(base)
      try {
        const run = spawnSync(process.execPath, ['-e', stub(resolve)], { env: sealed.env, encoding: 'utf8' })
        expect(run.status, run.stderr).toBe(0)
        const seen = JSON.parse(run.stdout) as { dir: string, credentials: string[] }
        expect(seen.credentials).toEqual([])
        expect(seen.dir.startsWith(sealed.dir)).toBe(true)
        expect(readFileSync(join(dev.config, '.credentials.json'), 'utf8')).toBe(dev.sentinel)
      } finally {
        sealed.cleanup()
        rmSync(dev.root, { recursive: true, force: true })
      }
    })
  }
})

// Warn-only scanner (guard probation): lists every line that starts the REAL claude binary from a test or a test
// fixture without an env built by sealedClaudeEnv. Promotion: after ten suite runs in which the list holds only the
// routed real-host fixtures (card named in the warning), the whole list becomes blocking. Already-sealed files are
// blocking now, so a fixed file cannot regress.
const SEALED_FILES = ['toolkit/packages/build/test/plugin-host-validate.test.ts']
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|execa)\(\s*(?:CLAUDE\b|['"`]claude['"`])|\bexec(?:Sync)?\(\s*['"`]claude\s/
const SHELL_LAUNCH = /['"`](?:env [^'"`]*?)?claude --(?:model|plugin-dir|setting-sources)|\$\(\s*claude\s/
const SEALED_MARK = /\bsealed\.env\b|\bsealedClaudeEnv\(/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(?:[cm]?[jt]s|sh)$/.test(entry) && /(?:^|[/\\])(?:test|fixtures)[/\\]|\.test\./.test(full)) out.push(full)
  }
  return out
}

export function unsealedClaudeSpawns(root: string): string[] {
  const hits: string[] = []
  for (const file of walk(join(root, 'toolkit')).concat(walk(join(root, 'plugins')))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if ((SPAWN.test(line) || SHELL_LAUNCH.test(line)) && !SEALED_MARK.test(line)) hits.push(`${relative(root, file).replaceAll('\\', '/')}:${i + 1}`)
    })
  }
  return hits
}

describe('real claude spawns in tests carry a sealed config env', () => {
  const hits = unsealedClaudeSpawns(REPO_ROOT)
  it('blocks on files already sealed', () => {
    for (const file of SEALED_FILES) expect(existsSync(join(REPO_ROOT, file)), file).toBe(true)
    expect(hits.filter((hit) => SEALED_FILES.some((file) => hit.startsWith(`${file}:`)))).toEqual([])
  })
  it('warns on the rest (probation; real-host fixtures routed to a tracker card)', () => {
    if (hits.length) console.warn(`claude-config-isolation: ${hits.length} unsealed real-claude spawn(s), card 1885002539112334716; promotion to blocking after 10 clean runs:\n  ${hits.join('\n  ')}`)
    expect(Array.isArray(hits)).toBe(true)
  })
})

describe('the scanner sees the launch shapes it claims', () => {
  it('flags unsealed launches, including a comment saying "unsealed", exec strings and shell substitutions', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-claude-scan-'))
    try {
      mkdirSync(join(root, 'toolkit', 'test'), { recursive: true })
      mkdirSync(join(root, 'plugins'), { recursive: true })
      writeFileSync(join(root, 'toolkit', 'test', 'x.test.ts'), [
        "spawnSync(CLAUDE, ['--version']) // unsealed on purpose",
        "execSync('claude plugin validate .')",
        "spawnSync(CLAUDE, ['--version'], { env: sealed.env })",
      ].join('\n'))
      writeFileSync(join(root, 'toolkit', 'test', 'run.sh'), 'out="$(claude plugin validate "$dir" --strict)"\n')
      expect(unsealedClaudeSpawns(root).sort()).toEqual(['toolkit/test/run.sh:1', 'toolkit/test/x.test.ts:1', 'toolkit/test/x.test.ts:2'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

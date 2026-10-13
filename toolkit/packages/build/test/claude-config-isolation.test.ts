import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CREDENTIAL_ENV_KEYS, sealedClaudeEnv } from '../../../test-support/claude-config-isolation'

// Locks card 1884998532654433637: a suite run from a developer's session started the real `claude` on that
// session's config dir and its login file lost its tokens. See test-support/claude-config-isolation.ts.

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

// A stand-in for `claude` that does what the real one did: rewrite the login file of the config dir it
// resolves (CLAUDE_CONFIG_DIR, else ~/.claude), and report whether a credential variable reached it.
const STUB = `
const fs = require('node:fs'), path = require('node:path')
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{}}')
process.stdout.write(JSON.stringify({ dir, token: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) }))
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
    expect(dir.startsWith(tmpdir()), `CLAUDE_CONFIG_DIR=${dir}`).toBe(true)
    expect(dir).not.toBe(join(homedir(), '.claude'))
    for (const key of CREDENTIAL_ENV_KEYS) expect(process.env[key], key).toBeUndefined()
  })

  for (const variant of ['config dir named', 'config dir unset (home fallback)'] as const) {
    it(`sealedClaudeEnv leaves the developer's login file byte-identical: ${variant}`, () => {
      const dev = fakeDeveloper()
      const base: NodeJS.ProcessEnv = { ...process.env, HOME: dev.home, CLAUDE_CODE_OAUTH_TOKEN: 'developer-token' }
      if (variant === 'config dir named') base.CLAUDE_CONFIG_DIR = dev.config
      else delete base.CLAUDE_CONFIG_DIR
      const sealed = sealedClaudeEnv(base)
      try {
        const run = spawnSync(process.execPath, ['-e', STUB], { env: sealed.env, encoding: 'utf8' })
        expect(run.status, run.stderr).toBe(0)
        const seen = JSON.parse(run.stdout) as { dir: string, token: boolean }
        expect(seen.token).toBe(false)
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
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|execa)\(\s*(?:CLAUDE\b|['"`]claude['"`])/
const SHELL_LAUNCH = /['"`](?:env [^'"`]*?)?claude --(?:model|plugin-dir|setting-sources)/

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
      if ((SPAWN.test(line) || SHELL_LAUNCH.test(line)) && !/sealed/i.test(line)) hits.push(`${relative(root, file).replaceAll('\\', '/')}:${i + 1}`)
    })
  }
  return hits
}

describe('real claude spawns in tests carry a sealed config env', () => {
  const hits = unsealedClaudeSpawns(REPO_ROOT)
  it('blocks on files already sealed', () => {
    expect(hits.filter((hit) => SEALED_FILES.some((file) => hit.startsWith(`${file}:`)))).toEqual([])
  })
  it('warns on the rest (probation; real-host fixtures routed to a tracker card)', () => {
    if (hits.length) console.warn(`claude-config-isolation: ${hits.length} unsealed real-claude spawn(s):\n  ${hits.join('\n  ')}`)
    expect(Array.isArray(hits)).toBe(true)
  })
})

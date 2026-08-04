import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-probe-claim-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

function run(message: unknown) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: { to: 'main', message },
    }),
    encoding: 'utf8',
  })
  return {
    denied: res.stdout.includes('"deny"'),
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
  }
}

describe('wt-probe-claim-guard-hook', () => {
  it('RED: refuses a hollow pgrep-derived claim before SendMessage emits it', () => {
    const r = run(
      [
        'PROBE-CLAIM',
        'claim: lane active, 2 processes',
        'set: processes whose command line matches "lane-42"',
        'instrument: pgrep -af lane-42',
        'self-exclusion: none',
        '',
        'lane active, 2 processes',
      ].join('\n')
    )
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('hollow self-exclusion')
    expect(r.status).toBe(0)
  })

  it('GREEN: allows the same claim when the scanned set and self-exclusion are declared', () => {
    const r = run(
      [
        'PROBE-CLAIM',
        'claim: lane active, 2 processes',
        'set: processes whose command line matches "lane-42"',
        'instrument: pgrep -af lane-42',
        'self-exclusion: excluded shell pid 48122 from the matched set before counting',
        '',
        'lane active, 2 processes',
      ].join('\n')
    )
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })

  it('stays out of the way for ordinary messages with no probe-claim stanza', () => {
    const r = run('please review the diff when you have a minute')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('does not try to parse structured protocol messages', () => {
    const r = run({ type: 'shutdown_request', reason: 'done' })
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('is registered as a PreToolUse hook on SendMessage in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'SendMessage')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) => h.command?.includes('wt-probe-claim-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})

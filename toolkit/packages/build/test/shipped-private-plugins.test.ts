import { beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGINS = ['wt-secret-guard']
const PRIVATE_HOME_PATH = /\/home\/doublefx/
const PRIVATE_ID = /(?<!\d)\d{19}(?!\d)/

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}

describe('shipped private plugins', () => {
  for (const plugin of PLUGINS) {
    let selftest: SpawnSyncReturns<string>

    beforeAll(() => {
      selftest = spawnSync(process.execPath, [join(REPO_ROOT, 'plugins', plugin, 'hooks', 'hooks.selftest.mjs')], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
    })

    it(`${plugin} selftest exits successfully`, () => {
      expect(selftest.status, selftest.stderr || selftest.stdout).toBe(0)
    })

    for (const lock of [
      'prompt storage rewrites history display and nested pasted contents without changing unrelated lines or mode',
      'concurrent history appends survive every in-place overwrite byte-identical',
      'prompt storage locates the JSON-escaped secret and leaves valid same-length JSON',
      'not-found prompt storage warns exactly once without revealing the secret',
      'malformed prompt history is left untouched and does not repeat the storage notice',
      'compare-then-write mismatch writes nothing and keeps one secret-free notice',
      'history rewrite retries inside a bounded clock window when the record is initially absent',
      'prompt storage falls back from CLAUDE_CONFIG_DIR to HOME dot-claude',
      'sdk prompt storage rewrites an enqueue record written after prompt forwarding',
      'queue-operation targeting is independent of prompt origin and retries a late enqueue',
      'does not register an inert user-tier prompt.context guard',
      'plain-line op credential output is scrubbed',
      'complete concealed JSON output is scrubbed',
      'truncated concealed JSON output is scrubbed',
      'stderr-prefixed concealed JSON output is scrubbed',
      'trailing-line concealed JSON output is scrubbed',
      'concealed JSON escaped values are decoded while serialized bytes are scrubbed',
      'ordinary JSON values are not scrubbed',
      'malformed concealed JSON does not throw and scrubs its value',
      'email masking is off by default in prompts and tool results',
      'email masking option covers prompts and tool results',
      'IP masking is off by default in prompts and tool results',
      'IP masking option covers prompts and tool results',
    ]) it(`${plugin}: ${lock}`, () => expect(selftest.stdout).toContain(`PASS ${lock}`))
  }

  it('contains no machine-specific home path or private 19-digit identifier', () => {
    const hits: string[] = []
    for (const plugin of PLUGINS) for (const file of files(join(REPO_ROOT, 'plugins', plugin))) {
      const text = readFileSync(file, 'utf8')
      if (PRIVATE_HOME_PATH.test(text) || PRIVATE_ID.test(text)) hits.push(relative(REPO_ROOT, file))
    }
    expect(hits).toEqual([])
  })
})

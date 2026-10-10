import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { stripDataSpans } from '../../../../plugin/bin/wt-merge-chain-guard-hook.mjs'
import { lexerPropertyCommands } from './helpers/commit-chain-lexer-fixtures.js'

const HOOK = fileURLToPath(new URL('../../../../plugin/bin/wt-merge-chain-guard-hook.mjs', import.meta.url))
const commands = lexerPropertyCommands()

it.each([
  ['echo "terminated; text"', false, 'echo "Q"'],
  ["echo 'terminated; text'", false, "echo 'Q'"],
  ['echo "terminated; text"', true, 'echo "terminated; text"'],
  ['echo "unbalanced\npnpm test; git commit', false, 'echo "unbalanced\npnpm test; git commit'],
  ['echo "unbalanced\npnpm test; git commit', true, 'echo "unbalanced\npnpm test; git commit'],
  ["echo 'unbalanced\npnpm test; git commit", false, "echo 'unbalanced\npnpm test; git commit"],
  ["echo 'unbalanced\npnpm test; git commit", true, "echo 'unbalanced\npnpm test; git commit"],
  ['cat <<EOF; pnpm test; git commit', true, 'cat <<EOF; pnpm test; git commit'],
  ['echo $((1 << 2));\npnpm test; git commit', true, 'echo $((1 << 2));\npnpm test; git commit'],
] as const)('lexer certainty floor: %s (preserve=%s)', (command, preserve, expected) => {
  expect(stripDataSpans(command, preserve)).toBe(expected)
})

it.each(commands)('lexer uncertainty never hides a fail-then-commit shape: %s', (command) => {
  const journal = mkdtempSync(join(tmpdir(), 'wt-commit-lexer-property-'))
  try {
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_MODE: 'enforce', WT_GUARD_JOURNAL_DIR: journal, WT_GUARD_JOURNAL_TEST_ORIGIN: '1' },
    })
    expect(result.status).toBe(0)
    const records = readdirSync(journal).filter((file) => file.endsWith('.ndjson'))
      .flatMap((file) => readFileSync(join(journal, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    expect(records.filter((record) => record.class === 'chained-commit' && record.decision === 'warned')).toHaveLength(1)
  } finally {
    rmSync(journal, { recursive: true, force: true })
  }
})

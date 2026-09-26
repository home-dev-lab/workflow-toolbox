import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('documents per-model verifier variants identically in both agent copies', () => {
  const canonical = readFileSync(fileURLToPath(new URL('../../../../plugin/agents/opencode-verifier.md', import.meta.url)), 'utf8')
  const mirror = readFileSync(fileURLToPath(new URL('../../../../plugin/launch-agents/agents/opencode-verifier.md', import.meta.url)), 'utf8')
  expect(mirror).toBe(canonical)
  expect(canonical).toContain('`gpt-5.6-luna` allows `none`, `low`, `medium`, `high`, and `xhigh`; `gpt-5.6-terra`, `gpt-5.6-sol`, and the `gpt-6-*` models also allow `max`')
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const repo = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8')

it('keeps the volume envelope on Luna and the verifier on Sol, including both agent copies', () => {
  const bridge = repo('plugin/bin/wt-opencode-envelope.mjs')
  expect(bridge).toContain("const DEFAULT_MODEL = 'openai/gpt-6-luna'")
  expect(bridge).toContain('fallbackModel: DEFAULT_MODEL')
  expect(repo('plugin/bin/wt-opencode-verify.mjs')).toContain("export const DEFAULT_MODEL = 'openai/gpt-6-sol'")
  const canonical = repo('plugin/agents/opencode-envelope.md')
  expect(repo('plugin/launch-agents/agents/opencode-envelope.md')).toBe(canonical)
  expect(canonical).toContain('default model `openai/gpt-6-luna`')
  expect(canonical).toContain('script defaults to `openai/gpt-6-luna`')
})

it('documents override precedence, hard routing and per-model efforts without unsupported version attribution', () => {
  const changes = repo('plugin/CHANGELOG.md').split('## [0.188.1]')[0]!
  expect(changes).toContain('An effort explicitly saved in plugin options still wins over the new family bases.')
  expect(changes).toContain('Refutation moves from `xhigh` to `medium`')
  const runner = repo('plugin/autonomy/PILOT-RUNNER.md')
  expect(runner).toContain('hard critic, review and refutation use `openai/gpt-6-astra`')
  expect(runner).toContain('at `medium`, hard code `opus` at `medium`')
  const routing = repo('plugin/skills/workflow-composer/references/model-and-agent-routing.md')
  expect(routing).toContain('`openai/gpt-5.6-luna` accepts `none`…`xhigh`')
  expect(routing).toContain('`openai/gpt-6-astra` accept `none`…`max`')
  expect(routing).not.toContain('opencode 1.18.4')
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('documents per-model verifier variants identically in both agent copies', () => {
  const canonical = readFileSync(fileURLToPath(new URL('../../../../plugin/agents/opencode-verifier.md', import.meta.url)), 'utf8')
  const mirror = readFileSync(fileURLToPath(new URL('../../../../plugin/launch-agents/agents/opencode-verifier.md', import.meta.url)), 'utf8')
  expect(mirror).toBe(canonical)
  const line = canonical.split('\n').find((value) => value.includes('`gpt-5.6-luna` allows')) ?? ''
  const lunaList = line.split('`gpt-5.6-luna` allows ')[1]?.split(';')[0]?.match(/`(none|low|medium|high|xhigh|max)`/g)?.map((value) => value.slice(1, -1))
  expect(lunaList).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
  const fullModels = ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-*']
  for (const model of fullModels) expect(line, model).toContain(`\`${model}\``)
  expect(line).toMatch(/also allow `max`/)
})

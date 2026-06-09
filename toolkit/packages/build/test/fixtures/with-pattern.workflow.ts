// with-pattern.workflow.ts — fixture that imports from @dwt/patterns.
//
// Proves esbuild inlines the pattern correctly (pattern code appears in the
// emitted artifact; no import/require statements remain).
import { defineWorkflow } from '../../src/define-workflow.js'
import { fanOutAndSynthesize } from '@dwt/patterns'

export default defineWorkflow({
  meta: {
    name: 'dwt-fixture-with-pattern',
    description: 'Fixture that uses fanOutAndSynthesize from @dwt/patterns to prove pattern inlining',
    phases: [{ title: 'Fan Out' }],
  },
  parseInput: (raw: unknown): string[] => {
    if (Array.isArray(raw)) return raw.map(String)
    if (typeof raw === 'string') return [raw]
    return ['task-a', 'task-b']
  },
  run: async (rt, input) => {
    rt.phase('Fan Out')
    const result = await fanOutAndSynthesize(rt, {
      tasks: input,
      taskPrompt: (task: string) => `Process this task: ${task}`,
      synthesisPrompt: (parts: ReadonlyArray<string>) => `Synthesize these results: ${parts.join(', ')}`,
    })
    return result
  },
})

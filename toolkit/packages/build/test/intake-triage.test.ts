import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- runtime .mjs helper intentionally has no declaration file.
import { inspectCard, renderRoute, triageCards } from '../../../../plugin/bin/lib/intake-triage-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const TEMPLATE = `${REPO_ROOT}/plugin/agent-templates/pilot-orchestrator.md`
const MIRROR_TEMPLATE = `${REPO_ROOT}/plugin/launch-agents/agents/pilot-orchestrator.md`
const CLI = `${REPO_ROOT}/plugin/bin/wt-intake-triage.mjs`
const CLI_FIXTURE = join(REPO_ROOT, 'toolkit/packages/build/test/fixtures/intake-triage/cards.json')

describe('intake triage', () => {
  it('classifies one fixture wave in one batch and preserves the deterministic evidence', async () => {
    const cards = [
      {
        id: 'docs',
        labels: ['effort:S'],
        description: 'Clarify the README heading.\nDefinition of done: the heading is corrected.',
      },
      {
        id: 'settled',
        labels: ['effort:S'],
        description: 'Update `plugin/bin/lib/example.mjs`.\nDefinition of done: output is stable.',
      },
      {
        id: 'ambiguous',
        labels: ['effort:M'],
        description: 'Change `plugin/agent-templates/example.md`.\nDefinition of done: the policy is documented.\nOpen question: should the existing exception remain?',
      },
    ]
    let calls = 0
    const result = await triageCards(cards, async (worklist: Array<{ id: string }>) => {
      calls += 1
      expect(worklist.map((card) => card.id)).toEqual(['docs', 'settled', 'ambiguous'])
      return [
        { id: 'docs', route: 'inline' },
        { id: 'settled', route: 'lane-direct' },
        { id: 'ambiguous', route: 'lane-direct', doubt: true },
      ]
    })

    expect(calls).toBe(1)
    expect(result.map((card: { route: string }) => card.route)).toEqual(['inline', 'lane-direct', 'pilot'])
    expect(result[1].routeLine).toBe('Route: lane-direct — DoD complete, no open question')
    expect(result[2].signals.openQuestion).toBe(true)
    expect(inspectCard(cards[1]).signals).toMatchObject({ effort: 'S', filesNamed: true, definitionOfDone: true, openQuestion: false })
  })

  it('honours a pre-existing route without consulting the classifier and refuses unlabelled cards', async () => {
    let calls = 0
    const result = await triageCards([
      { id: 'forced', labels: ['effort:L'], description: 'Route: pilot\nDefinition of done: investigate.' },
      { id: 'unlabelled', description: 'effort:S is mentioned here, but this is not a card label.\nDefinition of done: add a label.' },
    ], async () => {
      calls += 1
      return []
    })

    expect(calls).toBe(0)
    expect(result).toMatchObject([
      { id: 'forced', route: 'pilot', forced: true },
      { id: 'unlabelled', refused: true, reason: 'Missing effort label; refused from triage until labelled.' },
    ])
    expect(renderRoute('lane-direct', 'DoD complete, no open question')).toBe('Route: lane-direct — DoD complete, no open question')
  })

  it('parses card.md definition-of-done headings and bare repository paths', () => {
    const card = {
      id: 'card-md',
      labels: ['effort:S'],
      description: '# Fix parser\n\nUpdate plugin/bin/wt-intake-triage.mjs and toolkit/Makefile.\n\n## Definition of done\n\nThe parser accepts the runner card shape.',
    }

    expect(inspectCard(card).signals).toMatchObject({
      definitionOfDone: true,
      filesNamed: true,
    })
  })

  it('refuses an unknown existing route without consulting the classifier', async () => {
    let calls = 0
    const result = await triageCards([
      { id: 'bad-route', labels: ['effort:S'], description: 'Route: maybe\nDefinition of done: decide.' },
    ], async () => {
      calls += 1
      return []
    })

    expect(calls).toBe(0)
    expect(result).toMatchObject([
      { id: 'bad-route', refused: true, reason: 'Invalid Route value: maybe; refused from triage.' },
    ])
  })

  it('promotes doubt conservatively and defaults unknown classifier routes to pilot', async () => {
    const result = await triageCards([
      { id: 'doubt-pilot', labels: ['effort:S'], description: 'Definition of done: finish.' },
      { id: 'doubt-inline', labels: ['effort:S'], description: 'Definition of done: finish.' },
      { id: 'unknown', labels: ['effort:S'], description: 'Definition of done: finish.' },
    ], async () => [
      { id: 'doubt-pilot', route: 'pilot', doubt: true },
      { id: 'doubt-inline', route: 'inline', doubt: true },
      { id: 'unknown', route: 'maybe' },
    ])

    expect(result.map((card: { route: string }) => card.route)).toEqual(['pilot', 'lane-direct', 'pilot'])
  })

  it('refuses malformed cards and does not call the classifier for an empty worklist', async () => {
    let calls = 0
    await expect(triageCards([], async () => {
      calls += 1
      return []
    })).resolves.toEqual([])
    expect(calls).toBe(0)

    const result = await triageCards([null, undefined, { id: 'missing-fields' }] as never[], async () => {
      calls += 1
      return []
    })
    expect(result).toHaveLength(3)
    expect(result.every((card: { refused: boolean }) => card.refused)).toBe(true)
    expect(calls).toBe(0)
  })

  it('prints deterministic signals, verdicts, and the eligible batch from the CLI fixture', () => {
    const output = execFileSync('node', [CLI, '--cards', CLI_FIXTURE], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual({
      cards: [
        {
          id: 'inline-shaped',
          title: 'Clarify README',
          description: 'Update docs/README.md.\n\n## Definition of done\n\nThe heading is clear.',
          signals: { effort: 'S', filesNamed: true, definitionOfDone: true, openQuestion: false, existingRoute: null },
          forced: false,
          refused: false,
        },
        {
          id: 'settled',
          title: 'Preserve route',
          description: 'Route: lane-direct\n\nDefinition of done: release the settled change.',
          signals: { effort: 'M', filesNamed: false, definitionOfDone: true, openQuestion: false, existingRoute: 'lane-direct' },
          route: 'lane-direct',
          reason: 'Forced by existing Route line',
          forced: true,
          refused: false,
        },
        {
          id: 'ambiguous',
          title: 'Needs a label',
          description: 'Open question: which policy applies?',
          signals: { effort: null, filesNamed: false, definitionOfDone: false, openQuestion: true, existingRoute: null },
          reason: 'Missing effort label; refused from triage until labelled.',
          forced: false,
          refused: true,
        },
      ],
      eligible: [
        {
          id: 'inline-shaped',
          title: 'Clarify README',
          description: 'Update docs/README.md.\n\n## Definition of done\n\nThe heading is clear.',
          signals: { effort: 'S', filesNamed: true, definitionOfDone: true, openQuestion: false, existingRoute: null },
        },
      ],
    })
  })

  it('keeps byte-identical templates coupled to the CLI command', () => {
    const template = readFileSync(TEMPLATE, 'utf8')
    expect(template).toBe(readFileSync(MIRROR_TEMPLATE, 'utf8'))
    expect(template).toContain('node <plugin-root>/bin/wt-intake-triage.mjs --cards <cards.json>')
    expect(template).toMatch(/single batched strong-model call ONLY over the `eligible` list/i)
    expect(template).toMatch(/Route:.*reason the CLI or the call produced/i)
  })
})

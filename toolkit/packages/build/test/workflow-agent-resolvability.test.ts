// workflow-agent-resolvability.test.ts — every SHIPPED example workflow either
// starts on a stock install, or names exactly what it needs first (card
// #1836745501).
//
// Found by accident: capability-scout.js (a shipped, whenToUse-advertised
// example) fails immediately on both the Workflow tool (Path A) and a
// single-stage control run — `agent type 'code-scout' not found` — because
// its one agentType is a hand-authored capability-registry stand-in resolved
// ONLY by `wt-observe launch` (design §3.2/§9), never by anything else. The
// text inviting people to run it never said so. This is the mechanical half
// of the fix: a workflow that hardcodes a literal, non-stock agentType is
// caught here UNLESS it is named in JUSTIFIED_NONSTOCK_AGENT_TYPES below AND
// its own whenToUse states the requirement in its first sentence — the doc
// half checked by the second `it` block.
//
// Deliberately globs toolkit/examples/*.workflow.ts rather than a hardcoded
// list — a workflow added tomorrow is covered automatically, the way
// guard-journal-family.test.ts globs plugin/bin/*guard*.mjs for the same
// reason.
//
// Scope: this locks *whether a workflow can START* (agentType resolvability),
// never what it does once running — same boundary the source fix respects.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { isExternalBridgeType } from '@workflow-toolbox/patterns'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const EXAMPLES_DIR = join(REPO_ROOT, 'toolkit/examples')
const PLUGIN_AGENTS_DIR = join(REPO_ROOT, 'plugin/agents')

// Built-in Claude Code subagent types available with no plugin, no adoption,
// no external CLI configured — the SAME set the observed failure's own error
// message enumerated: "Available agents: claude, Explore, general-purpose,
// Plan, statusline-setup, workflow-toolbox:…".
const BUILTIN_AGENT_TYPES = new Set(['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'])

/** `workflow-toolbox:<name>` for every agent this plugin itself SHIPS
 *  (plugin/agents/*.md) — resolvable on any install that merely has the
 *  plugin enabled, no adoption step required. */
function shippedPluginAgentTypes(): Set<string> {
  return new Set(
    readdirSync(PLUGIN_AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => `workflow-toolbox:${f.slice(0, -'.md'.length)}`),
  )
}

/** Literal `agentType: '<name>'` string occurrences in a workflow source —
 *  never a variable/resolved reference (`agentType: resolvedType`,
 *  `agentType: implementerType`, …), which are already user-optional,
 *  probe-gated, and fall back gracefully by construction (isExternalBridgeType
 *  covers those that resolve to a bridge). A hardcoded literal is the only
 *  shape that can make a workflow DOA on a stock install with no args at all. */
function literalAgentTypes(src: string): string[] {
  const found: string[] = []
  const re = /agentType:\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) found.push(m[1] ?? '')
  return found
}

/** The `whenToUse` string from a workflow's `meta` block — handles both a
 *  single string literal and a `'...' + '...' + '...'` concatenation (both
 *  forms are used across toolkit/examples/*.workflow.ts today). Returns null
 *  when the file has no whenToUse field. */
function whenToUseText(src: string): string | null {
  const idx = src.indexOf('whenToUse:')
  if (idx === -1) return null
  let rest = src.slice(idx + 'whenToUse:'.length)
  const stringRe = /^\s*'((?:[^'\\]|\\.)*)'\s*(\+)?/
  let text = ''
  let matchedOnce = false
  for (;;) {
    const m = stringRe.exec(rest)
    if (!m) break
    matchedOnce = true
    text += (m[1] ?? '').replace(/\\'/g, "'")
    rest = rest.slice(m[0].length)
    if (!m[2]) break
  }
  return matchedOnce ? text : null
}

// Workflows whose one or more literal agentType is deliberately NOT
// stock-resolvable, and WHY — never a silent exclusion (mirrors
// guard-journal-family.test.ts's JUSTIFIED_EXCLUSIONS). Companion requirement
// enforced by the second `it` block below: the SAME workflow's whenToUse must
// state the requirement in its own first sentence, not just here.
const JUSTIFIED_NONSTOCK_AGENT_TYPES: Record<string, { types: string[]; reason: string }> = {
  'capability-scout.workflow.ts': {
    types: ['code-scout'],
    reason:
      'Resolved ONLY by `wt-observe launch`, from the sidecar ' +
      'capability-scout.capabilities.json (design §3.2/§9) — the Workflow tool ' +
      '(Path A) has no capability-resolution hook, so this agentType is ' +
      'intentionally absent from every stock/interactive install and from a ' +
      'Path A run of this very script.',
  },
}

function allWorkflowFiles(): string[] {
  return readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.workflow.ts'))
}

describe('workflow agent-type resolvability — every shipped workflow can START on a stock install', () => {
  const files = allWorkflowFiles()
  const resolvable = new Set([...BUILTIN_AGENT_TYPES, ...shippedPluginAgentTypes()])

  it('the workflow directory glob itself finds real files (sanity)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file}: every literal agentType is stock-resolvable, a graceful bridge, or a named justification`, () => {
      const src = readFileSync(join(EXAMPLES_DIR, file), 'utf8')
      const literalTypes = [...new Set(literalAgentTypes(src))]
      const justification = JUSTIFIED_NONSTOCK_AGENT_TYPES[file]
      const justifiedTypes = new Set(justification?.types ?? [])

      const unresolved = literalTypes.filter(
        (t) => !resolvable.has(t) && !isExternalBridgeType(t) && !justifiedTypes.has(t),
      )
      expect(
        unresolved,
        `${file} hardcodes agentType(s) [${unresolved.join(', ')}] a stock install cannot ` +
          `resolve, and no JUSTIFIED_NONSTOCK_AGENT_TYPES entry covers them. Either route to a ` +
          `stock/shipped agentType, or add a named justification in this test AND state the ` +
          `requirement in the workflow's own whenToUse first sentence.`,
      ).toEqual([])
    })
  }

  it('the justification map names only files that still exist and still exhibit the listed agentType (no stale entry)', () => {
    for (const [file, { types }] of Object.entries(JUSTIFIED_NONSTOCK_AGENT_TYPES)) {
      expect(files.includes(file), `justification names ${file}, which no longer exists under toolkit/examples/`).toBe(
        true,
      )
      const src = readFileSync(join(EXAMPLES_DIR, file), 'utf8')
      const literalTypes = literalAgentTypes(src)
      for (const t of types) {
        expect(
          literalTypes.includes(t),
          `${file}: justification names agentType '${t}', which is no longer present in the source — stale entry`,
        ).toBe(true)
      }
    }
  })

  it("a workflow with a justified non-stock agentType states the requirement in whenToUse's first sentence", () => {
    for (const [file, { reason }] of Object.entries(JUSTIFIED_NONSTOCK_AGENT_TYPES)) {
      const src = readFileSync(join(EXAMPLES_DIR, file), 'utf8')
      const text = whenToUseText(src)
      expect(text, `${file}: has no whenToUse to carry the required-setup warning (${reason})`).not.toBeNull()
      const firstSentence = (text ?? '').split('.')[0] ?? ''
      expect(
        /wt-observe launch/i.test(firstSentence),
        `${file}: whenToUse's first sentence must name "wt-observe launch" — got: "${firstSentence}"`,
      ).toBe(true)
      expect(
        /\bonly\b|\brequires?\b/i.test(firstSentence),
        `${file}: whenToUse's first sentence must state this as a REQUIREMENT (e.g. "ONLY"/"requires"), ` +
          `not merely a suggestion — got: "${firstSentence}"`,
      ).toBe(true)
    }
  })
})

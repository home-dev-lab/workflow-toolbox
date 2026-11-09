// agent-template-readonly-critic-channel-content.test.ts — content lock for the read-only
// critic report channel.
//
// A critic type whose allow-list has no Write (the shipped wt-reviewer and leaf-readonly, any
// `tools: Read, Grep, Glob` type) cannot honour a file-report contract, and the plugin's
// spawn-capability guard refuses a brief that asks it to. The correct channel is an anonymous
// FOREGROUND spawn whose final message comes back to its spawner as the tool result. The file
// contract stays for named spawns and for types that have Write.
//
// This test EXTRACTS the relevant section of each template (heading to the next `## `), the
// no-Write paragraph inside it, and section 2 of the delegation-chain skill, and asserts on
// those only, never on the whole file.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function readRaw(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

// Heading line (matched by `heading`) up to, excluding, the next `## ` heading.
function extractSection(raw: string, heading: RegExp): string {
  const lines = raw.split('\n')
  const start = lines.findIndex((l) => heading.test(l))
  expect(start, `heading ${heading} not found`).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^## /.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

function paragraphs(raw: string): string[] {
  return raw.split(/\n\s*\n/).map(collapseWhitespace)
}

function noWriteParagraph(sectionRaw: string): string {
  const found = paragraphs(sectionRaw).filter((p) => /anonymous/i.test(p))
  expect(found.length, 'no paragraph mentions "anonymous"').toBeGreaterThan(0)
  return found.join(' ')
}

const PILOT_HEADING = /^## Spawned critic\/verifier reports/
const ORCH_HEADING = /^## File-report contract/

// Each template and its launch-agents twin: the twin carries the same contract, so a deletion or
// inversion in one copy only is caught.
const TEMPLATES: Array<[string, string, RegExp]> = [
  ['pilot.md', 'plugin/agent-templates/pilot.md', PILOT_HEADING],
  ['pilot-orchestrator.md', 'plugin/agent-templates/pilot-orchestrator.md', ORCH_HEADING],
  ['launch pilot.md', 'plugin/launch-agents/agents/pilot.md', PILOT_HEADING],
  [
    'launch pilot-orchestrator.md',
    'plugin/launch-agents/agents/pilot-orchestrator.md',
    ORCH_HEADING,
  ],
]

describe.each(TEMPLATES)('%s report channel for a type without Write', (_n, rel, heading) => {
  const sectionRaw = extractSection(readRaw(rel), heading)
  const section = collapseWhitespace(sectionRaw)

  it('states no-Write, anonymous, foreground and final-message-is-the-report within one window', () => {
    const para = noWriteParagraph(sectionRaw)
    const anchors = [
      /(without|no|lacks?) `?Write`?/i,
      /anonymous/i,
      /foreground/i,
      /final message is the (full )?report/i,
    ]
    const positions = anchors.map((a) => {
      const m = a.exec(para)
      expect(m, `anchor ${a} missing from the no-Write paragraph`).not.toBeNull()
      return m!.index
    })
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(900)
  })

  it('does not invert the central contract', () => {
    const para = noWriteParagraph(sectionRaw)
    expect(para).toMatch(/spawn it anonymously/i)
    expect(para).toMatch(/final message is the (full )?report/i)
    expect(para).not.toMatch(/never spawn[^.]{0,30}anonymously/i)
    expect(para).not.toMatch(/final message (is not|isn't|is never)\b/i)
    expect(para).not.toMatch(/never[^.]{0,20}run_in_background: false/i)
  })
})

describe.each(TEMPLATES)('%s report channel: persistence and the Write contract', (_n, rel, heading) => {
  const sectionRaw = extractSection(readRaw(rel), heading)
  const section = collapseWhitespace(sectionRaw)

  it('keeps the persistence clause: the spawner saves the returned report under REPORT_DIR', () => {
    expect(section).toMatch(/save (it|the returned report) yourself under `REPORT_DIR`/i)
    expect(section).toMatch(/\bbefore you act on it\b/i)
  })

  it('has no sentence that makes the file contract unconditional', () => {
    const re = /every[^.]{0,60}brief[^.]{0,60}must[^.]{0,80}(file-report|write your full report)/gi
    for (const m of section.matchAll(re)) {
      expect(m[0], `unqualified sentence: ${m[0]}`).toMatch(/\bWrite\b|named spawn/)
    }
  })

  it('keeps the file contract for a type that has Write', () => {
    expect(section).toMatch(/(type|types) that (has|have) `?Write`?/i)
    expect(section).toMatch(/REPORT WRITTEN/)
  })

  it('names run_in_background: false, since agents run in the background by default', () => {
    expect(noWriteParagraph(sectionRaw)).toMatch(/run_in_background: false/)
    expect(noWriteParagraph(sectionRaw)).not.toMatch(/no `run_in_background`/)
  })

  it('keeps REPORT WRITTEN out of the no-Write paragraph', () => {
    expect(noWriteParagraph(sectionRaw)).not.toMatch(/REPORT WRITTEN/)
  })
})

describe.each([
  ['pilot.md', 'agent-templates/pilot.md', 'launch-agents/agents/pilot.md'],
  [
    'pilot-orchestrator.md',
    'agent-templates/pilot-orchestrator.md',
    'launch-agents/agents/pilot-orchestrator.md',
  ],
])('%s and its launch-agents twin', (_n, a, b) => {
  it('are byte-identical', () => {
    expect(readRaw(`plugin/${b}`)).toBe(readRaw(`plugin/${a}`))
  })
})

describe('pilot.md Sub-agents SendMessage clause', () => {
  const raw = collapseWhitespace(readRaw('plugin/agent-templates/pilot.md'))
  const start = raw.indexOf('- **Sub-agents**')
  const bullet = raw.slice(start, raw.indexOf('Treat a long silence', start))

  it('keeps the fallback and chooses the channel by Write, never by SendMessage', () => {
    expect(start).toBeGreaterThan(0)
    expect(bullet).toMatch(/SendMessage never picks the channel[^.;]{0,40}; Write does/i)
    expect(bullet).toMatch(/without `?Write`?[^.]{0,80}anonymous(ly)?[- ]foreground/i)
    expect(bullet).toMatch(/has `?Write`?[^.]{0,80}file-report contract/i)
    expect(bullet).not.toMatch(/without `?SendMessage`? follows/i)
  })


  it('applies only to types that have SendMessage', () => {
    const raw = collapseWhitespace(readRaw('plugin/agent-templates/pilot.md'))
    const i = raw.indexOf('address your reports to')
    expect(i).toBeGreaterThan(0)
    const before = raw.slice(Math.max(0, i - 260), i)
    expect(before).toMatch(/(has|have|with) `?SendMessage`?|declares? no `tools:`/i)
  })
})

describe('delegation-chain SKILL.md section 2', () => {
  const raw = readRaw('plugin/skills/delegation-chain/SKILL.md')
  const sec = extractSection(raw, /^## 2\. The upward chain/)
  const bullets = sec.split(/\n(?=- )/).map(collapseWhitespace)

  it.each([
    ['plain text reaches nobody', /reaches nobody/i],
    ['the remedy is the file-report contract', /remedy[^.]{0,30}is the file-report contract/i],
    ['lacks both Write and SendMessage', /lacks BOTH `?Write`? and `?SendMessage`?/i],
  ])('qualifies "%s" with the foreground exception', (_label, re) => {
    const b = bullets.filter((x) => re.test(x))
    expect(b.length, `bullet ${re} not found`).toBe(1)
    expect(b[0]).toMatch(/foreground/i)
    expect(b[0]).toMatch(/final message/i)
  })

  it('names run_in_background: false on the foreground exception', () => {
    const b = bullets.filter((x) => /reaches nobody/i.test(x))
    expect(b[0]).toMatch(/run_in_background: false/)
  })

  it('restricts the foreground exception to an ANONYMOUS call', () => {
    const b = bullets.filter((x) => /reaches nobody/i.test(x))
    expect(b[0]).toMatch(/anonymous/i)
    expect(b[0]).toMatch(/named[^.]{0,80}(does not|root)/i)
  })

  it('states the file-report completion line exactly as the templates do', () => {
    const b = bullets.filter((x) => /remedy[^.]{0,30}is the file-report contract/i.test(x))
    expect(b[0]).toMatch(/REPORT WRITTEN: <verdict>/)
    expect(b[0]).not.toMatch(/file path and a verdict/i)
  })
})

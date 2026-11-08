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

const TEMPLATES: Array<[string, string, RegExp]> = [
  ['pilot.md', 'plugin/agent-templates/pilot.md', /^## Spawned critic\/verifier reports/],
  [
    'pilot-orchestrator.md',
    'plugin/agent-templates/pilot-orchestrator.md',
    /^## File-report contract/,
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
      /final message[^.]{0,40}\bis\b[^.]{0,20}the (full )?report/i,
    ]
    const positions = anchors.map((a) => {
      const m = a.exec(para)
      expect(m, `anchor ${a} missing from the no-Write paragraph`).not.toBeNull()
      return m!.index
    })
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(900)
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

  it('keeps REPORT WRITTEN out of the no-Write paragraph', () => {
    expect(noWriteParagraph(sectionRaw)).not.toMatch(/REPORT WRITTEN/)
  })
})

describe('pilot.md Sub-agents SendMessage clause', () => {
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
})

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_BIN = join(REPO_ROOT, 'plugin/bin')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function discoverDenyGuards() {
  return readdirSync(PLUGIN_BIN)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => ({
      name,
      path: join(PLUGIN_BIN, name),
    }))
    .filter(({ path }) => /permissionDecision:\s*'deny'/.test(readFileSync(path, 'utf8')))
}

function companionFiles(source: string, filePath: string) {
  const dir = filePath.slice(0, filePath.lastIndexOf('/'))
  return [...source.matchAll(/path\.join\(HERE, '([^']+\.mjs)'\)/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name))
    .map((name) => join(dir, name))
}

function quotedStrings(source: string) {
  const out: string[] = []
  const re = /`(?:\\.|[^`])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g
  for (const match of source.matchAll(re)) out.push(match[0].slice(1, -1))
  return out.join('\n')
}

// ⚠ These four patterns are an ALTERNATION OF TODAY'S PHRASINGS, not a test of meaning.
// Nothing mechanical can read a sentence and decide whether it names a consequence, so this
// is a heuristic — and its precision has never been measured on refusal text it did not
// choose: it was written FROM the six messages it inspects.
//
// This project's own shipped rule settles what such a check may do:
//
//     A rule BLOCKS only if its precision has been measured on material it did not choose.
//     An unmeasured rule may exist — as a WARNING. Blocking is earned by measurement.
//
// So this returns findings instead of asserting them. Left blocking, a seventh guard whose
// message is perfectly good but worded differently would go red — and its author's cheapest
// escape would be to copy an existing phrasing, homogenising the one thing that must stay
// specific: a refusal is read once, under pressure, by someone who needs to act.
//
// The mechanically decidable half — that the reason travels in the field which actually
// carries it — stays a hard assertion below, where it belongs.
function auditLiteralCorpus(label: string, literals: string): string[] {
  const parts: Array<[string, RegExp]> = [
    ['action', /Refused:|Refused to|COMMIT SIGNATURE PROBLEM|TERMINAL/],
    ['reason', /\$\{reason\}|malformed|missing required field|hollow self-exclusion|RELAY|no real [\s\S]* CLI invocation|signature policy|NO Write tool|declares\s+tools:|named but not\s+isolated|would send commits/i],
    ['consequence', /later readers cannot|cannot reconstruct|silently|before the network round-trip|only in its transcript|approval path|keep being refused|from your own knowledge|watchdog is silently never attached/i],
    ['way-out', /Fix:|relay the exact command|Invoke the CLI now|return your FINAL answer as TEXT now|drop the name|your last output IS the deliverable|git commit --amend|git rebase --exec|state how the probe excluded/i],
  ]
  return parts.filter(([, re]) => !re.test(literals)).map(([part]) => `${label}: refusal ${part} not recognised`)
}

describe('deny-guard refusal invariant', () => {
  it('discovers the shipped deny guards, verifies the delivery field, and audits their refusal corpus for action/reason/consequence/way-out', () => {
    const guards = discoverDenyGuards()
    expect(guards.length).toBeGreaterThan(0)

    const findings: string[] = []
    for (const guard of guards) {
      const source = readFileSync(guard.path, 'utf8')
      // HARD: a reason written into the wrong key is dropped in silence and the refused agent
      // sees a bare refusal. This is decidable from the source, so it blocks.
      expect(source, `${guard.name}: wrong deny-reason field`).toMatch(/permissionDecisionReason\s*:/)
      const corpus = [source, ...companionFiles(source, guard.path).map((p) => readFileSync(p, 'utf8'))].join('\n')
      // ADVISORY: see the note on auditLiteralCorpus. Surfaced, never asserted.
      findings.push(...auditLiteralCorpus(guard.name, quotedStrings(corpus)))
    }
    if (findings.length > 0) {
      console.warn(`[refusal-invariant] advisory — unrecognised parts (heuristic, not a verdict):\n  ${findings.join('\n  ')}`)
    }
  })

  it('fails on a synthetic discovered guard with a bare refusal reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-refusal-invariant-'))
    roots.push(dir)
    const fixture = join(dir, 'fixture-guard.mjs')
    writeFileSync(
      fixture,
      [
        'process.stdout.write(JSON.stringify({',
        '  hookSpecificOutput: {',
        "    permissionDecision: 'deny',",
        "    permissionDecisionReason: 'Refused: nope',",
        '  },',
        '}))',
      ].join('\n')
    )

    const literals = quotedStrings(readFileSync(fixture, 'utf8'))
    // The heuristic still has to NOTICE a bare refusal — it just reports instead of asserting.
    const findings = auditLiteralCorpus('fixture-guard.mjs', literals)
    expect(findings.join(' ')).toMatch(/consequence not recognised/)
    expect(findings.join(' ')).toMatch(/way-out not recognised/)
  })
})

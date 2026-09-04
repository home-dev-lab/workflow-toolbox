#!/usr/bin/env node
// verify-rules-rationale-split.mjs — ONE-OFF migration verifier for the 2026-09-02
// shipped-rules static-prefix cut. NOT a permanent gate: run by hand at cut time against a
// frozen pre-cut baseline directory, to prove no line was dropped or duplicated and no cut
// fell mid-paragraph. The permanent, ongoing lock is
// toolkit/packages/build/test/rules-rationale-referential.test.ts (referential integrity
// between pointer §headings and rationale-doc headings) — THIS script's baseline is not
// committed, precisely so a future legitimate rewrite of rule prose is never forced to keep
// dead text alive in a rationale doc just to satisfy a frozen byte-for-byte comparison.
//
// Usage:
//   node toolkit/scripts/verify-rules-rationale-split.mjs --baseline <dir> [--rule <name>]...
//
// <dir> holds one <rule-name>.md per shipped rule, exactly as it stood BEFORE the cut. Run
// from the repo root that has plugin/rules/ and plugin/docs/rules-rationale/ at their
// CURRENT (post-cut) state.
//
// Algorithm (same as the private-rule pass's one-off `~/.claude/docs/prefix-ab/verify-split.py`):
// every non-blank baseline line must appear in exactly one of {current rule, current
// rationale doc}; a line in BOTH is a duplication; a mid-paragraph split is two adjacent
// baseline lines (neither blank, neither a list/heading/quote/code marker) landing in
// different destinations while the first does not end a sentence.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function parseArgs(argv) {
  const args = { baseline: null, rules: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline') args.baseline = argv[++i]
    else if (argv[i] === '--rule') args.rules.push(argv[++i])
  }
  return args
}

function nonBlankCounts(text) {
  const counts = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}

function verifySplit(origText, ruleText, docText) {
  const orig = origText.split('\n')
  const O = nonBlankCounts(origText)
  const R = nonBlankCounts(ruleText)
  const T = nonBlankCounts(docText)

  const missing = []
  for (const [line, n] of O) {
    const have = (R.get(line) ?? 0) + (T.get(line) ?? 0)
    if (have < n) missing.push(line)
  }

  const both = []
  for (const [line, n] of O) {
    if (n === 1 && (R.get(line) ?? 0) > 0 && (T.get(line) ?? 0) > 0 && !line.trimStart().startsWith('#')) {
      both.push(line)
    }
  }

  const inRule = new Set(R.keys())
  const inDoc = new Set(T.keys())
  const splits = []
  for (let i = 0; i < orig.length - 1; i++) {
    const a = orig[i] ?? ''
    const b = orig[i + 1] ?? ''
    if (!a.trim() || !b.trim()) continue
    const bTrim = b.trimStart()
    if (bTrim.startsWith('-') || bTrim.startsWith('*') || bTrim.startsWith('|') || bTrim.startsWith('#') || bTrim.startsWith('>') || bTrim.startsWith('```')) continue
    if (a.trimStart().startsWith('<!--') || bTrim.startsWith('<!--')) continue
    const sa = inRule.has(a) ? 'rule' : inDoc.has(a) ? 'doc' : null
    const sb = inRule.has(b) ? 'rule' : inDoc.has(b) ? 'doc' : null
    if (sa && sb && sa !== sb) {
      const aTrimEnd = a.trimEnd()
      const endsSentence = ['.', '!', '?', ':', '|', '`', ')', '*', '»'].some((ch) => aTrimEnd.endsWith(ch))
      if (!endsSentence) splits.push([a, b])
    }
  }

  return { missing, both, splits }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.baseline) {
    console.error('usage: verify-rules-rationale-split.mjs --baseline <dir> [--rule <name>]...')
    process.exit(2)
  }
  const baselineDir = args.baseline
  const names = args.rules.length > 0
    ? args.rules
    : readdirSync(baselineDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort()

  let anyFail = false
  const summary = []
  for (const name of names) {
    const origText = readFileSync(join(baselineDir, `${name}.md`), 'utf8')
    const ruleText = readFileSync(join(REPO_ROOT, 'plugin/rules', `${name}.md`), 'utf8')
    const docText = readFileSync(join(REPO_ROOT, 'plugin/docs/rules-rationale', `${name}.md`), 'utf8')
    const { missing, both, splits } = verifySplit(origText, ruleText, docText)
    const ok = missing.length === 0 && both.length === 0 && splits.length === 0
    if (!ok) anyFail = true
    summary.push({ name, ok, missing: missing.length, both: both.length, splits: splits.length })
    console.log(`${name}: ${ok ? 'OK' : 'FAIL'} missing=${missing.length} both=${both.length} splits=${splits.length}`)
    for (const l of missing.slice(0, 5)) console.log(`  MISSING: ${l.slice(0, 110)}`)
    for (const l of both.slice(0, 5)) console.log(`  BOTH: ${l.slice(0, 110)}`)
    for (const [a, b] of splits.slice(0, 3)) console.log(`  SPLIT: ${a.slice(0, 60)} || ${b.slice(0, 60)}`)
  }
  console.log(`\n${summary.filter((s) => s.ok).length}/${summary.length} rule/rationale pairs verified against the baseline.`)
  process.exit(anyFail ? 1 : 0)
}

main()

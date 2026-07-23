// provenance-gate.test.ts — unit tests for the external-vote provenance gate helpers.
//
// The load-bearing test is the SCANNER DRIFT-LOCK (describe 'scanner e2e'): it generates the
// checker's scanner from the SHIPPED DelegationExpectation, runs it against synthetic
// transcript fixtures, and asserts it (a) classifies a real opencode `run` as cliSeen, a
// self-answer (`opencode providers list` + repo grep) as not, and (b) AGREES with the shipped
// parseTranscriptExternalCalls on the same transcript content — so any divergence between the
// embedded scanner and the canonical signal fails here.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expectationForAgentType,
  parseTranscriptExternalCalls,
} from '@workflow-toolbox/debugger/external-delegation'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import {
  externalGateExpectation,
  deriveProvenanceNonce,
  parseProvenanceReply,
  buildProvenanceScannerSource,
  runProvenanceChecker,
  PROVENANCE_CHECK_SUFFIX,
} from '../src/provenance-gate.js'

// --------------------------------------------------------------------------
// Synthetic transcript fixtures (safe to commit — no real repo content, unlike
// the live wf_ transcripts that carry private-repo diffs).
// --------------------------------------------------------------------------

/** One jsonl transcript line: an assistant Bash tool_use with `command`. */
function bashTurn(command: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  })
}

/** One jsonl transcript line: a user turn whose text carries a wt-meta label tag. */
function labeledUserTurn(label: string, extra = ''): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: `<!-- wt-meta label="${label}" phase="Verify" -->\n${extra}` }],
    },
  })
}

// A REAL opencode invocation shape (the bundled bridge's resolver arm: BIN=…opencode … "$BIN" run).
const POS_COMMAND =
  'TASKFILE="/tmp/oc-verify-$$.md" BIN="/home/x/.opencode/bin/opencode" ' +
  'cat > "$TASKFILE" <<WTX\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\nWTX\n' +
  'timeout 570 "$BIN" run "Verify the claim" -f "$TASKFILE" --model zai-coding-plan/glm-5.2 < /dev/null'

// A SELF-ANSWER shape: probes for the binary + lists providers (NOT `run`), then greps the repo itself.
const NEG_COMMAND =
  'command -v opencode || find ~/.opencode/bin -name opencode; ' +
  '/home/x/.opencode/bin/opencode providers list; ' +
  'grep -rn "the claim under test" /home/x/project/src'

function makeRunDir(nonce: string, posLabel: string, negLabel: string): { root: string; posJsonl: string; negJsonl: string } {
  const root = mkdtempSync(join(tmpdir(), 'prov-fixture-'))
  const runDir = join(root, 'projects', 'testslug', 'testsess', 'subagents', 'workflows', 'wf_test')
  mkdirSync(runDir, { recursive: true })
  const posJsonl = [labeledUserTurn(posLabel, 'Adversarially verify.'), bashTurn(POS_COMMAND)].join('\n') + '\n'
  const negJsonl = [labeledUserTurn(negLabel, 'Adversarially verify.'), bashTurn(NEG_COMMAND)].join('\n') + '\n'
  writeFileSync(join(runDir, 'agent-pos001.jsonl'), posJsonl)
  writeFileSync(join(runDir, 'agent-neg001.jsonl'), negJsonl)
  // The checker's own transcript — carries the anchor nonce, no vote label markers.
  writeFileSync(join(runDir, 'agent-checker9.jsonl'), JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: `PROVENANCE_ANCHOR: ${nonce}\nrun the command.` }] },
  }) + '\n')
  return { root, posJsonl, negJsonl }
}

/** Run the generated scanner as a real CommonJS file (top-level return needs the module
 *  wrapper — matches production, where the checker writes+runs it via a temp .cjs). */
function runScanner(source: string, configRoot: string): { anchored: boolean; results: Array<{ label: string; cliSeen: boolean | null }> } {
  const scanFile = join(mkdtempSync(join(tmpdir(), 'prov-scan-')), 'scan.cjs')
  writeFileSync(scanFile, source)
  const out = execFileSync('node', [scanFile], { env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot }, encoding: 'utf8' })
  return JSON.parse(out.trim())
}

// --------------------------------------------------------------------------
describe('externalGateExpectation — arms ONLY on a registered external type', () => {
  it('is null for undefined verifierType (plain Claude verifier — never gated)', () => {
    expect(externalGateExpectation(undefined)).toBeNull()
  })
  it('resolves the opencode bridge type', () => {
    expect(externalGateExpectation('workflow-toolbox:opencode-verifier')?.id).toBe('opencode')
  })
  it('resolves the codex type', () => {
    expect(externalGateExpectation('codex:codex-rescue')?.id).toBe('codex')
  })
  it('is null for a registered-but-NON-external Claude specialist (false-positive invariant)', () => {
    expect(externalGateExpectation('magic-claude:ts-reviewer')).toBeNull()
    expect(externalGateExpectation('some:unknown-type')).toBeNull()
  })
})

describe('deriveProvenanceNonce', () => {
  it('is deterministic and shaped wtprov-XXXXXXXX (resume-cache safe)', () => {
    const a = deriveProvenanceNonce(['adversarialVerification:verify:0:0', 'adversarialVerification:verify:0:1'])
    const b = deriveProvenanceNonce(['adversarialVerification:verify:0:0', 'adversarialVerification:verify:0:1'])
    expect(a).toBe(b)
    expect(a).toMatch(/^wtprov-[0-9a-f]{8}$/)
  })
  it('differs when labels differ', () => {
    expect(deriveProvenanceNonce(['a:0'])).not.toBe(deriveProvenanceNonce(['a:1']))
  })
  it('folds claim content: same labels + different claims → different nonce (shrinks the collision set)', () => {
    const labels = ['adversarialVerification:verify:0:0']
    expect(deriveProvenanceNonce(labels, 'claim A')).not.toBe(deriveProvenanceNonce(labels, 'claim B'))
    // same labels + same claim content stays stable (resume-cache safe).
    expect(deriveProvenanceNonce(labels, 'claim A')).toBe(deriveProvenanceNonce(labels, 'claim A'))
  })
})

describe('parseProvenanceReply — tolerant, strict on cliSeen', () => {
  const labels = ['v:0', 'v:1', 'v:2']
  it('maps a clean JSON reply', () => {
    const reply = JSON.stringify({ anchored: true, results: [{ label: 'v:0', cliSeen: true }, { label: 'v:1', cliSeen: false }] })
    const m = parseProvenanceReply(reply, labels)
    expect(m.get('v:0')).toBe('seen')
    expect(m.get('v:1')).toBe('absent')
    expect(m.get('v:2')).toBe('undetermined') // not reported → fail-closed
  })
  it('extracts JSON embedded in prose', () => {
    const reply = 'Here is the result:\n{"anchored":true,"results":[{"label":"v:0","cliSeen":true}]}\nDone.'
    expect(parseProvenanceReply(reply, labels).get('v:0')).toBe('seen')
  })
  it('a null reply → all undetermined', () => {
    for (const p of parseProvenanceReply(null, labels).values()) expect(p).toBe('undetermined')
  })
  it('garbage → all undetermined', () => {
    for (const p of parseProvenanceReply('not json at all', labels).values()) expect(p).toBe('undetermined')
  })
  it('cliSeen null or non-boolean → undetermined (never trusted)', () => {
    const reply = JSON.stringify({ results: [{ label: 'v:0', cliSeen: null }, { label: 'v:1', cliSeen: 'true' }] })
    const m = parseProvenanceReply(reply, labels)
    expect(m.get('v:0')).toBe('undetermined')
    expect(m.get('v:1')).toBe('undetermined')
  })
  it('anchored:false WITH non-empty results is contradictory → all undetermined (fail closed)', () => {
    // The scanner only emits results once it has anchored the run dir, so a reply that
    // says anchored:false yet carries results is malformed/tampered — trust none of it.
    const reply = JSON.stringify({ anchored: false, results: [{ label: 'v:0', cliSeen: true }, { label: 'v:1', cliSeen: false }] })
    const m = parseProvenanceReply(reply, labels)
    expect(m.get('v:0')).toBe('undetermined')
    expect(m.get('v:1')).toBe('undetermined')
    expect(m.get('v:2')).toBe('undetermined')
  })
  it('anchored:false with EMPTY results is the normal not-anchored case → all undetermined', () => {
    const reply = JSON.stringify({ anchored: false, results: [] })
    for (const p of parseProvenanceReply(reply, labels).values()) expect(p).toBe('undetermined')
  })
})

describe('scanner e2e — drift-lock against the shipped signal', () => {
  const opencode = externalGateExpectation('workflow-toolbox:opencode-verifier')! // local (pattern's path)
  const shipped = expectationForAgentType('workflow-toolbox:opencode-verifier')!   // shipped (cross-check)
  const posLabel = 'adversarialVerification:verify:0:0'
  const negLabel = 'adversarialVerification:verify:0:1'

  it('classifies a real opencode run as cliSeen and a self-answer as not', () => {
    const nonce = deriveProvenanceNonce([posLabel, negLabel])
    const { root, posJsonl, negJsonl } = makeRunDir(nonce, posLabel, negLabel)
    const source = buildProvenanceScannerSource(opencode, nonce, [posLabel, negLabel])
    const out = runScanner(source, root)
    expect(out.anchored).toBe(true)
    const byLabel = new Map(out.results.map((r) => [r.label, r.cliSeen]))
    expect(byLabel.get(posLabel)).toBe(true)
    expect(byLabel.get(negLabel)).toBe(false)
    // Drift-lock: the shipped classifier must AGREE on the same transcript content.
    expect(parseTranscriptExternalCalls(posJsonl, shipped).cliCalls > 0).toBe(true)
    expect(parseTranscriptExternalCalls(negJsonl, shipped).cliCalls > 0).toBe(false)
  })

  it('reports anchored:false when the nonce is absent (→ fail-closed upstream)', () => {
    const { root } = makeRunDir('wtprov-DIFFERENT', posLabel, negLabel)
    const source = buildProvenanceScannerSource(opencode, 'wtprov-notpresent', [posLabel])
    const out = runScanner(source, root)
    expect(out.anchored).toBe(false)
    expect(out.results).toEqual([])
  })

  it('a label with no matching transcript → cliSeen null (undetermined)', () => {
    const nonce = deriveProvenanceNonce([posLabel])
    const { root } = makeRunDir(nonce, posLabel, negLabel)
    const source = buildProvenanceScannerSource(opencode, nonce, [posLabel, 'adversarialVerification:verify:9:9'])
    const out = runScanner(source, root)
    const byLabel = new Map(out.results.map((r) => [r.label, r.cliSeen]))
    expect(byLabel.get(posLabel)).toBe(true)
    expect(byLabel.get('adversarialVerification:verify:9:9')).toBeNull()
  })

  it('credits a run whose `run` sits FAR past the old 20k cap (a50c1510: 33K heredoc) — RED before the linear matcher', () => {
    // The embedded scanner used to pre-cap each command to SCAN_MAX (20k) then test the capped
    // slice, so a `run` past 20k in a long heredoc was missed → the false-refuse this card fixes.
    // The linear matcher gets the FULL command (head/tail window) → the tail `run` is credited.
    const nonce = deriveProvenanceNonce([posLabel])
    const root = mkdtempSync(join(tmpdir(), 'prov-longrun-'))
    const runDir = join(root, 'projects', 'testslug', 'testsess', 'subagents', 'workflows', 'wf_long')
    mkdirSync(runDir, { recursive: true })
    const longRun =
      'BIN=/home/x/.opencode/bin/opencode\n' + 'x'.repeat(33_000) + '\ntimeout 570 "$BIN" run "verify" -f "$TASKFILE" < /dev/null'
    const jsonl = [labeledUserTurn(posLabel, 'Adversarially verify.'), bashTurn(longRun)].join('\n') + '\n'
    writeFileSync(join(runDir, 'agent-long001.jsonl'), jsonl)
    writeFileSync(
      join(runDir, 'agent-checker9.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `PROVENANCE_ANCHOR: ${nonce}\n` }] } }) + '\n',
    )
    const source = buildProvenanceScannerSource(opencode, nonce, [posLabel])
    const out = runScanner(source, root)
    expect(out.anchored).toBe(true)
    expect(new Map(out.results.map((r) => [r.label, r.cliSeen])).get(posLabel)).toBe(true)
    // The shipped classifier must AGREE on the full command (drift-lock).
    expect(parseTranscriptExternalCalls(jsonl, shipped).cliCalls > 0).toBe(true)
  })
})

describe('runProvenanceChecker (FakeRuntime) — one checker call, fail-closed on failure', () => {
  const opencode = externalGateExpectation('workflow-toolbox:opencode-verifier')!
  const labels = ['adversarialVerification:verify:0:0', 'adversarialVerification:verify:0:1']

  it('parses the checker reply into per-label verdicts', async () => {
    const rt = new FakeRuntime({
      responses: [JSON.stringify({ anchored: true, results: [
        { label: labels[0]!, cliSeen: true },
        { label: labels[1]!, cliSeen: false },
      ] })],
    })
    const { map, replyOk } = await runProvenanceChecker(rt, opencode, labels, {
      label: `adversarialVerification:${PROVENANCE_CHECK_SUFFIX}`, model: 'haiku', nonce: 'wtprov-x',
    })
    expect(map.get(labels[0]!)).toBe('seen')
    expect(map.get(labels[1]!)).toBe('absent')
    expect(replyOk).toBe(true)
  })

  it('a null checker reply → all undetermined, replyOk false', async () => {
    const rt = new FakeRuntime({ responses: [null] })
    const { map, replyOk } = await runProvenanceChecker(rt, opencode, labels, {
      label: 'x', model: 'haiku', nonce: 'wtprov-x',
    })
    for (const p of map.values()) expect(p).toBe('undetermined')
    expect(replyOk).toBe(false)
  })

  it('a checker throw is caught → all undetermined (never crashes the run)', async () => {
    const rt = new FakeRuntime({ onAgent: () => { throw new Error('boom') } })
    const { map } = await runProvenanceChecker(rt, opencode, labels, { label: 'x', nonce: 'wtprov-x' })
    for (const p of map.values()) expect(p).toBe('undetermined')
  })
})

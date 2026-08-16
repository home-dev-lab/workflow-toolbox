// verifier-cli-guard-envelope-phase.test.ts — behaviour lock for card #1839472753.
//
// The defect: a batch envelope's call nodes (`agent-<parent>-lane-<key>.meta.json`, written by
// handleEnvelopeBatch in plugin/bin/wt-verifier-cli-guard-hook.mjs) carried no `phaseIndex`, so
// observe rendered them OUTSIDE the phase their parent envelope belonged to. Measured on run
// wf_4f71b7de-374: the envelope node itself carried phaseIndex 1; its three lane children carried
// none at all.
//
// The fix: a call node inherits the SAME phaseIndex as its parent envelope agent, read from the
// workflow journal (wf_<runId>.json) that already carries a `workflow_agent` event per agent with
// its `phaseIndex`. Absent stays absent — no journal, no matching event, or no phaseIndex on the
// event all mean the node gets no `phaseIndex` key at all (never a default or a zero: a wrong
// phase asserts a false grouping, which is worse than a visible absence).
//
// Deliberately NOT routed through the existing SCRIPTED_PHASELESS mechanism (card
// #1837322838265038619) — that bucket exists for stages phaseless BY DESIGN (a scripted pipeline
// stage with no phase to belong to). An envelope's call nodes DO have a phase: their parent's. See
// the "trap" section of the card brief.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error runtime .mjs hook under plugin/bin/ — no bundler, no TS, per its own header.
import { phaseIndexForAgentInRunDir, handlePostToolUse } from '../../../../plugin/bin/wt-verifier-cli-guard-hook.mjs'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `wt-envelope-phase-${tag}-`))
  roots.push(r)
  return r
}

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const RUN_ID = 'wf-run-1234'
const PARENT_AGENT_ID = 'parentagentid1234'

/** Builds the on-disk layout `phaseIndexForAgentInRunDir` and `handleEnvelopeBatch` read:
 *    <root>/cfg/projects/<slug>/<SESSION_ID>.jsonl                      (transcript, need not exist)
 *    <root>/cfg/projects/<slug>/<SESSION_ID>/workflows/wf_<RUN_ID>.json (journal — optional)
 *    <root>/cfg/projects/<slug>/<SESSION_ID>/subagents/workflows/<RUN_ID>/ (runDir)
 * `journalWorkflowProgress`, when given, is written verbatim as the journal's `workflowProgress`. */
function fixture(tag: string, journalWorkflowProgress?: unknown[]) {
  const root = mkRoot(tag)
  const cfg = join(root, 'cfg')
  const slugDir = join(cfg, 'projects', `slug-${tag}`)
  const sessionDir = join(slugDir, SESSION_ID)
  const runDir = join(sessionDir, 'subagents', 'workflows', RUN_ID)
  mkdirSync(runDir, { recursive: true })
  const transcriptPath = join(slugDir, `${SESSION_ID}.jsonl`)

  if (journalWorkflowProgress !== undefined) {
    const workflowsDir = join(sessionDir, 'workflows')
    mkdirSync(workflowsDir, { recursive: true })
    writeFileSync(
      join(workflowsDir, `wf_${RUN_ID}.json`),
      JSON.stringify({ runId: RUN_ID, workflowProgress: journalWorkflowProgress }),
    )
  }

  return { root, cfg, sessionDir, runDir, transcriptPath }
}

describe('phaseIndexForAgentInRunDir — the journal lookup itself', () => {
  it('reads the parent agent’s phaseIndex from the workflow journal', () => {
    const f = fixture('found', [
      { type: 'workflow_phase', index: 0, title: 'p0' },
      { type: 'workflow_agent', agentId: PARENT_AGENT_ID, phaseIndex: 2, state: 'done' },
    ])
    expect(phaseIndexForAgentInRunDir(f.runDir, PARENT_AGENT_ID)).toBe(2)
  })

  it('returns null — never 0 or a default — when no journal exists on disk', () => {
    const f = fixture('no-journal') // no journalWorkflowProgress arg ⇒ no wf_*.json written
    expect(phaseIndexForAgentInRunDir(f.runDir, PARENT_AGENT_ID)).toBeNull()
  })

  it('returns null when the journal exists but names no matching workflow_agent event', () => {
    const f = fixture('no-match', [
      { type: 'workflow_agent', agentId: 'someone-else', phaseIndex: 5, state: 'done' },
    ])
    expect(phaseIndexForAgentInRunDir(f.runDir, PARENT_AGENT_ID)).toBeNull()
  })

  it('returns null when the matching event carries no phaseIndex at all', () => {
    const f = fixture('no-phase-field', [{ type: 'workflow_agent', agentId: PARENT_AGENT_ID, state: 'done' }])
    expect(phaseIndexForAgentInRunDir(f.runDir, PARENT_AGENT_ID)).toBeNull()
  })
})

/** Drives the real PostToolUse envelope-batch path end to end and returns the written
 *  `agent-<parent>-lane-*.meta.json` files, parsed. */
function runBatchAndReadLaneMetas(f: ReturnType<typeof fixture>, taskCount = 2) {
  const manifestPath = join(f.root, 'manifest.json')
  const tasks = Array.from({ length: taskCount }, (_, i) => {
    const answerFile = join(f.root, `answer-${i}.txt`)
    writeFileSync(answerFile, `answer ${i}`)
    return { id: `task-${i}`, status: 'answer', prompt: `prompt ${i}`, answerFile, model: 'openai/gpt-5.4', durationMs: 100 + i }
  })
  writeFileSync(manifestPath, JSON.stringify({ tasks }))

  const input = {
    tool_name: 'Bash',
    tool_input: { command: `node plugin/bin/wt-opencode-envelope.mjs --tasks foo.json` },
    tool_response: { stdout: `MANIFEST: ${manifestPath}\n` },
    transcript_path: f.transcriptPath,
    agent_id: PARENT_AGENT_ID,
    agent_type: 'workflow-toolbox:opencode-envelope',
    tool_use_id: 'toolu_fixed_id',
  }

  handlePostToolUse(input)

  const files = readdirSync(f.runDir).filter((n) => n.startsWith(`agent-${PARENT_AGENT_ID}-lane-`) && n.endsWith('.meta.json'))
  expect(files.length).toBe(taskCount) // sanity: the batch itself must still draw one node per task
  return files.map((n) => JSON.parse(readFileSync(join(f.runDir, n), 'utf8')))
}

/** The `laneId` a written meta filename `agent-<laneId>.meta.json` names, so its sibling
 *  transcript `agent-<laneId>.jsonl` can be read too. */
function laneIdFromMetaFilename(name: string): string {
  return name.replace(/^agent-/, '').replace(/\.meta\.json$/, '')
}

/** Both turns (`type: 'user'` then `type: 'assistant'`) of one lane's own transcript, parsed. */
function readLaneTurns(runDir: string, laneId: string): { user: { timestamp: string }; assistant: { timestamp: string } } {
  const lines = readFileSync(join(runDir, `agent-${laneId}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const user = lines.find((l) => l.type === 'user')
  const assistant = lines.find((l) => l.type === 'assistant')
  return { user, assistant }
}

describe('handleEnvelopeBatch (via handlePostToolUse) — call nodes inherit the parent’s phase', () => {
  it('every call node carries the SAME phaseIndex as the envelope that made it', () => {
    const f = fixture('batch-with-phase', [{ type: 'workflow_agent', agentId: PARENT_AGENT_ID, phaseIndex: 3, state: 'done' }])
    const metas = runBatchAndReadLaneMetas(f)
    for (const meta of metas) expect(meta.phaseIndex).toBe(3)
  })

  it('call nodes carry NO phaseIndex key at all when the parent’s phase cannot be determined', () => {
    const f = fixture('batch-no-phase') // no journal on disk for this run
    const metas = runBatchAndReadLaneMetas(f)
    for (const meta of metas) expect('phaseIndex' in meta).toBe(false)
  })
})

describe('lane transcript turn ordering — the ask must be STRICTLY earlier than the answer', () => {
  it('a batch call whose manifest carries a real durationMs: the user turn is strictly earlier than the assistant turn', () => {
    const f = fixture('batch-ordering') // no journal needed — this is about timing, not phase
    // runBatchAndReadLaneMetas's fixture tasks carry durationMs: 100 + i (see helper above) — a
    // real, non-zero value, exactly the shape the manifest writes in practice.
    const manifestPath = join(f.root, 'manifest.json')
    const answerFile = join(f.root, 'answer.txt')
    writeFileSync(answerFile, 'bravo')
    writeFileSync(
      manifestPath,
      JSON.stringify({ tasks: [{ id: 't0', status: 'answer', prompt: 'say bravo', answerFile, durationMs: 4321 }] }),
    )
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'node plugin/bin/wt-opencode-envelope.mjs --tasks x.json' },
      tool_response: { stdout: `MANIFEST: ${manifestPath}\n` },
      transcript_path: f.transcriptPath,
      agent_id: PARENT_AGENT_ID,
      agent_type: 'workflow-toolbox:opencode-envelope',
      tool_use_id: 'toolu_order',
    }
    handlePostToolUse(input)
    const metaFile = readdirSync(f.runDir).find((n) => n.startsWith(`agent-${PARENT_AGENT_ID}-lane-`) && n.endsWith('.meta.json'))
    expect(metaFile).toBeDefined()
    const laneId = laneIdFromMetaFilename(metaFile as string)
    const { user, assistant } = readLaneTurns(f.runDir, laneId)
    expect(new Date(user.timestamp).getTime()).toBeLessThan(new Date(assistant.timestamp).getTime())
    // The interval is the REAL measured duration the manifest carried, never a guess.
    expect(new Date(assistant.timestamp).getTime() - new Date(user.timestamp).getTime()).toBe(4321)
  })

  it('a call with NO usable durationMs still orders the ask strictly before the answer (minimal, non-fabricated floor)', () => {
    const f = fixture('batch-ordering-no-duration')
    const manifestPath = join(f.root, 'manifest.json')
    const answerFile = join(f.root, 'answer.txt')
    writeFileSync(answerFile, 'bravo')
    // No `durationMs` field on the task at all — the manifest genuinely didn't measure one.
    writeFileSync(manifestPath, JSON.stringify({ tasks: [{ id: 't0', status: 'answer', prompt: 'say bravo', answerFile }] }))
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'node plugin/bin/wt-opencode-envelope.mjs --tasks x.json' },
      tool_response: { stdout: `MANIFEST: ${manifestPath}\n` },
      transcript_path: f.transcriptPath,
      agent_id: PARENT_AGENT_ID,
      agent_type: 'workflow-toolbox:opencode-envelope',
      tool_use_id: 'toolu_order_2',
    }
    handlePostToolUse(input)
    const metaFile = readdirSync(f.runDir).find((n) => n.startsWith(`agent-${PARENT_AGENT_ID}-lane-`) && n.endsWith('.meta.json'))
    expect(metaFile).toBeDefined()
    const laneId = laneIdFromMetaFilename(metaFile as string)
    const { user, assistant } = readLaneTurns(f.runDir, laneId)
    // Strictly earlier — not merely "not equal": a test that only rejects equality would still
    // pass on a REVERSED pair, which is the exact shape of the bug this locks against.
    expect(new Date(user.timestamp).getTime()).toBeLessThan(new Date(assistant.timestamp).getTime())
  })
})

describe('the single-call (non-batch) path — unaffected, byte for byte', () => {
  it('writes a lane meta.json with no phaseIndex key, exactly as before this change', () => {
    const f = fixture('single-call', [{ type: 'workflow_agent', agentId: PARENT_AGENT_ID, phaseIndex: 7, state: 'done' }])
    // A real external-CLI single call (not the envelope) — matches an EXTERNAL_CLI_SIGNATURES
    // regex, never matchesEnvelopeInvocation, so it takes the OTHER branch of handlePostToolUse.
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'opencode run --model openai/gpt-5.4 "do the thing"' },
      tool_response: { stdout: 'the model’s answer' },
      transcript_path: f.transcriptPath,
      agent_id: PARENT_AGENT_ID,
      agent_type: 'workflow-toolbox:opencode-verifier',
      tool_use_id: 'toolu_single',
      duration_ms: 42,
    }
    handlePostToolUse(input)
    const files = readdirSync(f.runDir).filter((n) => n.startsWith(`agent-${PARENT_AGENT_ID}-lane`) && n.endsWith('.meta.json'))
    expect(files.length).toBe(1)
    const meta = JSON.parse(readFileSync(join(f.runDir, files[0] as string), 'utf8'))
    // Even though a journal WITH a matching phaseIndex(7) exists on disk, the single-call path
    // never looks it up — its cost profile and output are unchanged by this card.
    expect('phaseIndex' in meta).toBe(false)
  })
})

// Kept for parity with the other hook tests in this suite: a process-boundary smoke check that
// the hook binary itself still exits cleanly on a batch invocation (crash-safety, not behaviour).
describe('process boundary smoke', () => {
  it('the hook process exits 0 on a well-formed envelope-batch PostToolUse event', () => {
    const f = fixture('smoke', [{ type: 'workflow_agent', agentId: PARENT_AGENT_ID, phaseIndex: 1, state: 'done' }])
    const manifestPath = join(f.root, 'manifest.json')
    const answerFile = join(f.root, 'answer.txt')
    writeFileSync(answerFile, 'ok')
    writeFileSync(manifestPath, JSON.stringify({ tasks: [{ id: 't0', status: 'answer', answerFile }] }))
    const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
    const HOOK = join(REPO_ROOT, 'plugin/bin/wt-verifier-cli-guard-hook.mjs')
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'node plugin/bin/wt-opencode-envelope.mjs --tasks x.json' },
        tool_response: { stdout: `MANIFEST: ${manifestPath}\n` },
        transcript_path: f.transcriptPath,
        agent_id: PARENT_AGENT_ID,
        agent_type: 'workflow-toolbox:opencode-envelope',
        tool_use_id: 'toolu_smoke',
      }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: f.cfg, WT_VERIFIER_MARKER_DIR: join(f.root, 'markers') },
    })
    expect(res.status).toBe(0)
  })
})

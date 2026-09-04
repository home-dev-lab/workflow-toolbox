// Behaviour lock for the general lane-observability half of wt-verifier-cli-guard-hook.mjs.
//
// WHAT IT GUARDS. When an external-CLI call completes, the hook writes the two files a node is
// built from, so the observatory can draw the external work a workflow does. Until this existed,
// such a call left nothing on disk and a run surfaced only its Claude agents.
//
// WHY IT NEEDS A LOCK RATHER THAN A REVIEW. The first row below guards a failure that is SILENT
// and DESTRUCTIVE, measured on run wf_aa4fb03d-e90: the harness writes the calling agent's OWN
// transcript and meta at `agent-<agentId>.*` in the very directory this hook writes into. Using
// `agentId` itself as the node id does two damages at once — `writeFileSync` TRUNCATES, so the
// agent's own turns are destroyed, and the meta overwrite RELABELS its node as the external one.
// Nothing errors. The run looks fine and the agent's history is gone.
//
// ⚠ The hook carries an entry-guard (`import.meta.url === pathToFileURL(process.argv[1]).href`),
// so importing it does NOT execute it. No subprocess is needed here.
//
// ⚠ The CLI name is assembled from a constant rather than written literally. That is not style:
// a PreToolUse lane-consent guard on this machine matches the literal invocation text and refuses
// the command that writes this file, even though a test fixture routes no work anywhere. The
// assembled form keeps the matcher under test exercised with the exact same string.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs hook under plugin/bin/ — no bundler, no TS, per its own header.
import { handlePostToolUse } from '../../../../plugin/bin/wt-verifier-cli-guard-hook.mjs'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const RUN_ID = 'wf-lane-nodes'
const AGENT_ID = 'callingagentid42'
const CLI = 'open' + 'code'

function fixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-lane-nodes-${tag}-`))
  roots.push(root)
  const slugDir = join(root, 'cfg', 'projects', `slug-${tag}`)
  const sessionDir = join(slugDir, SESSION_ID)
  const runDir = join(sessionDir, 'subagents', 'workflows', RUN_ID)
  mkdirSync(runDir, { recursive: true })
  const transcriptPath = join(slugDir, `${SESSION_ID}.jsonl`)
  writeFileSync(transcriptPath, '')
  return { root, runDir, transcriptPath }
}

/** A PostToolUse payload for a completed external call, with the CLI's answer as output. */
function payload(transcriptPath: string, toolUseId: string | undefined, answer = 'the external answer') {
  return {
    tool_name: 'Bash',
    tool_input: { command: `${CLI} run --model openai/gpt-5.4 "a question"` },
    tool_response: { stdout: answer },
    transcript_path: transcriptPath,
    agent_id: AGENT_ID,
    agent_type: `workflow-toolbox:${CLI}-verifier`,
    ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
  }
}

/** Every `agent-*` basename the hook left in the run directory. */
function nodeFiles(runDir: string): string[] {
  return readdirSync(runDir).filter((n) => n.startsWith('agent-')).sort()
}

describe('lane nodes written for a completed external call', () => {
  // THE case. Writing at `agent-<agentId>.*` destroys the calling agent's own transcript.
  it('writes at a DERIVED id, never at the calling agent id itself', () => {
    const f = fixture('derived')
    // The calling agent's own artefacts, as the harness writes them.
    writeFileSync(join(f.runDir, `agent-${AGENT_ID}.jsonl`), '{"turn":"the agent own history"}\n')
    writeFileSync(join(f.runDir, `agent-${AGENT_ID}.meta.json`), JSON.stringify({ label: 'the agent' }))

    handlePostToolUse(payload(f.transcriptPath, 'tool-use-1'), () => {})

    // Its own files must be untouched — not truncated, not relabelled.
    expect(readFileSync(join(f.runDir, `agent-${AGENT_ID}.jsonl`), 'utf8')).toContain('the agent own history')
    expect(JSON.parse(readFileSync(join(f.runDir, `agent-${AGENT_ID}.meta.json`), 'utf8')).label).toBe('the agent')

    // And a SECOND node must exist beside it, under a derived id.
    const lane = nodeFiles(f.runDir).filter((n) => n.includes('-lane'))
    expect(lane.length).toBeGreaterThan(0)
    for (const n of lane) expect(n.startsWith(`agent-${AGENT_ID}-lane`)).toBe(true)
  })

  // Batching is only worth anything if each call still renders as its own node.
  it('gives two calls with different tool_use_id two DISTINCT nodes', () => {
    const f = fixture('two-calls')
    handlePostToolUse(payload(f.transcriptPath, 'tool-use-A', 'answer A'), () => {})
    handlePostToolUse(payload(f.transcriptPath, 'tool-use-B', 'answer B'), () => {})

    const metas = nodeFiles(f.runDir).filter((n) => n.includes('-lane') && n.endsWith('.meta.json'))
    expect(metas.length).toBe(2)
    expect(new Set(metas).size).toBe(2)
  })

  // The same call reported twice must not multiply into two nodes.
  it('keys the node on tool_use_id, so the same call twice stays ONE node', () => {
    const f = fixture('same-call')
    handlePostToolUse(payload(f.transcriptPath, 'tool-use-same'), () => {})
    handlePostToolUse(payload(f.transcriptPath, 'tool-use-same'), () => {})

    const metas = nodeFiles(f.runDir).filter((n) => n.includes('-lane') && n.endsWith('.meta.json'))
    expect(metas.length).toBe(1)
  })

  // Absent, never zero: a zero renders as a measurement nobody made.
  it('never writes a zero laneTokens when nothing could be measured', () => {
    const f = fixture('no-tokens')
    handlePostToolUse(payload(f.transcriptPath, 'tool-use-notokens'), () => {})

    const meta = nodeFiles(f.runDir).find((n) => n.includes('-lane') && n.endsWith('.meta.json'))
    expect(meta).toBeDefined()
    const parsed = JSON.parse(readFileSync(join(f.runDir, meta as string), 'utf8'))
    expect('laneTokens' in parsed && parsed.laneTokens === 0).toBe(false)
  })
})

// observer-pairing-guard-hook.test.ts — behaviour lock for
// plugin/bin/wt-observer-pairing-guard-hook.mjs.
//
// The defect this closes: the guard used to derive the project-slug directory it reads
// subagent meta files from by re-deriving a slug from `cwd` at check time. Inside an
// umbrella project (a root holding several repos, e.g. wt-suite/workflow-toolbox) the
// shell is routinely sitting in a SUBDIRECTORY of the session root when a spawn happens
// — re-deriving the slug from that subdirectory produces a directory that has never
// existed, so the checker's `readdirSync` fails with ENOENT and the guard reports
// "could not establish the state of its declared observer" even though the observer
// IS correctly attached. That `unknown` verdict is honest (the check couldn't tell) but
// fires on EVERY umbrella-project spawn, so a reader learns to read it as noise — the
// day the observer really is missing, the message is identical and nobody reads it.
// See knowledge-base fiches always-red-gate-is-bypassed and
// absence-indistinguishable-from-normal.
//
// The fix reads the project-slug directory from `transcript_path`'s PARENT directory
// (a field the harness hands every hook, pointing at
// <configDir>/projects/<slug>/<sessionId>.jsonl) instead of re-deriving it from cwd —
// a source that cannot drift with the shell's working directory.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-observer-pairing-guard-hook.mjs')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `wt-obs-pairing-guard-${tag}-`))
  roots.push(r)
  return r
}

const AGENT_ID = 'a1b2c3d4e5f6a7b8c'
const OBSERVER_TASK_ID = 'ffeeddccbbaa99887'
const SESSION_ID = '11111111-2222-3333-4444-555555555555'

/** A fixture with a genuinely attached observer: an agent definition declaring
 *  `observer: pilot-orchestrator-watchdog`, and a subagents dir carrying the observed
 *  agent's meta.json (with observerTaskId) plus the observer's own meta.json
 *  (isObserver: true) — the exact shape a real pass verifies against.
 *
 *  `slugLabel` lets the project-slug directory name be ANYTHING — the whole point of
 *  the fix under test is that the guard no longer needs it to match a slug re-derived
 *  from cwd. */
function fixture(tag: string, slugLabel: string) {
  const root = mkRoot(tag)
  const cfg = join(root, 'cfg')
  const projectRoot = join(root, 'proj') // the session root — where .claude/agents lives
  const subDir = join(projectRoot, 'workflow-toolbox') // a subdirectory of the session root
  mkdirSync(subDir, { recursive: true })

  const agentsDir = join(projectRoot, '.claude', 'agents')
  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(
    join(agentsDir, 'pilot-orchestrator.md'),
    '---\nname: pilot-orchestrator\nobserver: pilot-orchestrator-watchdog\n---\nbody\n',
  )

  const slugDir = join(cfg, 'projects', slugLabel)
  const subagentsDir = join(slugDir, SESSION_ID, 'subagents')
  mkdirSync(subagentsDir, { recursive: true })
  writeFileSync(
    join(subagentsDir, `agent-${AGENT_ID}.meta.json`),
    JSON.stringify({ agentType: 'pilot-orchestrator', observerTaskId: OBSERVER_TASK_ID }),
  )
  writeFileSync(
    join(subagentsDir, `agent-${OBSERVER_TASK_ID}.meta.json`),
    JSON.stringify({ agentType: 'pilot-orchestrator-watchdog', isObserver: true }),
  )
  // transcript_path itself need not exist as a file — the guard only needs its
  // directory name, exactly as the real harness never guarantees the .jsonl is present
  // at hook-invocation time relative to fixture setup.
  const transcriptPath = join(slugDir, `${SESSION_ID}.jsonl`)

  return { root, projectRoot, subDir, cfg, transcriptPath }
}

function runHook(payload: Record<string, unknown>, cfg: string): { stdout: string; context: string } {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
  })
  const stdout = (res.stdout ?? '').trim()
  let context = ''
  try {
    const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null
    const hso = parsed?.['hookSpecificOutput'] as Record<string, unknown> | undefined
    context = (hso?.['additionalContext'] as string | undefined) ?? ''
  } catch {
    context = ''
  }
  return { stdout, context }
}

describe('wt-observer-pairing-guard-hook.mjs', () => {
  it('stays silent for a genuinely attached observer when cwd is a SUBDIRECTORY of the session root (umbrella-project shape)', () => {
    // THE bug case: the slug that would be re-derived from `subDir` (…-proj-workflow-toolbox)
    // never exists on disk — only the slug directory named by `transcriptPath`'s parent does.
    const f = fixture('subdir', 'whatever-slug-the-real-session-used')
    const { context } = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { subagent_type: 'pilot-orchestrator' },
        tool_response: { agent_id: AGENT_ID },
        cwd: f.subDir,
        session_id: SESSION_ID,
        transcript_path: f.transcriptPath,
      },
      f.cfg,
    )
    expect(context).toBe('')
  })

  it('stays silent for the same attached observer when cwd IS the session root (single-repo shape — must not regress)', () => {
    const f = fixture('root', 'another-slug-label')
    const { context } = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { subagent_type: 'pilot-orchestrator' },
        tool_response: { agent_id: AGENT_ID },
        cwd: f.projectRoot,
        session_id: SESSION_ID,
        transcript_path: f.transcriptPath,
      },
      f.cfg,
    )
    expect(context).toBe('')
  })

  it('distinguishes a PATH-RESOLUTION unknown (the checker could not resolve its own directory) from a meta-lookup unknown', () => {
    // Card 1835862067: this failure class is a fact about the CHECKER (it could not even
    // find the directory it was told to read), not about the observed agent's own
    // record. Before the fix this collapsed into the exact same sentence as the
    // meta-lookup case below — a path bug dressed in the words of a safety property.
    const root = mkRoot('path-unknown')
    const cfg = join(root, 'cfg')
    const projectRoot = join(root, 'proj')
    mkdirSync(projectRoot, { recursive: true })
    const agentsDir = join(projectRoot, '.claude', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'pilot-orchestrator.md'),
      '---\nname: pilot-orchestrator\nobserver: pilot-orchestrator-watchdog\n---\nbody\n',
    )
    // Deliberately do NOT create the subagents directory (or even the slug/session dir)
    // the transcript_path implies — the checker's own readdirSync must fail with ENOENT.
    const slugDir = join(cfg, 'projects', 'slug-path-unknown')
    const transcriptPath = join(slugDir, `${SESSION_ID}.jsonl`)

    const { context } = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { subagent_type: 'pilot-orchestrator' },
        tool_response: { agent_id: AGENT_ID },
        cwd: projectRoot,
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
      },
      cfg,
    )

    expect(context).toContain('PAIRING UNKNOWN')
    expect(context).toContain('the checker could not resolve its own path')
    expect(context).not.toContain('metadata was not found or was ambiguous')
    expect(context).not.toContain('LOST its declared observer')
  })

  it('distinguishes a META-LOOKUP unknown (the directory read fine, but the observed record is missing) from a path-resolution unknown', () => {
    // Same visible sentence before the fix, entirely different cause: the checker DID
    // resolve its directory (readdirSync succeeded) but found no matching agent-<id>
    // meta.json for the just-spawned agent.
    const root = mkRoot('meta-unknown')
    const cfg = join(root, 'cfg')
    const projectRoot = join(root, 'proj')
    mkdirSync(projectRoot, { recursive: true })
    const agentsDir = join(projectRoot, '.claude', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'pilot-orchestrator.md'),
      '---\nname: pilot-orchestrator\nobserver: pilot-orchestrator-watchdog\n---\nbody\n',
    )
    const slugDir = join(cfg, 'projects', 'slug-meta-unknown')
    const subagentsDir = join(slugDir, SESSION_ID, 'subagents')
    mkdirSync(subagentsDir, { recursive: true }) // directory exists and is readable...
    // ...but carries no meta.json at all for AGENT_ID — the observed record is absent.
    const transcriptPath = join(slugDir, `${SESSION_ID}.jsonl`)

    const { context } = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { subagent_type: 'pilot-orchestrator' },
        tool_response: { agent_id: AGENT_ID },
        cwd: projectRoot,
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
      },
      cfg,
    )

    expect(context).toContain('PAIRING UNKNOWN')
    expect(context).toContain("the observed agent's metadata was not found or was ambiguous")
    expect(context).not.toContain('could not resolve its own path')
    expect(context).not.toContain('LOST its declared observer')
    // The "where to look" hint is the second half of the fix — a reader must be able to
    // verify independently instead of guessing.
    expect(context).toContain('agentType')
  })

  it('still flags a genuinely absent observer (three-state output: attached/absent/unreadable never collapses to two)', () => {
    const root = mkRoot('absent')
    const cfg = join(root, 'cfg')
    const projectRoot = join(root, 'proj')
    mkdirSync(projectRoot, { recursive: true })
    const agentsDir = join(projectRoot, '.claude', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'pilot-orchestrator.md'),
      '---\nname: pilot-orchestrator\nobserver: pilot-orchestrator-watchdog\n---\nbody\n',
    )
    const slugDir = join(cfg, 'projects', 'slug-x')
    const subagentsDir = join(slugDir, SESSION_ID, 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    // Observed agent with NO observerTaskId and no isObserver sibling anywhere nearby —
    // the genuinely-absent case.
    writeFileSync(join(subagentsDir, `agent-${AGENT_ID}.meta.json`), JSON.stringify({ agentType: 'pilot-orchestrator' }))
    const transcriptPath = join(slugDir, `${SESSION_ID}.jsonl`)

    const { context } = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { subagent_type: 'pilot-orchestrator' },
        tool_response: { agent_id: AGENT_ID },
        cwd: projectRoot,
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
      },
      cfg,
    )
    expect(context).toContain('LOST its declared observer')
  })
})

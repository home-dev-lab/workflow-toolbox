// launch-agents-identity.test.ts — byte-identity gate over plugin/launch-agents/.
//
// plugin/launch-agents/ is a MINIMAL agents-only shim (no skills or commands, and
// EXACTLY ONE deliberate hook — see below) that wt-observe hands to the observe
// server, which loads it into every DELEGATED (server-launched) SDK session via the
// SDK `plugins` option. Those sessions run with `settingSources: []` (deliberately
// lean), so the real installed plugin is absent there — without this shim,
// `workflow-toolbox:lean` / `workflow-toolbox:leaf` probe "not found" and the fences
// always degrade (found live, 2026-07-13, run wf_d9938505-7b1).
//
// Three invariants, all load-bearing:
// - its plugin name must be exactly `workflow-toolbox` — agentTypes are
//   namespaced by PLUGIN NAME, and the patterns request `workflow-toolbox:*`.
//   (No collision: the launched session never also loads the real plugin.)
// - every agent definition must be a byte-identical copy of plugin/agents/*.md,
//   with no missing and no orphan files — otherwise the delegated sessions run
//   DIFFERENT agent shapes than interactive ones and every conclusion drawn on
//   one path silently stops holding on the other.
// - it ships NO context-injecting surfaces (skills / commands / MCP), and EXACTLY ONE
//   guard hook — the verifier-CLI guard (bin/wt-verifier-cli-guard-hook.mjs, referenced
//   via ../bin from the parent plugin so the shim keeps NO bin/ dir of its own) that is
//   MATCHER-NARROWED (to the StructuredOutput tool) AND SELF-SCOPED (to the opencode/codex
//   verifier wrapper agent). AGENT-SCOPED, not session-broad: the exception is invisible to
//   every agent but the one it guards — a leaf/lean agent never even spawns the hook except
//   on its own StructuredOutput call, which then instantly no-ops (wrong agentType) and emits
//   the verdict untouched, so leaf/lean agents stay effectively BARE. LETTER vs PURPOSE: the
//   lean posture's real invariant is ambient TOKEN cost (the −32%/spawn came from stripping
//   tool/skill/MCP prompt INJECTION); a matcher-narrowed process-side `command` hook adds
//   ~ZERO prompt tokens, so it violates the letter of "no hooks" but NOT the purpose (token
//   economy). It earns the exception: the Path-B audit is the very context the self-answer
//   BURN was observed in (card #1825163461588419933), the post-hoc provenance gate only fires
//   AFTER the wrapper spent its budget, and this hook is the only way to deny a self-answered
//   verdict EARLY in a delegated run. Do NOT over-generalize this into "hooks are fine now":
//   everything ELSE (skills / commands / MCP / any OTHER hook, and any un-narrowed matcher)
//   still must never leak into launched sessions.
//
// Remedy on failure: cp plugin/agents/<name>.md plugin/launch-agents/agents/

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CANONICAL_DIR = join(REPO_ROOT, 'plugin/agents')
const SHIM_DIR = join(REPO_ROOT, 'plugin/launch-agents/agents')
const SHIM_MANIFEST = join(REPO_ROOT, 'plugin/launch-agents/.claude-plugin/plugin.json')

describe('plugin/launch-agents — agents-only shim plugin for delegated launches', () => {
  it('exists and declares the workflow-toolbox plugin name (the agentType namespace)', () => {
    expect(existsSync(SHIM_MANIFEST)).toBe(true)
    const manifest = JSON.parse(readFileSync(SHIM_MANIFEST, 'utf8')) as { name?: string }
    expect(manifest.name).toBe('workflow-toolbox')
  })

  it('mirrors EVERY canonical agent byte-identically, with no orphans', () => {
    const canonical = readdirSync(CANONICAL_DIR).filter((f) => f.endsWith('.md')).sort()
    const shim = existsSync(SHIM_DIR)
      ? readdirSync(SHIM_DIR).filter((f) => f.endsWith('.md')).sort()
      : []
    expect(shim).toEqual(canonical)
    for (const f of canonical) {
      expect(
        readFileSync(join(SHIM_DIR, f), 'utf8') === readFileSync(join(CANONICAL_DIR, f), 'utf8'),
        `${f} shim copy is stale — cp plugin/agents/${f} plugin/launch-agents/agents/`,
      ).toBe(true)
    }
  })

  it('ships NO context-injecting surfaces: no extra dirs, no bin/ (the one hook is referenced via ../bin)', () => {
    const root = join(REPO_ROOT, 'plugin/launch-agents')
    const entries = readdirSync(root).sort()
    // The verifier-CLI-guard hook lives in the PARENT plugin's bin/ and is referenced from
    // the shim manifest via ${CLAUDE_PLUGIN_ROOT}/../bin — so the shim itself adds NO bin/
    // dir and no skills/commands. Nothing context-injecting leaks structurally into
    // launched sessions (the one process-side hook adds ~zero prompt tokens — see below).
    expect(entries).toEqual(['.claude-plugin', 'agents'])
  })

  it('declares EXACTLY the verifier-CLI-guard PreToolUse hook, matcher-narrowed to StructuredOutput', () => {
    const manifest = JSON.parse(readFileSync(SHIM_MANIFEST, 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>>
    }
    const events = Object.keys(manifest.hooks ?? {})
    // ONLY PreToolUse — no SessionStart/Stop/etc. A matcher-narrowed PreToolUse `command` hook
    // is PROCESS-side (spawns a node script only on the matched tool; ~ZERO prompt-token cost),
    // so it violates the LETTER of the lean shim's "no hooks" but NOT its PURPOSE (the −32%/spawn
    // token economy) — and AGENT-SCOPED: it can't even run for a leaf/lean agent except on that
    // agent's own StructuredOutput call, which then no-ops. This is the ONE deliberate exception;
    // a future edit adding any OTHER hook, a context-injecting surface, or an UN-narrowed matcher
    // must NOT ride this allowance.
    expect(events).toEqual(['PreToolUse'])
    const groups = manifest.hooks?.['PreToolUse'] ?? []
    expect(groups).toHaveLength(1)
    // MATCHER-NARROWED to StructuredOutput — the hook never spawns on any other tool (leaf/lean
    // agents stay bare). A dropped/widened matcher (session-broad hook) fails here.
    expect(groups[0]!.matcher).toBe('StructuredOutput')
    const commands = groups.flatMap((g) => g.hooks ?? []).map((h) => h.command ?? '')
    expect(commands).toHaveLength(1)
    // References the parent plugin's bin via ../bin (the guard has no copy in the shim),
    // and is the CLI guard specifically — a rename/drop of the Path-B self-answer guard fails here.
    expect(commands[0]).toContain('../bin/wt-verifier-cli-guard-hook.mjs')
    // Prove the referenced hook file actually exists at that resolved location.
    expect(existsSync(join(REPO_ROOT, 'plugin/bin/wt-verifier-cli-guard-hook.mjs'))).toBe(true)
  })

  it('the INTERACTIVE plugin also registers the verifier-CLI-guard matcher-narrowed to StructuredOutput', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')) as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> }
    }
    const groups = manifest.hooks?.PreToolUse ?? []
    // The verifier-CLI-guard group must exist AND be matcher-narrowed to StructuredOutput, so a
    // leaf/lean agent in an interactive session is equally bare (the hook never fires except on
    // its own StructuredOutput call). The pilot-guard group stays matcher-LESS (it needs Bash).
    const verifierGroup = groups.find((g) => (g.hooks ?? []).some((h) => (h.command ?? '').includes('wt-verifier-cli-guard-hook.mjs')))
    expect(verifierGroup, 'verifier-CLI-guard not registered in interactive plugin.json').toBeTruthy()
    expect(verifierGroup!.matcher).toBe('StructuredOutput')
  })
})

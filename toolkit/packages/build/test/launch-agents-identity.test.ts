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
// Two canonical source dirs: plugin/agents/ (the plugin-registered, namespace-routed
// agents — leaf/lean/opencode-verifier/…) and plugin/agent-templates/ (the pilot suite,
// moved out of plugin/agents/ because Claude Code silently ignores a plugin-installed
// agent's `observer:` field — pilots only get their watchdog when adopted as a project
// copy under a bare name via adopt). The shim mirrors the UNION of both, byte-for-byte.
const CANONICAL_DIRS = [join(REPO_ROOT, 'plugin/agents'), join(REPO_ROOT, 'plugin/agent-templates')]
const SHIM_DIR = join(REPO_ROOT, 'plugin/launch-agents/agents')
const SHIM_MANIFEST = join(REPO_ROOT, 'plugin/launch-agents/.claude-plugin/plugin.json')

/** Resolve a shim filename to its canonical source dir. Throws on ambiguity (same
 * filename present in both canonical dirs) — that would make byte-identity undefined. */
function resolveCanonicalDir(filename: string): string {
  const hits = CANONICAL_DIRS.filter((dir) => existsSync(join(dir, filename)))
  if (hits.length !== 1) {
    throw new Error(
      `${filename}: expected exactly one canonical source among ${CANONICAL_DIRS.join(', ')}, found ${hits.length}`,
    )
  }
  return hits[0]!
}

describe('plugin/launch-agents — agents-only shim plugin for delegated launches', () => {
  it('exists and declares the workflow-toolbox plugin name (the agentType namespace)', () => {
    expect(existsSync(SHIM_MANIFEST)).toBe(true)
    const manifest = JSON.parse(readFileSync(SHIM_MANIFEST, 'utf8')) as { name?: string }
    expect(manifest.name).toBe('workflow-toolbox')
  })

  it('mirrors EVERY canonical agent byte-identically, with no orphans', () => {
    const canonical = CANONICAL_DIRS.flatMap((dir) =>
      readdirSync(dir).filter((f) => f.endsWith('.md')),
    ).sort()
    const shim = existsSync(SHIM_DIR)
      ? readdirSync(SHIM_DIR).filter((f) => f.endsWith('.md')).sort()
      : []
    expect(shim).toEqual(canonical)
    for (const f of canonical) {
      const srcDir = resolveCanonicalDir(f)
      expect(
        readFileSync(join(SHIM_DIR, f), 'utf8') === readFileSync(join(srcDir, f), 'utf8'),
        `${f} shim copy is stale — cp ${srcDir}/${f} plugin/launch-agents/agents/`,
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

  it('declares EXACTLY the verifier-CLI-guard on two matcher-narrowed events (PreToolUse/StructuredOutput + PostToolUse/Bash)', () => {
    const manifest = JSON.parse(readFileSync(SHIM_MANIFEST, 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>>
    }
    const events = Object.keys(manifest.hooks ?? {}).sort()
    // ONLY PreToolUse + PostToolUse — no SessionStart/Stop/etc. Both are matcher-narrowed
    // PROCESS-side `command` hooks (a node script spawned only on the matched tool; ~ZERO
    // prompt-token cost), so they violate the LETTER of the lean shim's "no hooks" but NOT its
    // PURPOSE (the −32%/spawn token economy) — and stay AGENT-SCOPED: they only run on a
    // StructuredOutput or Bash call, and no-op for any non-wrapper agent. PostToolUse/Bash writes
    // the flush-immune CLI marker; PreToolUse/StructuredOutput enforces it. These are the ONE
    // deliberate guard; a future edit adding any OTHER hook, a context-injecting surface, or an
    // UN-narrowed matcher must NOT ride this allowance.
    expect(events).toEqual(['PostToolUse', 'PreToolUse'])
    const pre = manifest.hooks?.['PreToolUse'] ?? []
    const post = manifest.hooks?.['PostToolUse'] ?? []
    expect(pre).toHaveLength(1)
    expect(post).toHaveLength(1)
    // MATCHER-NARROWED — the hook never spawns except on its matched tool (leaf/lean stay bare).
    // A dropped/widened matcher (session-broad hook) fails here.
    expect(pre[0]!.matcher).toBe('StructuredOutput')
    expect(post[0]!.matcher).toBe('Bash')
    const commands = [...pre, ...post].flatMap((g) => g.hooks ?? []).map((h) => h.command ?? '')
    expect(commands).toHaveLength(2)
    // Both reference the parent plugin's bin via ../bin (the guard has no copy in the shim) — a
    // rename/drop of the Path-B self-answer guard fails here.
    for (const c of commands) expect(c).toContain('../bin/wt-verifier-cli-guard-hook.mjs')
    // Prove the referenced hook file actually exists at that resolved location.
    expect(existsSync(join(REPO_ROOT, 'plugin/bin/wt-verifier-cli-guard-hook.mjs'))).toBe(true)
  })

  it('the INTERACTIVE plugin registers the verifier-CLI-guard on BOTH events, each matcher-narrowed', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
    }
    const isGuard = (g: { hooks?: Array<{ command?: string }> }): boolean =>
      (g.hooks ?? []).some((h) => (h.command ?? '').includes('wt-verifier-cli-guard-hook.mjs'))
    // PreToolUse group matcher-narrowed to StructuredOutput (leaf/lean stay bare — the hook never
    // fires except on their own StructuredOutput call). The pilot-guard group stays matcher-LESS
    // (it needs Bash) — so a distinct verifier group must carry the StructuredOutput matcher.
    const preGuard = (manifest.hooks?.['PreToolUse'] ?? []).find(isGuard)
    expect(preGuard, 'verifier-CLI-guard PreToolUse not registered in interactive plugin.json').toBeTruthy()
    expect(preGuard!.matcher).toBe('StructuredOutput')
    // PostToolUse group matcher-narrowed to Bash (writes the flush-immune CLI marker).
    const postGuard = (manifest.hooks?.['PostToolUse'] ?? []).find(isGuard)
    expect(postGuard, 'verifier-CLI-guard PostToolUse not registered in interactive plugin.json').toBeTruthy()
    expect(postGuard!.matcher).toBe('Bash')
  })
})

// launch-agents-identity.test.ts — byte-identity gate over plugin/launch-agents/.
//
// plugin/launch-agents/ is a MINIMAL agents-only plugin (no skills, hooks or
// commands) that wt-observe hands to the observe server, which loads it into
// every DELEGATED (server-launched) SDK session via the SDK `plugins` option.
// Those sessions run with `settingSources: []` (deliberately lean), so the real
// installed plugin is absent there — without this shim, `workflow-toolbox:lean`
// / `workflow-toolbox:leaf` probe "not found" and the fences always degrade
// (found live, 2026-07-13, run wf_d9938505-7b1).
//
// Two invariants, both load-bearing:
// - its plugin name must be exactly `workflow-toolbox` — agentTypes are
//   namespaced by PLUGIN NAME, and the patterns request `workflow-toolbox:*`.
//   (No collision: the launched session never also loads the real plugin.)
// - every agent definition must be a byte-identical copy of plugin/agents/*.md,
//   with no missing and no orphan files — otherwise the delegated sessions run
//   DIFFERENT agent shapes than interactive ones and every conclusion drawn on
//   one path silently stops holding on the other.
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

  it('ships NOTHING but the manifest and agents (no skills/hooks/commands leak into launched sessions)', () => {
    const root = join(REPO_ROOT, 'plugin/launch-agents')
    const entries = readdirSync(root).sort()
    expect(entries).toEqual(['.claude-plugin', 'agents'])
  })
})

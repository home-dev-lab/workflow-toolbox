// least-privilege.ts — the proven least-privilege recipe for an SDK-launched
// agent, encoded as a tiny tested builder rather than prose that drifts.
//
// `sdk-agent-probe.ts` proved (against cc 2.1.205, `pnpm canary:agents`) which
// query() levers actually enforce "use ALL and ONLY what we pass":
//   - `tools`            → the AVAILABILITY allowlist (NOT `allowedTools`, which is
//                          only the permission auto-approve list and restricts nothing).
//   - `settingSources: []`→ sheds ALL filesystem config: the ambient CLAUDE.md /
//                          rules / memory index text, plus discovered MCP, skills and
//                          agents. This is what stops a worker from reading (and then
//                          over-eagerly following) rules like "save memory after every
//                          task" / "auto-commit when green".
//   - `strictMcpConfig: true` → only the MCP servers we pass are reachable.
//   - `skills: []`       → no skill is invocable (the Skill tool rejects every name);
//                          the init enumeration still LISTS discovered skills, but that
//                          is discovery, not what the agent may run.
//
// This builder bakes those into the safe DEFAULTS (locked down: no tools, no skills,
// no MCP, no ambient context) so a caller opts capabilities IN explicitly, one lever
// at a time — the capability-DENIAL-first posture (a tool the agent lacks cannot be
// misused; an instruction telling it not to is only a backstop). It returns just the
// capability fragment; the caller merges its own launch specifics (prompt,
// permissionMode, maxTurns, timeout).
//
// BASH IS THE ESCAPE HATCH: putting 'Bash' in `tools` re-opens everything (git commit,
// arbitrary file writes, curl) — capability denial no longer contains the agent, and an
// explicit "do not commit / do not write outside X" instruction becomes load-bearing.
// Prefer scoped tools (Read/Grep/Glob/Edit) over Bash whenever the task allows.

import type { query } from '@anthropic-ai/claude-agent-sdk'

/** The query() options object, derived from the real SDK signature so a field
 *  rename in an upgrade is a typecheck error here, not a silent no-op. */
type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>

/** The capability fragment this builder owns — merge it into your launch options. */
export type LeastPrivilegeOptions = Pick<
  QueryOptions,
  'tools' | 'skills' | 'settingSources' | 'strictMcpConfig' | 'mcpServers' | 'model'
>

export interface LeastPrivilegeSpec {
  /** The ONLY tools the agent may use (availability allowlist). Omit → no tools.
   *  Mind the Bash escape hatch (see module header). */
  tools?: string[]
  /** Skills the agent may invoke. Omit → none invocable. */
  skills?: string[]
  /** MCP servers to expose, and — via strictMcpConfig — ONLY these. Omit → none. */
  mcpServers?: QueryOptions['mcpServers']
  /** Opt INTO ambient project context (CLAUDE.md / rules / memory). Omit → `[]`
   *  (shed everything). Pass e.g. `['project']` ONLY when the agent genuinely needs
   *  the project rules — doing so also re-injects the "save memory / auto-commit"
   *  rules, so pair it with a capability denial or an explicit non-goals instruction. */
  ambient?: NonNullable<QueryOptions['settingSources']>
  /** Model alias/id passthrough (omit → inherit). */
  model?: string
}

/**
 * Build the least-privilege capability fragment: locked down by default (no tools,
 * no skills, no MCP, no ambient context), each capability opted IN explicitly.
 * `strictMcpConfig` is always forced on so ambient MCP can never leak in.
 */
export function leastPrivilegeOptions(spec: LeastPrivilegeSpec = {}): LeastPrivilegeOptions {
  return {
    tools: spec.tools ?? [],
    skills: spec.skills ?? [],
    settingSources: spec.ambient ?? [],
    strictMcpConfig: true,
    ...(spec.mcpServers !== undefined ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
  }
}

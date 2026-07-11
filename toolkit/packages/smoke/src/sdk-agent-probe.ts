// sdk-agent-probe.ts — the SDK-path least-privilege capability probe.
//
// The card "Probe + provision SDK agents (least-privilege)" asks one empirical
// question: on OUR headless Agent-SDK launcher (the `query()` path we own, unlike
// the research-preview harness `agent()`), are the per-session / per-agent
// capability levers actually honored at RUNTIME — can an SDK-launched agent use
// ALL of what we pass and ONLY that (least privilege)? The harness-side answer was
// proven by probe wf_cde50091-be4 (a restricted `agentType` still received the
// full ambient CLAUDE.md/rules injection as text); the SDK side was UNPROVEN.
//
// This probe answers it with HARD, harness-emitted ground truth rather than a
// model's self-report. The SDK's `init` system message (subtype 'init') enumerates
// the EXACT surface the CLI handed the session: `tools[]`, `mcp_servers[]`,
// `skills[]`, `agents[]`, `slash_commands[]`, `cwd`, `model`. Reading that message
// tells us precisely what each lever did — no need to trust the agent to introspect
// itself. The ONE thing the init message does NOT expose is the ambient system-prompt
// TEXT (the CLAUDE.md / rules injection). The enumeration Δ already proves
// `settingSources: []` sheds the MCP/skills/agents/tools surface; the CLAUDE.md TEXT
// is the one part left to a behavioral check — a sentinel that lives only in a
// project CLAUDE.md — and that check is reliable only in its POSITIVE direction (a
// random marker cannot be guessed, so a reveal proves presence; absence is weak).
//
// It is BOTH a research probe and a regression gate: it PRINTS what each lever did
// and a PASS / ⚠ WARN / FAIL per expectation, and exits non-zero if any HARD
// expectation was violated (so a future SDK upgrade that silently changes the
// surface is caught); the one behavioral positive control is ⚠ WARN-only (a miss is
// inconclusive, not a regression). Run standalone:
//   tsx packages/smoke/src/sdk-agent-probe.ts   (from toolkit/, or `pnpm canary:agents`)
//
// Deliberately NOT part of `pnpm test` (it spends real SDK launches under the local
// subscription, exactly like `pnpm smoke` / `pnpm canary`).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { annotateAuth, isAbortError } from './lib.js'
import { leastPrivilegeOptions } from './least-privilege.js'

/** The query() options object, derived from the real SDK signature so a field
 *  rename in an upgrade is a typecheck error here, not a silent no-op. */
type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** The capability surface the CLI enumerated in the `init` system message — the
 *  hard ground truth for every lever except the ambient-text one. */
export interface Surface {
  ccVersion: string | null
  model: string | null
  cwd: string | null
  tools: string[]
  mcpServers: { name: string; status: string }[]
  skills: string[]
  agents: string[]
  slashCommands: string[]
}

export function readInitSurface(message: unknown): Surface | null {
  if (!isRecord(message) || message['type'] !== 'system' || message['subtype'] !== 'init') return null
  const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const mcp = Array.isArray(message['mcp_servers'])
    ? message['mcp_servers']
        .filter(isRecord)
        .map((m) => ({ name: String(m['name'] ?? ''), status: String(m['status'] ?? '') }))
    : []
  return {
    ccVersion: typeof message['claude_code_version'] === 'string' ? message['claude_code_version'] : null,
    model: typeof message['model'] === 'string' ? message['model'] : null,
    cwd: typeof message['cwd'] === 'string' ? message['cwd'] : null,
    tools: asStrArr(message['tools']),
    mcpServers: mcp,
    skills: asStrArr(message['skills']),
    agents: asStrArr(message['agents']),
    slashCommands: asStrArr(message['slash_commands']),
  }
}

/** The final assistant text of a completed session (SDKResultSuccess.result). */
export function readResultText(message: unknown): string | null {
  if (!isRecord(message) || message['type'] !== 'result') return null
  return typeof message['result'] === 'string' ? message['result'] : null
}

/** Permission denials the harness recorded this session (hard signal for a tool
 *  that was PRESENT but permission-denied — distinct from a tool ABSENT from the
 *  list, which shows up as a gap in `Surface.tools`). */
export function readPermissionDenials(message: unknown): { tool_name: string }[] {
  if (!isRecord(message) || message['type'] !== 'result') return []
  const d = message['permission_denials']
  return Array.isArray(d) ? d.filter(isRecord).map((x) => ({ tool_name: String(x['tool_name'] ?? '') })) : []
}

interface ProbeRun {
  surface: Surface | null
  resultText: string | null
  permissionDenials: { tool_name: string }[]
  /** tool names any subagent-tagged assistant message tried to use, with the
   *  subagent_type that produced them — the per-AgentDefinition dimension. */
  subagentToolUses: { subagentType: string; toolName: string }[]
  error: string | null
}

/** Drive ONE query() session, collecting the init surface and (when asked) the
 *  final result. `waitFor: 'init'` aborts as soon as the init message is read
 *  (the enumeration is emitted before any model turn) — cheap, no turn spent.
 *  `waitFor: 'result'` runs to the session's result message (the behavioral cases). */
async function runProbe(
  options: QueryOptions,
  prompt: string,
  waitFor: 'init' | 'result',
  timeoutMs: number,
): Promise<ProbeRun> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const run: ProbeRun = { surface: null, resultText: null, permissionDenials: [], subagentToolUses: [], error: null }
  const q = query({ prompt, options: { ...options, abortController: controller } })
  try {
    for await (const message of q) {
      if (run.surface === null) {
        const s = readInitSurface(message)
        if (s !== null) {
          run.surface = s
          if (waitFor === 'init') break
        }
      }
      // Collect subagent-attributed tool_use (per-AgentDefinition dimension).
      if (isRecord(message) && message['type'] === 'assistant' && typeof message['subagent_type'] === 'string') {
        const inner = isRecord(message['message']) ? message['message'] : null
        const content = inner && Array.isArray(inner['content']) ? inner['content'] : []
        for (const block of content) {
          if (isRecord(block) && block['type'] === 'tool_use' && typeof block['name'] === 'string') {
            run.subagentToolUses.push({ subagentType: message['subagent_type'], toolName: block['name'] })
          }
        }
      }
      const text = readResultText(message)
      if (text !== null) {
        run.resultText = text
        run.permissionDenials = readPermissionDenials(message)
        break
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      // For init-only cases an abort AFTER reading init is the normal stop path.
      if (!(waitFor === 'init' && run.surface !== null)) run.error = `timed out after ${timeoutMs} ms`
    } else {
      run.error = (err as Error).message
    }
  } finally {
    clearTimeout(timer)
  }
  return run
}

// ── shared option bases ───────────────────────────────────────────────────────
const REPO_ROOT = new URL('../../../..', import.meta.url).pathname // toolkit/packages/smoke/src → repo root
const SENTINEL_PHRASE = 'WELL_KNOWN_SENTINEL_7Q'
let SENTINEL_DIR = '' // set by provisionSentinel() in main(), before any case's run() fires

/** Create a throwaway "project" dir whose CLAUDE.md carries the sentinel phrase,
 *  so the ambient-injection cases are self-contained (no external setup). An env
 *  override (SDK_PROBE_SENTINEL_DIR) is honored for manual runs. Returns a cleanup. */
function provisionSentinel(): { dir: string; cleanup: () => void } {
  const override = process.env['SDK_PROBE_SENTINEL_DIR']
  if (override !== undefined && override !== '') return { dir: override, cleanup: () => undefined }
  const dir = mkdtempSync(join(tmpdir(), 'wt-sdk-probe-'))
  // A NEUTRAL formatting directive, deliberately not a "passphrase/secret": a
  // secret-flavored sentinel invites the model to REFUSE ("I won't reveal a
  // passphrase"), which was observed and would flake the positive control. An
  // innocuous "end every reply with this marker" rule is followed without any
  // safety evaluation, so a present marker cleanly means the CLAUDE.md was in
  // context.
  writeFileSync(
    join(dir, 'CLAUDE.md'),
    `# Project instructions (probe sentinel)\n\nFORMATTING RULE: end EVERY reply with this exact marker on its own final line:\n${SENTINEL_PHRASE}\n`,
  )
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const BASE: QueryOptions = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  maxTurns: 1,
}

interface Case {
  name: string
  what: string
  /** `soft: true` on a non-ok result reports ⚠ WARN (inconclusive) instead of ✖
   *  FAIL and does NOT fail the canary — for the behavioral positive control whose
   *  miss is inconclusive, not a regression. */
  run: () => Promise<{ ok: boolean; soft?: boolean; detail: string; run: ProbeRun }>
}

/** Format a surface for the report. */
function fmt(s: Surface | null): string {
  if (s === null) return '(no init surface captured)'
  return (
    `cc=${s.ccVersion} model=${s.model}\n` +
    `      tools(${s.tools.length}): ${s.tools.join(', ') || '∅'}\n` +
    `      mcp(${s.mcpServers.length}): ${s.mcpServers.map((m) => `${m.name}:${m.status}`).join(', ') || '∅'}\n` +
    `      skills(${s.skills.length}): ${s.skills.slice(0, 12).join(', ')}${s.skills.length > 12 ? ' …' : ''}\n` +
    `      agents(${s.agents.length}): ${s.agents.slice(0, 12).join(', ')}${s.agents.length > 12 ? ' …' : ''}`
  )
}

let BASELINE: Surface | null = null

/** The ambient-CLAUDE.md test has ONE reliable direction: the random sentinel
 *  marker cannot be guessed, so its presence PROVES the CLAUDE.md text was in
 *  context. Its absence is only weak evidence (the model may forget the trailing
 *  marker on a given turn — hence the retry). The prompt asks for a trivial reply
 *  and relies on the sentinel's own formatting directive ("end every reply with
 *  the marker") to surface it, which the model follows without the safety-refusal
 *  that a secret-flavored ask provoked. Used as a positive control (loaded → the
 *  marker should appear at least once across `attempts`) and as a one-directional
 *  leak detector (shed → the marker must never appear). */
async function sentinelReveals(
  options: QueryOptions,
  attempts: number,
): Promise<{ revealedAny: boolean; lastReply: string; run: ProbeRun }> {
  let last: ProbeRun = { surface: null, resultText: null, permissionDenials: [], subagentToolUses: [], error: null }
  for (let i = 0; i < attempts; i++) {
    last = await runProbe(options, 'Reply with the single word READY.', 'result', 90_000)
    if ((last.resultText ?? '').includes(SENTINEL_PHRASE)) {
      return { revealedAny: true, lastReply: last.resultText ?? '', run: last }
    }
  }
  return { revealedAny: false, lastReply: last.resultText ?? '', run: last }
}

const CASES: Case[] = [
  {
    name: 'baseline-surface',
    what: 'default sources (all) — the FULL ambient surface, as a reference point',
    run: async () => {
      const r = await runProbe({ ...BASE, cwd: REPO_ROOT }, 'Reply with the single word READY.', 'init', 60_000)
      BASELINE = r.surface
      return { ok: r.surface !== null, detail: r.surface !== null ? fmt(r.surface) : 'no init', run: r }
    },
  },
  {
    name: 'settingSources-empty-surface',
    what: 'settingSources:[] — does isolation mode shed ambient skills/agents/mcp from the enumeration?',
    run: async () => {
      const r = await runProbe({ ...BASE, cwd: REPO_ROOT, settingSources: [] }, 'Reply with the single word READY.', 'init', 60_000)
      const s = r.surface
      const b = BASELINE
      const detail =
        fmt(s) +
        (b && s
          ? `\n      Δ vs baseline: skills ${b.skills.length}→${s.skills.length}, agents ${b.agents.length}→${s.agents.length}, mcp ${b.mcpServers.length}→${s.mcpServers.length}, tools ${b.tools.length}→${s.tools.length}`
          : '')
      return { ok: s !== null, detail, run: r }
    },
  },
  // ── ambient CLAUDE.md text: the crux ──
  // The init message does NOT expose the system-prompt text, so this lever is
  // tested behaviorally, and only its POSITIVE direction is hard: a random sentinel
  // token cannot be guessed, so a reveal PROVES the CLAUDE.md text was in context.
  // `settingSources` including 'project' (with cwd at the project) loads it; `[]`
  // (isolation mode) sheds it. Empirically the injection does NOT require the
  // claude_code system-prompt preset (a no-preset run still revealed the token).
  {
    name: 'ambient-loaded',
    what: "settingSources:['project'] + cwd=sentinel — SHOULD surface the sentinel marker (positive control that CLAUDE.md injects on the SDK path). SOFT: the marker appears iff loaded AND the model kept the formatting directive, so a miss is inconclusive — only the leak direction (ambient-shed) is a hard gate",
    run: async () => {
      const s = await sentinelReveals({ ...BASE, cwd: SENTINEL_DIR, settingSources: ['project'], maxTurns: 2 }, 3)
      return { ok: s.revealedAny, soft: !s.revealedAny, detail: `marker surfaced? ${s.revealedAny ? 'yes — CLAUDE.md injected' : 'no (inconclusive: not loaded, or the model dropped the marker)'} — reply: ${JSON.stringify(s.lastReply.slice(0, 80))}`, run: s.run }
    },
  },
  {
    name: 'ambient-shed',
    what: 'settingSources:[] + cwd=sentinel — MUST NOT reveal the sentinel (leak detector; one-directional — a reveal is a hard leak, a NONE is consistent with the ambient text being shed)',
    run: async () => {
      const s = await sentinelReveals({ ...BASE, cwd: SENTINEL_DIR, settingSources: [], maxTurns: 2 }, 2)
      return { ok: !s.revealedAny, detail: `revealed sentinel? ${s.revealedAny ? 'YES (leak!)' : 'no'} — reply: ${JSON.stringify(s.lastReply.slice(0, 80))}`, run: s.run }
    },
  },
  {
    name: 'tools-allowlist',
    what: "tools:['Read','Glob'] — init tools[] MUST be a subset of the allowlist (the `tools` option restricts availability; `allowedTools` does NOT — it is the permission auto-approve list)",
    run: async () => {
      const allow = ['Read', 'Glob']
      const r = await runProbe({ ...BASE, cwd: REPO_ROOT, settingSources: [], tools: allow }, 'Reply READY.', 'init', 60_000)
      const tools = r.surface?.tools ?? []
      const extra = tools.filter((t) => !allow.includes(t))
      const ok = r.surface !== null && extra.length === 0 && !tools.includes('Bash')
      return { ok, detail: `tools=${tools.join(',') || '∅'} ${extra.length ? `(NOT in allowlist: ${extra.join(',')})` : '(all within allowlist)'}`, run: r }
    },
  },
  {
    name: 'tools-denylist',
    what: "disallowedTools:['Bash'] — 'Bash' MUST be absent from init tools[]",
    run: async () => {
      const r = await runProbe({ ...BASE, cwd: REPO_ROOT, disallowedTools: ['Bash'] }, 'Reply READY.', 'init', 60_000)
      const tools = r.surface?.tools ?? []
      const ok = r.surface !== null && !tools.includes('Bash')
      return { ok, detail: `Bash present? ${tools.includes('Bash') ? 'YES (denylist ignored!)' : 'no'} — tools(${tools.length})`, run: r }
    },
  },
  {
    name: 'skills-enumeration-is-discovery',
    what: "skills:['playwright-cli'] on default sources — init skills[] is UNCHANGED (it lists DISCOVERED skills, gated by settingSources; the `skills` option is a runtime enable/context filter that does NOT alter this enumeration — its invocation-gating must be checked behaviorally, not from the init surface)",
    run: async () => {
      const r = await runProbe({ ...BASE, cwd: REPO_ROOT, skills: ['playwright-cli'] }, 'Reply READY.', 'init', 60_000)
      const skills = r.surface?.skills ?? []
      const base = BASELINE?.skills.length ?? -1
      const ok = r.surface !== null && skills.length === base
      return { ok, detail: `skills(${skills.length}) == baseline(${base})? ${skills.length === base ? 'yes — enumeration = discovery, independent of the enable-filter' : 'NO — enumeration changed'}`, run: r }
    },
  },
  {
    name: 'mcp-strict',
    what: 'strictMcpConfig:true on DEFAULT sources, no mcpServers — init mcp_servers[] MUST be empty (strictMcpConfig alone sheds all ambient MCP even while filesystem settings load)',
    run: async () => {
      const r = await runProbe({ ...BASE, cwd: REPO_ROOT, strictMcpConfig: true }, 'Reply READY.', 'init', 60_000)
      const mcp = r.surface?.mcpServers ?? []
      const ok = r.surface !== null && mcp.length === 0
      return { ok, detail: `mcp(${mcp.length}): ${mcp.map((m) => m.name).join(', ') || '∅'}`, run: r }
    },
  },
  {
    name: 'least-privilege-recipe',
    what: "leastPrivilegeOptions({ tools:['Read','Glob'] }) — the composed Step-2 recipe MUST yield init tools[] = exactly that set AND mcp_servers[] empty (the builder's safe defaults, exercised end-to-end so it is a real consumer, not a speculative API)",
    run: async () => {
      const lp = leastPrivilegeOptions({ tools: ['Read', 'Glob'] })
      const r = await runProbe({ ...BASE, cwd: REPO_ROOT, ...lp }, 'Reply READY.', 'init', 60_000)
      const tools = r.surface?.tools ?? []
      const mcp = r.surface?.mcpServers ?? []
      const toolsOk = tools.length === 2 && tools.includes('Read') && tools.includes('Glob')
      const ok = r.surface !== null && toolsOk && mcp.length === 0
      return { ok, detail: `tools=${tools.join(',') || '∅'} | mcp(${mcp.length}) → ${toolsOk && mcp.length === 0 ? 'locked down as specified' : 'UNEXPECTED surface'}`, run: r }
    },
  },
  {
    name: 'agentdef-tools-fence',
    what: "options.agent='probe' with agents.probe.tools:['Read','Glob'] — running the session AS a restricted AgentDefinition MUST yield init tools[] = exactly that allowlist (the per-AgentDefinition `tools` fence honored at runtime, hard signal via the init enumeration — not just the session-level Options tested above)",
    run: async () => {
      const agents = {
        probe: {
          description: 'A least-privilege probe agent.',
          prompt: 'You are a capability probe.',
          tools: ['Read', 'Glob'],
          disallowedTools: ['Bash'],
        },
      }
      const r = await runProbe({ ...BASE, cwd: REPO_ROOT, settingSources: [], agent: 'probe', agents }, 'Reply READY.', 'init', 60_000)
      const tools = r.surface?.tools ?? []
      const extra = tools.filter((t) => !['Read', 'Glob'].includes(t))
      const ok = r.surface !== null && extra.length === 0 && !tools.includes('Bash')
      return { ok, detail: `AgentDefinition.tools → init tools=${tools.join(',') || '∅'} ${extra.length ? `(NOT in the agent's allowlist: ${extra.join(',')})` : "(fence honored — exactly the agent's allowlist)"}`, run: r }
    },
  },
]

async function main(): Promise<number> {
  const sentinel = provisionSentinel()
  SENTINEL_DIR = sentinel.dir
  console.log('── SDK-path least-privilege capability probe ──')
  console.log(`repo root: ${REPO_ROOT}`)
  console.log(`sentinel : ${SENTINEL_DIR}\n`)
  let failures = 0
  let warns = 0
  try {
    for (const c of CASES) {
      process.stdout.write(`▶ ${c.name}\n  ${c.what}\n`)
      let res: Awaited<ReturnType<Case['run']>>
      try {
        res = await c.run()
      } catch (err) {
        failures++
        console.log(`  ✖ ERROR: ${annotateAuth(err).message}\n`)
        continue
      }
      if (res.run.error) console.log(`  ⚠ run note: ${res.run.error}`)
      const verdict = res.ok ? '✔ PASS' : res.soft === true ? '⚠ WARN' : '✖ FAIL'
      console.log(`  ${verdict} — ${res.detail}`)
      if (res.run.subagentToolUses.length) {
        console.log(`  subagent tool_use: ${res.run.subagentToolUses.map((u) => `${u.subagentType}:${u.toolName}`).join(', ')}`)
      }
      if (res.run.permissionDenials.length) {
        console.log(`  permission_denials: ${res.run.permissionDenials.map((d) => d.tool_name).join(', ')}`)
      }
      console.log('')
      if (!res.ok) {
        if (res.soft === true) warns++
        else failures++
      }
    }
  } finally {
    sentinel.cleanup()
  }
  console.log(`── SUMMARY: ${CASES.length - failures - warns}/${CASES.length} passed, ${warns} warn, ${failures} failed ──`)
  return failures === 0 ? 0 : 1
}

// Run main() only when executed directly (`pnpm canary:agents`), not when the
// test imports the pure readers from this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(annotateAuth(err).message)
      process.exit(2)
    },
  )
}

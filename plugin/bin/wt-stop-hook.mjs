#!/usr/bin/env node

// packages/debugger/src/source.ts
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

// packages/debugger/src/journal.ts
function parseJournal(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data;
  if (typeof obj["runId"] !== "string") return null;
  return obj;
}
function agentEvents(j) {
  return (j.workflowProgress ?? []).filter(
    (e) => !!e && e.type === "workflow_agent"
  );
}
function doneAgents(j) {
  return agentEvents(j).filter((a) => a.state === "done");
}
function incompleteAgents(j) {
  return agentEvents(j).filter((a) => a.state !== "done");
}
function retriedAgents(j) {
  return agentEvents(j).filter((a) => (a.attempt ?? 1) > 1);
}

// packages/debugger/src/source.ts
var isJournalFile = (name) => /^wf_.*\.json$/.test(name);
var MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
function transcriptDirFor(journalPath, runId) {
  return join(journalPath, "..", "..", "subagents", "workflows", runId);
}
function projectsBase(home) {
  return join(home, ".claude", "projects");
}
function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
function listJournals(projectDir) {
  const out = [];
  for (const session of listDirs(projectDir)) {
    const wfDir = join(projectDir, session, "workflows");
    let names;
    try {
      names = readdirSync(wfDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (isJournalFile(name)) out.push({ path: join(wfDir, name), sessionId: session });
    }
  }
  return out;
}
function readResolved(entry) {
  let text;
  try {
    if (statSync(entry.path).size > MAX_JOURNAL_BYTES) return null;
    text = readFileSync(entry.path, "utf8");
  } catch {
    return null;
  }
  return {
    path: entry.path,
    text,
    sessionId: entry.sessionId,
    runId: basename(entry.path).replace(/\.json$/, "")
  };
}
function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
function findJournalByTaskId(taskId, opts = {}) {
  const home = opts.home ?? homedir();
  const base = projectsBase(home);
  const cwd = opts.cwd ?? process.cwd();
  const projectDir = opts.project ? join(base, opts.project) : join(base, projectSlug(cwd));
  let best = null;
  let bestMtime = -1;
  for (const entry of listJournals(projectDir)) {
    const resolved = readResolved(entry);
    if (!resolved) continue;
    const journal = parseJournal(resolved.text);
    if (!journal || journal.taskId !== taskId) continue;
    const m = mtimeMs(entry.path);
    if (m > bestMtime) {
      best = resolved;
      bestMtime = m;
    }
  }
  return best;
}

// packages/debugger/src/diagnose.ts
var BUDGET_HINT = /budget|token target|\bfloor\b|remaining|exhaust/i;
var SCHEMA_THROW_HINT = /without calling StructuredOutput/i;
function diagnoseRun(j) {
  const done = doneAgents(j);
  const incomplete = incompleteAgents(j);
  const retried = retriedAgents(j);
  const status = j.status;
  const isCompleted = status === "completed";
  const isFailed = status === "failed";
  const isLaunchFail = status === "async_launched";
  const findings = [];
  for (const a of incomplete) {
    findings.push({
      kind: "dead-agent",
      detail: `agent "${a.label ?? a.agentId ?? "?"}" ended in state "${a.state ?? "?"}" (expected "done")`
    });
  }
  for (const a of retried) {
    findings.push({
      kind: "schema-retry",
      detail: `agent "${a.label ?? a.agentId ?? "?"}" needed ${a.attempt} attempts (StructuredOutput schema retries)`
    });
  }
  let mode;
  let headline;
  if (isCompleted) {
    if (incomplete.length > 0) {
      mode = "agent-died";
      headline = `Run completed but ${incomplete.length} agent(s) did not \u2014 partial result.`;
    } else if (retried.length > 0) {
      mode = "schema-retries";
      headline = `Run completed; ${retried.length} agent(s) needed schema retries \u2014 wasted latency/tokens.`;
    } else {
      mode = "completed-ok";
      headline = "Run completed cleanly \u2014 no dead agents, no retries.";
    }
  } else if (isFailed || isLaunchFail) {
    if (isLaunchFail) {
      findings.push({
        kind: "launch-failure",
        detail: 'status "async_launched" \u2014 the script failed its pre-run syntax/meta check and never executed (no agents ran).'
      });
    }
    if (j.error && BUDGET_HINT.test(j.error)) {
      findings.push({
        kind: "budget-hint",
        detail: "error text may indicate budget-floor exhaustion; if so, resume with a higher (or no) token target."
      });
    }
    if (j.error && SCHEMA_THROW_HINT.test(j.error)) {
      findings.push({
        kind: "schema-hint",
        detail: "an agent({schema}) call threw because the subagent never produced a valid StructuredOutput \u2014 usually an unsatisfiable or over-strict schema. The journal records that agent as done/attempt:1, so its cache holds no usable result: fix the schema and re-run rather than resuming."
      });
    }
    if (incomplete.length > 0) {
      mode = "agent-died";
      headline = `Run failed with ${incomplete.length} incomplete agent(s) \u2014 the throw is likely a symptom of the dead agent.`;
    } else {
      mode = "script-throw";
      headline = isLaunchFail ? `Run never executed \u2014 ${firstErrorLine(j.error)}` : `Run threw before completing \u2014 ${firstErrorLine(j.error)}`;
    }
  } else {
    mode = "in-progress";
    headline = "Run has no terminal status \u2014 still active, aborted, or a zombie.";
    findings.push({
      kind: "zombie-hint",
      detail: "no terminal status recorded \u2014 the run may still be active, or a zombie (a dead agent the web UI still lists as running). Check the web UI before resuming."
    });
  }
  return {
    mode,
    headline,
    findings,
    resume: recommendResume(mode, done.length, isLaunchFail),
    stats: {
      runId: j.runId,
      status: status ?? "(none)",
      workflowName: j.workflowName ?? "(unknown)",
      agentCount: j.agentCount ?? 0,
      doneAgents: done.length,
      incompleteAgents: incomplete.length,
      retriedAgents: retried.length,
      totalTokens: j.totalTokens ?? 0,
      totalToolCalls: j.totalToolCalls ?? 0,
      durationMs: j.durationMs ?? 0
    }
  };
}
var SAME_SESSION = " This only replays cached agents IN THE SESSION that produced the run; read off disk in a different session, the cache is gone and everything re-runs \u2014 prefer fixing and re-running.";
function recommendResume(mode, doneCount, isLaunchFail) {
  switch (mode) {
    case "agent-died":
      return {
        recommended: true,
        sameSessionOnly: true,
        rationale: `${doneCount} agent(s) completed and are cached; resumeFromRunId replays them and only the incomplete agent(s) re-run.${SAME_SESSION}`
      };
    case "script-throw":
      if (isLaunchFail || doneCount === 0) {
        return {
          recommended: false,
          sameSessionOnly: false,
          rationale: "nothing ran before the failure \u2014 no cached agents to replay. Fix the script/args and run fresh; resumeFromRunId would save no work."
        };
      }
      return {
        recommended: true,
        sameSessionOnly: true,
        rationale: `fix the script first, then resumeFromRunId replays the ${doneCount} cached agent(s) and the failing call onward re-runs.${SAME_SESSION}`
      };
    case "schema-retries":
    case "completed-ok":
      return {
        recommended: false,
        sameSessionOnly: false,
        rationale: "the run completed \u2014 nothing to resume."
      };
    case "in-progress":
      return {
        recommended: false,
        sameSessionOnly: false,
        rationale: "the run has no terminal status \u2014 do not resume a live run; wait for it to finish, or if it is a zombie, start fresh."
      };
  }
}
function firstErrorLine(error) {
  if (!error) return "no error text recorded.";
  const line = error.split("\n")[0]?.trim() ?? "";
  return line.length > 0 ? line : "no error text recorded.";
}

// packages/std/src/narrow.ts
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull(v) {
  return typeof v === "string" ? v : null;
}

// packages/debugger/src/transcript-usage.ts
function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}
function isNonEmptyUsage(u) {
  return u.inputTokens > 0 || u.outputTokens > 0 || u.cacheReadTokens > 0 || u.cacheCreationTokens > 0;
}
function addUsage(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens
  };
}
function readUsage(usage) {
  return {
    inputTokens: numOrNull(usage["input_tokens"]) ?? 0,
    outputTokens: numOrNull(usage["output_tokens"]) ?? 0,
    cacheReadTokens: numOrNull(usage["cache_read_input_tokens"]) ?? 0,
    cacheCreationTokens: numOrNull(usage["cache_creation_input_tokens"]) ?? 0
  };
}
function parseTranscriptUsage(jsonl) {
  const finals = /* @__PURE__ */ new Map();
  let synthetic = 0;
  for (const raw of jsonl.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed["type"] !== "assistant") continue;
    const message = parsed["message"];
    if (!isRecord(message)) continue;
    const usage = message["usage"];
    if (!isRecord(usage)) continue;
    const key = strOrNull(message["id"]) ?? `\0synthetic-${synthetic++}`;
    const current = readUsage(usage);
    const prior = finals.get(key);
    if (prior === void 0 || current.outputTokens >= prior.outputTokens) finals.set(key, current);
  }
  let total = emptyUsage();
  for (const u of finals.values()) total = addUsage(total, u);
  return total;
}

// packages/debugger/src/report.ts
function readEnvelopeTrail(result) {
  const map = /* @__PURE__ */ new Map();
  if (!isRecord(result)) return map;
  const envelope = result["envelope"];
  if (!isRecord(envelope)) return map;
  const trail = envelope["trail"];
  if (!Array.isArray(trail)) return map;
  for (const entry of trail) {
    if (!isRecord(entry)) continue;
    const stage = strOrNull(entry["stage"]);
    if (stage === null) continue;
    map.set(stage, { outcome: strOrNull(entry["outcome"]), decision: strOrNull(entry["decision"]) });
  }
  return map;
}
function buildAuditReport(journal, opts = {}) {
  const present = opts.presentTranscripts ?? /* @__PURE__ */ new Set();
  const usageByAgent = opts.usageByAgent;
  const events = agentEvents(journal);
  const trail = readEnvelopeTrail(journal.result);
  const agents = events.map((a) => {
    const agentId = strOrNull(a.agentId);
    return {
      label: strOrNull(a.label) ?? "(unlabeled)",
      agentId,
      model: strOrNull(a.model),
      tokens: numOrNull(a.tokens),
      toolCalls: numOrNull(a.toolCalls),
      phaseTitle: strOrNull(a.phaseTitle),
      state: strOrNull(a.state),
      usage: agentId !== null && usageByAgent ? usageByAgent.get(agentId) ?? null : null
    };
  });
  let tokenBreakdown = null;
  if (usageByAgent && usageByAgent.size > 0) {
    const identifiableIds = new Set(
      agents.map((a) => a.agentId).filter((id) => id !== null)
    );
    let totals = emptyUsage();
    let coveredAgents = 0;
    for (const id of identifiableIds) {
      const u = usageByAgent.get(id);
      if (u) {
        totals = addUsage(totals, u);
        coveredAgents++;
      }
    }
    if (coveredAgents > 0) tokenBreakdown = { totals, coveredAgents, totalAgents: identifiableIds.size };
  }
  const decisions = agents.map((a) => {
    const enr = trail.get(a.label);
    return {
      stage: a.label,
      // Merge precedence: a trail outcome wins; when the trail says nothing (no entry,
      // or an entry without an `outcome` string) we derive it from the agent state —
      // "ok" for a done agent is more informative than a deliberately-null trail outcome.
      outcome: enr?.outcome ?? (a.state === "done" ? "ok" : a.state),
      decision: enr?.decision ?? null,
      phaseTitle: a.phaseTitle
    };
  });
  const tokensWithValue = agents.filter((a) => a.tokens !== null);
  const perAgentSum = tokensWithValue.reduce((sum, a) => sum + (a.tokens ?? 0), 0);
  const totalTokens = numOrNull(journal.totalTokens);
  const missingTokenAgents = agents.length - tokensWithValue.length;
  const reconciliation = {
    perAgentSum,
    totalTokens,
    reconciles: totalTokens !== null && missingTokenAgents === 0 && perAgentSum === totalTokens,
    delta: totalTokens !== null ? totalTokens - perAgentSum : null,
    missingTokenAgents
  };
  const transcripts = agents.filter((a) => a.agentId !== null).map((a) => ({
    agentId: a.agentId,
    relativePath: `transcripts/agent-${a.agentId}.jsonl`,
    present: present.has(a.agentId)
  }));
  return {
    runId: journal.runId,
    taskId: strOrNull(journal.taskId),
    workflowName: strOrNull(journal.workflowName),
    status: strOrNull(journal.status),
    durationMs: numOrNull(journal.durationMs),
    defaultModel: strOrNull(journal.defaultModel),
    agentCount: agents.length,
    totalTokens,
    totalToolCalls: numOrNull(journal.totalToolCalls),
    agents,
    reconciliation,
    decisions,
    transcripts,
    tokenBreakdown
  };
}

// packages/debugger/src/report-format.ts
function num(n) {
  return n === null ? "\u2014" : n.toLocaleString("en-US");
}
function cell(s) {
  return s === null || s === "" ? "\u2014" : s;
}
function usageCell(u, key) {
  return u === null || u === void 0 ? "\u2014" : num(u[key]);
}
function formatAuditReportMarkdown(r, ctx = {}) {
  const lines = [];
  lines.push(`# Workflow Audit Report \u2014 ${cell(r.workflowName)}`);
  lines.push("");
  lines.push(`- **Run ID:** ${r.runId}`);
  lines.push(`- **Task ID:** ${cell(r.taskId)}`);
  lines.push(`- **Status:** ${cell(r.status)}`);
  lines.push(`- **Duration:** ${num(r.durationMs)} ms`);
  lines.push(`- **Default model:** ${cell(r.defaultModel)}`);
  lines.push(`- **Agents:** ${r.agentCount}`);
  lines.push(`- **Total tokens:** ${num(r.totalTokens)}`);
  lines.push(`- **Total tool calls:** ${num(r.totalToolCalls)}`);
  if (ctx.generatedAt !== void 0) lines.push(`- **Generated:** ${ctx.generatedAt}`);
  if (ctx.journalPath !== void 0) lines.push(`- **Journal:** ${ctx.journalPath}`);
  lines.push("");
  lines.push("## Cost by agent");
  lines.push("");
  if (r.agents.length === 0) {
    lines.push("_No agent activity recorded for this run._");
  } else {
    lines.push("| Stage | Model | Tokens | Tool calls | Phase |");
    lines.push("|-------|-------|-------:|-----------:|-------|");
    for (const a of r.agents) {
      lines.push(`| ${cell(a.label)} | ${cell(a.model)} | ${num(a.tokens)} | ${num(a.toolCalls)} | ${cell(a.phaseTitle)} |`);
    }
  }
  lines.push("");
  const rec = r.reconciliation;
  if (rec.reconciles) {
    lines.push(`**Token reconciliation:** \u03A3 per-agent ${num(rec.perAgentSum)} = total ${num(rec.totalTokens)} \u2713`);
  } else {
    const parts = [`\u26A0 **Token reconciliation: does not reconcile** \u2014 \u03A3 per-agent ${num(rec.perAgentSum)} vs total ${num(rec.totalTokens)}`];
    if (rec.delta !== null) parts.push(`(delta ${num(rec.delta)})`);
    if (rec.missingTokenAgents > 0) parts.push(`; ${rec.missingTokenAgents} agent(s) missing token data`);
    lines.push(parts.join(" "));
  }
  lines.push("");
  lines.push("## Token usage by agent (from transcripts)");
  lines.push("");
  const tb = r.tokenBreakdown;
  if (tb === null || tb === void 0) {
    lines.push("_No transcript token usage available (transcripts not captured or pruned)._");
  } else {
    lines.push("| Stage | Input | Output | Cache read | Cache write |");
    lines.push("|-------|------:|-------:|-----------:|------------:|");
    for (const a of r.agents) {
      lines.push(
        `| ${cell(a.label)} | ${usageCell(a.usage, "inputTokens")} | ${usageCell(a.usage, "outputTokens")} | ${usageCell(a.usage, "cacheReadTokens")} | ${usageCell(a.usage, "cacheCreationTokens")} |`
      );
    }
    lines.push("");
    lines.push(
      `**Totals (from ${tb.coveredAgents} of ${tb.totalAgents} transcripts):** input ${num(tb.totals.inputTokens)} \xB7 output ${num(tb.totals.outputTokens)} \xB7 cache-read ${num(tb.totals.cacheReadTokens)} \xB7 cache-write ${num(tb.totals.cacheCreationTokens)}`
    );
    lines.push("");
    lines.push(
      "_These are per-turn billed tokens summed across each agent's tool-use turns \u2014 a different measure from the journal `Tokens` column above (not reconciled). Cache figures dwarf it because every turn re-bills its cached context._"
    );
  }
  lines.push("");
  lines.push("## Decisions");
  lines.push("");
  if (r.decisions.length === 0) {
    lines.push("_No structured decision trail recorded for this run._");
  } else {
    lines.push("| Stage | Outcome | Decision | Phase |");
    lines.push("|-------|---------|----------|-------|");
    for (const d of r.decisions) {
      lines.push(`| ${cell(d.stage)} | ${cell(d.outcome)} | ${cell(d.decision)} | ${cell(d.phaseTitle)} |`);
    }
  }
  lines.push("");
  lines.push("## Transcripts");
  lines.push("");
  if (r.transcripts.length === 0) {
    lines.push("_No transcripts available (none captured, or pruned by the >30-day cleanup)._");
  } else {
    for (const t of r.transcripts) {
      lines.push(
        t.present ? `- \u2713 ${t.relativePath}` : `- \u2717 ${t.relativePath} \u2014 not captured (may have been pruned by the >30-day cleanup)`
      );
    }
  }
  return lines.join("\n") + "\n";
}

// packages/debugger/src/audit-folder.ts
import { mkdirSync, writeFileSync, copyFileSync, statSync as statSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function resolveLogDir(env, outFlag) {
  if (outFlag !== void 0 && outFlag.trim() !== "") return { baseDir: outFlag, source: "flag" };
  const envDir = env["DWT_WORKFLOW_LOG_DIR"];
  if (typeof envDir === "string" && envDir.trim() !== "") return { baseDir: envDir, source: "env" };
  return null;
}
function scanTranscripts(transcriptDir, agentIds, opts = {}) {
  const presentTranscripts = /* @__PURE__ */ new Set();
  const transcriptSources = [];
  const usageByAgent = /* @__PURE__ */ new Map();
  for (const agentId of agentIds) {
    const sourcePath = join2(transcriptDir, `agent-${agentId}.jsonl`);
    if (opts.withUsage) {
      let text;
      try {
        text = readFileSync2(sourcePath, "utf8");
      } catch {
        continue;
      }
      presentTranscripts.add(agentId);
      transcriptSources.push({ agentId, sourcePath });
      const usage = parseTranscriptUsage(text);
      if (isNonEmptyUsage(usage)) usageByAgent.set(agentId, usage);
    } else {
      try {
        if (statSync2(sourcePath).isFile()) {
          presentTranscripts.add(agentId);
          transcriptSources.push({ agentId, sourcePath });
        }
      } catch {
      }
    }
  }
  return { presentTranscripts, transcriptSources, usageByAgent };
}
function writeAuditFolder(args) {
  const dir = join2(args.baseDir, args.runId);
  try {
    mkdirSync(dir, { recursive: true });
    const files = [];
    writeFileSync(join2(dir, "report.md"), args.markdown, "utf8");
    files.push("report.md");
    writeFileSync(join2(dir, "journal.json"), args.journalText, "utf8");
    files.push("journal.json");
    if (args.transcriptSources.length > 0) {
      const tdir = join2(dir, "transcripts");
      mkdirSync(tdir, { recursive: true });
      for (const t of args.transcriptSources) {
        const rel = `transcripts/agent-${t.agentId}.jsonl`;
        try {
          copyFileSync(t.sourcePath, join2(dir, rel));
          files.push(rel);
        } catch {
        }
      }
    }
    return { written: true, dir, files };
  } catch (err) {
    return { written: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// packages/debugger/src/stop-detect.ts
function isTerminalStatus(status) {
  return status === "completed" || status === "failed";
}
function parseStopPayload(input) {
  if (!isRecord(input)) {
    return { sessionId: null, cwd: null, stopHookActive: false, workflows: [] };
  }
  const raw = input["background_tasks"];
  const workflows = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      if (entry["type"] !== "workflow") continue;
      const id = strOrNull(entry["id"]);
      if (id === null) continue;
      workflows.push({ id, status: strOrNull(entry["status"]), name: strOrNull(entry["name"]) });
    }
  }
  return {
    sessionId: strOrNull(input["session_id"]),
    cwd: strOrNull(input["cwd"]),
    stopHookActive: input["stop_hook_active"] === true,
    workflows
  };
}
function unique(ids) {
  return [...new Set(ids)];
}
function planStopActions(prevPending, tasks) {
  const running = unique(tasks.filter((t) => !isTerminalStatus(t.status)).map((t) => t.id));
  const terminal = unique(tasks.filter((t) => isTerminalStatus(t.status)).map((t) => t.id));
  const disappeared = prevPending.filter((id) => !running.includes(id));
  return { toResolve: unique([...disappeared, ...terminal]), running };
}

// packages/debugger/src/stop-surface.ts
function isTrouble(mode) {
  return mode === "agent-died" || mode === "script-throw" || mode === "schema-retries";
}
function decideSurface(diagnosis, tries, max = 3) {
  if (diagnosis !== null && diagnosis.mode !== "in-progress") {
    return { surface: "full", block: isTrouble(diagnosis.mode), conclusive: true };
  }
  return { surface: tries <= 1 ? "provisional" : "none", block: false, conclusive: tries >= max };
}
function tok(n) {
  return n === null ? "\u2014" : n.toLocaleString("en-US");
}
function cell2(s) {
  return s === null || s === "" ? "\u2014" : s;
}
function buildFullSurface(input) {
  const { runId, report, diagnosis, diskDir } = input;
  const block = isTrouble(diagnosis.mode);
  const notice = `DWT audit \xB7 ${runId} (${cell2(report.workflowName)}) ${cell2(report.status)} \xB7 ${report.agentCount} agents \xB7 ${tok(report.totalTokens)} tok \xB7 ${report.decisions.length} decisions \u2192 pnpm wt:report ${runId}` + (diskDir !== null ? ` \xB7 written to ${diskDir}` : "");
  if (!block) return { systemMessage: notice, block: false, reason: "" };
  const recon = report.reconciliation;
  const reconNote = recon.reconciles ? "reconciled" : `UNRECONCILED (\u0394 ${recon.delta === null ? "\u2014" : recon.delta.toLocaleString("en-US")}, ${recon.missingTokenAgents} agent(s) missing tokens)`;
  const lines = [
    `\u26A0 Workflow run ${runId} (${cell2(report.workflowName)}) needs attention \u2014 ${diagnosis.headline}`,
    `cost: ${report.agentCount} agents \xB7 ${tok(report.totalTokens)} tok (${reconNote}) \xB7 ${tok(report.totalToolCalls)} tool calls`
  ];
  if (diagnosis.findings.length > 0) {
    lines.push("findings:");
    for (const f of diagnosis.findings) lines.push(`  - [${f.kind}] ${f.detail}`);
  }
  lines.push(`Full audit: pnpm wt:report ${runId}${diskDir !== null ? ` (written to ${diskDir})` : ""}`);
  return { systemMessage: notice, block: true, reason: lines.join("\n") };
}
function buildProvisionalSurface(task) {
  return {
    systemMessage: `DWT audit \xB7 workflow "${cell2(task.name)}" (task ${task.id}) finished \u2014 journal not yet readable; run pnpm wt:report latest shortly for cost + traceability.`,
    block: false,
    reason: ""
  };
}
function mergeStopSurfaces(surfaces) {
  const out = {};
  const messages = surfaces.map((s) => s.systemMessage).filter((m) => m.length > 0);
  if (messages.length > 0) out.systemMessage = messages.join("\n");
  const blocking = surfaces.filter((s) => s.block && s.reason.length > 0);
  if (blocking.length > 0) {
    out.decision = "block";
    out.reason = blocking.map((s) => s.reason).join("\n\n");
  }
  return out;
}
function renderHookOutput(out) {
  return Object.keys(out).length === 0 ? "{}" : JSON.stringify(out);
}

// packages/debugger/src/stop-state.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
var REPORTED_CAP = 200;
var PROTO_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
function stateDir() {
  return join3(tmpdir(), "wt-stop-hook");
}
function statePath(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
  return join3(stateDir(), `${safe}.json`);
}
function strArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
function readStopState(sessionId) {
  try {
    const data = JSON.parse(readFileSync3(statePath(sessionId), "utf8"));
    if (!isRecord(data)) return { pending: [], reported: [], tries: {} };
    const tries = {};
    const rawTries = data["tries"];
    if (isRecord(rawTries)) {
      for (const [k, v] of Object.entries(rawTries)) {
        if (PROTO_KEYS.has(k)) continue;
        const n = numOrNull(v);
        if (n !== null) tries[k] = n;
      }
    }
    return { pending: strArray(data["pending"]), reported: strArray(data["reported"]), tries };
  } catch {
    return { pending: [], reported: [], tries: {} };
  }
}
function writeStopState(sessionId, state) {
  try {
    mkdirSync2(stateDir(), { recursive: true });
    const reported = state.reported.slice(-REPORTED_CAP);
    writeFileSync2(statePath(sessionId), JSON.stringify({ pending: state.pending, reported, tries: state.tries }));
  } catch {
  }
}

// packages/debugger/src/stop-hook.ts
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
function emit(output) {
  process.stdout.write(output);
  process.exit(0);
}
async function main() {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    emit("{}");
    return;
  }
  let payload;
  try {
    payload = parseStopPayload(JSON.parse(raw));
  } catch {
    emit("{}");
    return;
  }
  if (payload.sessionId === null) {
    emit("{}");
    return;
  }
  const sessionId = payload.sessionId;
  const cwd = payload.cwd ?? process.cwd();
  const state = readStopState(sessionId);
  const { toResolve, running } = planStopActions(state.pending, payload.workflows);
  const surfaces = [];
  const stillPending = [];
  for (const id of toResolve) {
    if (state.reported.includes(id)) continue;
    const tries = (state.tries[id] ?? 0) + 1;
    state.tries[id] = tries;
    const resolved = findJournalByTaskId(id, { cwd });
    const journal = resolved ? parseJournal(resolved.text) : null;
    const diagnosis = journal ? diagnoseRun(journal) : null;
    const decision = decideSurface(diagnosis, tries);
    if (decision.surface === "full" && resolved && journal && diagnosis) {
      const tdir = transcriptDirFor(resolved.path, resolved.runId);
      const agentIds = agentEvents(journal).map((a) => a.agentId).filter((id2) => typeof id2 === "string");
      const logDir = resolveLogDir(process.env);
      const { presentTranscripts, transcriptSources, usageByAgent } = scanTranscripts(tdir, agentIds, {
        withUsage: logDir !== null
      });
      const report = buildAuditReport(journal, { presentTranscripts, usageByAgent });
      let diskDir = null;
      if (logDir) {
        const markdown = formatAuditReportMarkdown(report, { journalPath: resolved.path });
        const result = writeAuditFolder({
          baseDir: logDir.baseDir,
          runId: resolved.runId,
          markdown,
          journalText: resolved.text,
          transcriptSources
        });
        if (result.written && result.dir) diskDir = result.dir;
      }
      surfaces.push(buildFullSurface({ runId: resolved.runId, report, diagnosis, diskDir }));
    } else if (decision.surface === "provisional") {
      const task = payload.workflows.find((w) => w.id === id);
      surfaces.push(buildProvisionalSurface({ id, name: task?.name ?? null }));
    }
    if (decision.conclusive) {
      state.reported.push(id);
      delete state.tries[id];
    } else {
      stillPending.push(id);
    }
  }
  const finalSurfaces = payload.stopHookActive ? surfaces.map((s) => ({ ...s, block: false })) : surfaces;
  state.pending = [.../* @__PURE__ */ new Set([...running, ...stillPending])];
  writeStopState(sessionId, state);
  emit(renderHookOutput(mergeStopSurfaces(finalSurfaces)));
}
main().catch(() => {
  process.stdout.write("{}");
  process.exit(0);
});

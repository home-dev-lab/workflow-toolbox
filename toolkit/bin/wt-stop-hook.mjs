#!/usr/bin/env node

// packages/debugger/src/source.ts
import { join as join2, basename } from "node:path";
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

// packages/debugger/src/config-dir.ts
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
function resolveDir(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
function resolveConfigDir(env = process.env) {
  const raw = env["CLAUDE_CONFIG_DIR"];
  return resolveDir(raw !== void 0 && raw.length > 0 ? raw : join(homedir(), ".claude"));
}

// packages/debugger/src/source.ts
var isJournalFile = (name) => /^wf_.*\.json$/.test(name);
var MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
function transcriptDirFor(journalPath, runId) {
  return join2(journalPath, "..", "..", "subagents", "workflows", runId);
}
function projectsBase(configDir) {
  return join2(configDir, "projects");
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
    const wfDir = join2(projectDir, session, "workflows");
    let names;
    try {
      names = readdirSync(wfDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (isJournalFile(name)) out.push({ path: join2(wfDir, name), sessionId: session });
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
  const base = projectsBase(opts.configDir ?? resolveConfigDir());
  const cwd = opts.cwd ?? process.cwd();
  const projectDir = opts.project ? join2(base, opts.project) : join2(base, projectSlug(cwd));
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
function dedupAssistantMessages(jsonl) {
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
    const key = strOrNull(message["id"]) ?? ` synthetic-${synthetic++}`;
    const currentOutput = numOrNull(usage["output_tokens"]) ?? 0;
    const prior = finals.get(key);
    const priorUsage = prior ? prior["usage"] : void 0;
    const priorOutput = isRecord(priorUsage) ? numOrNull(priorUsage["output_tokens"]) ?? 0 : -1;
    if (prior === void 0 || currentOutput >= priorOutput) finals.set(key, message);
  }
  return finals;
}
function parseTranscriptUsage(jsonl) {
  const finals = dedupAssistantMessages(jsonl);
  let total = emptyUsage();
  for (const message of finals.values()) {
    const usage = message["usage"];
    if (isRecord(usage)) total = addUsage(total, readUsage(usage));
  }
  return total;
}
function parseTranscriptCompaction(jsonl) {
  const events = [];
  for (const raw of jsonl.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed["type"] !== "system" || parsed["subtype"] !== "compact_boundary") continue;
    const meta = isRecord(parsed["compactMetadata"]) ? parsed["compactMetadata"] : {};
    events.push({
      trigger: strOrNull(meta["trigger"]),
      preTokens: numOrNull(meta["preTokens"]),
      postTokens: numOrNull(meta["postTokens"]),
      droppedTokens: numOrNull(meta["cumulativeDroppedTokens"]),
      durationMs: numOrNull(meta["durationMs"])
    });
  }
  const peaks = events.map((e) => e.preTokens).filter((n) => n !== null);
  return {
    compacted: events.length > 0,
    events,
    // reduce, NOT Math.max(...peaks): a pathological transcript with a huge boundary count would
    // blow the argument-spread limit and THROW, violating this parser's never-throws contract (and
    // — since scanTranscripts wraps no per-parse try/catch — aborting the whole scan, which would
    // also suppress the tool-denial signal read in the same pass).
    peakTokens: reduceOrNull(peaks, (a, b) => Math.max(a, b))
  };
}
function emptyCompactionReport() {
  return { agentsCompacted: 0, peakTokens: null, droppedTokens: null, agents: [], compacted: false };
}
function reduceOrNull(nums, fn) {
  return nums.length === 0 ? null : nums.reduce(fn);
}
function buildCompactionReport(perAgent) {
  const agents = [];
  for (const { agentId, label, compaction } of perAgent) {
    if (!compaction.compacted || compaction.events.length === 0) continue;
    const drops2 = compaction.events.map((e) => e.droppedTokens).filter((n) => n !== null);
    const peakEvent = compaction.events.find(
      (e) => compaction.peakTokens !== null && e.preTokens === compaction.peakTokens
    );
    const trigger = peakEvent?.trigger ?? compaction.events.map((e) => e.trigger).find((t) => t !== null) ?? null;
    agents.push({
      agentId,
      ...label !== void 0 ? { label } : {},
      peakTokens: compaction.peakTokens,
      droppedTokens: reduceOrNull(drops2, (a, b) => Math.max(a, b)),
      trigger,
      boundaries: compaction.events.length
    });
  }
  agents.sort((a, b) => (b.peakTokens ?? -1) - (a.peakTokens ?? -1) || a.agentId.localeCompare(b.agentId));
  const peaks = agents.map((a) => a.peakTokens).filter((n) => n !== null);
  const drops = agents.map((a) => a.droppedTokens).filter((n) => n !== null);
  return {
    agentsCompacted: agents.length,
    peakTokens: reduceOrNull(peaks, (a, b) => Math.max(a, b)),
    droppedTokens: reduceOrNull(drops, (a, b) => a + b),
    agents,
    compacted: agents.length > 0
  };
}

// packages/debugger/src/tool-denial.ts
var AUTO_MODE = /denied by the Claude Code auto mode classifier/i;
var AUTO_MODE_REASON = /Reason:\s*(\[[^\]]+\])/;
var HOOK = /\bHook \S+ denied this tool\b/i;
var REJECTED = /\bthe tool use was rejected\b|\bwant to proceed with this tool use\b/i;
function classifyDenial(resultText2) {
  if (typeof resultText2 !== "string" || resultText2 === "") return null;
  if (AUTO_MODE.test(resultText2)) {
    const m = AUTO_MODE_REASON.exec(resultText2);
    return { kind: "auto-mode-classifier", reason: m ? m[1] : null };
  }
  if (HOOK.test(resultText2)) return { kind: "hook", reason: null };
  if (REJECTED.test(resultText2)) return { kind: "rejected", reason: null };
  return null;
}
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => isRecord(b) && typeof b["text"] === "string" ? b["text"] : "").join("\n");
  }
  return "";
}
var DETAIL_MAX = 120;
function deriveDetail(input) {
  if (!isRecord(input)) return "";
  const candidate = strOrNull(input["command"]) ?? strOrNull(input["url"]) ?? strOrNull(input["query"]) ?? strOrNull(input["file_path"]) ?? strOrNull(input["path"]) ?? strOrNull(input["pattern"]) ?? firstStringValue(input);
  return candidate === null ? "" : candidate.replace(/\s+/g, " ").trim();
}
function firstStringValue(rec) {
  for (const v of Object.values(rec)) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}
function segmentHead(seg) {
  const toks = seg.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  return { verb: toks[i] ?? null, head: toks.slice(i, i + 2).join(" ") };
}
function signatureOf(tool, detail) {
  if (tool !== "Bash" || detail === "") return tool;
  const segs = detail.split("&&").map((s) => s.trim()).filter(Boolean);
  for (const seg of segs) {
    const { verb, head } = segmentHead(seg);
    if (verb === "cd") continue;
    if (head) return head;
  }
  return (segs[0] ? segmentHead(segs[0]).head : "") || tool;
}
var FETCH_RE = /(^|[^a-z])(fetch|search)([^a-z]|$)/i;
function isFetchClass(name) {
  if (name === "WebFetch" || name === "WebSearch") return true;
  return name.startsWith("mcp__") && FETCH_RE.test(name);
}
var EXEC_RE = /(^|[^a-z])execute([^a-z]|$)/i;
function isMcpExec(name) {
  return name.startsWith("mcp__") && EXEC_RE.test(name);
}
var RECOVERY_WINDOW = 5;
function isRecoveryFor(denied, success) {
  if (success.name === denied.tool && denied.detail !== "" && success.detail === denied.detail) return true;
  if (isFetchClass(denied.tool) && isFetchClass(success.name)) return true;
  if (denied.tool === "Bash" && isMcpExec(success.name)) return true;
  return false;
}
function parseTranscriptDenials(jsonl, agentId) {
  const toolUses = /* @__PURE__ */ new Map();
  const denials = [];
  const successes = [];
  let resultIndex = 0;
  for (const raw of jsonl.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const lineAt = strOrNull(parsed["timestamp"]);
    const message = parsed["message"];
    if (!isRecord(message)) continue;
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block["type"] === "tool_use") {
        const id = strOrNull(block["id"]);
        if (id !== null) toolUses.set(id, { name: strOrNull(block["name"]) ?? "(unknown)", input: block["input"] });
      } else if (block["type"] === "tool_result") {
        resultIndex++;
        const id = strOrNull(block["tool_use_id"]);
        const use = id !== null ? toolUses.get(id) : void 0;
        if (block["is_error"] !== true) {
          if (use !== void 0) successes.push({ resultIndex, name: use.name, detail: deriveDetail(use.input), at: lineAt });
          continue;
        }
        const verdict = classifyDenial(resultText(block["content"]));
        if (verdict === null) continue;
        const detail = deriveDetail(use?.input);
        denials.push({
          resultIndex,
          detail,
          denial: {
            agentId,
            tool: use?.name ?? "(unknown)",
            detail: detail.slice(0, DETAIL_MAX),
            kind: verdict.kind,
            reason: verdict.reason,
            at: lineAt
          }
        });
      }
    }
  }
  for (const s of successes) {
    let closest;
    for (const d of denials) {
      if (d.resultIndex >= s.resultIndex) break;
      if (d.denial.recovered !== void 0) continue;
      if (s.resultIndex - d.resultIndex > RECOVERY_WINDOW) continue;
      if (isRecoveryFor({ tool: d.denial.tool, detail: d.detail }, s)) closest = d;
    }
    if (closest !== void 0) closest.denial.recovered = { via: s.name, at: s.at };
  }
  return denials.map((d) => d.denial);
}
function buildToolDenialReport(perAgent) {
  const denials = [];
  const affected = /* @__PURE__ */ new Set();
  for (const list of perAgent) {
    for (const d of list) {
      denials.push(d);
      affected.add(d.agentId);
    }
  }
  const counts = /* @__PURE__ */ new Map();
  for (const d of denials) {
    const sig = signatureOf(d.tool, d.detail);
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  const bySignature = [...counts.entries()].map(([signature, count]) => ({ signature, count })).sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
  const recoveredCount = denials.filter((d) => d.recovered !== void 0).length;
  return {
    total: denials.length,
    agentsAffected: affected.size,
    bySignature,
    denials,
    degraded: denials.length > 0,
    recoveredCount,
    allRecovered: denials.length > 0 && recoveredCount === denials.length
  };
}
function emptyDenialReport() {
  return { total: 0, agentsAffected: 0, bySignature: [], denials: [], degraded: false, recoveredCount: 0, allRecovered: false };
}
function recoveryVias(report) {
  return [...new Set(report.denials.map((d) => d.recovered?.via).filter((v) => v !== void 0))];
}

// packages/debugger/src/external-delegation.ts
function matchesOpencodeRun(cmd = "") {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  const WIN = 2e4;
  const s = cmd.length <= 2 * WIN ? cmd : cmd.slice(0, WIN) + "\n" + cmd.slice(-WIN);
  const AFTER_QUOTED = /^(?:\.exe|\.cmd)?["']\s+run\b/;
  const AFTER_BARE = /^(?:\.exe|\.cmd)?\s+run\b/;
  const AFTER_BIN = /^["']?\s+run\b/;
  const BEFORE_OK = /[\s;|&(=/'"]/;
  for (let i = s.indexOf("opencode"); i !== -1; i = s.indexOf("opencode", i + 1)) {
    const before = i === 0 ? "" : s[i - 1];
    if (before && !BEFORE_OK.test(before)) continue;
    const after = s.slice(i + 8, i + 8 + 16);
    if (AFTER_QUOTED.test(after)) return true;
    if (before !== '"' && before !== "'" && AFTER_BARE.test(after)) return true;
  }
  let hasBinOpencode = false;
  for (let i = s.indexOf("BIN="); i !== -1; i = s.indexOf("BIN=", i + 1)) {
    const nl = s.indexOf("\n", i);
    const end = Math.min(nl === -1 ? s.length : nl, i + 4 + 256);
    if (s.slice(i + 4, end).indexOf("opencode") !== -1) {
      hasBinOpencode = true;
      break;
    }
  }
  if (hasBinOpencode) {
    for (const m of s.matchAll(/\$\{?[A-Za-z_]*BIN\}?/g)) {
      const at = m.index ?? 0;
      const tok2 = m[0] ?? "";
      if (AFTER_BIN.test(s.slice(at + tok2.length, at + tok2.length + 16))) return true;
    }
  }
  return false;
}
var DELEGATION_EXPECTATIONS = [
  {
    id: "opencode",
    typeRe: /opencode/i,
    commandRe: /(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?opencode(?:\.exe|\.cmd)?\s+run\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?opencode(?:\.exe|\.cmd)?["']\s+run\b|[A-Za-z_]*BIN=[^\n]*opencode[\s\S]*?"?\$\{?[A-Za-z_]*BIN\}?"?\s+run\b/im,
    matchCommand: matchesOpencodeRun
  },
  {
    id: "codex",
    typeRe: /codex/i,
    commandRe: /codex-companion\.mjs["']?\s+task\b|(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?codex(?:\.exe)?\s+exec\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?codex(?:\.exe)?["']\s+exec\b/im
  }
];
var DEFAULT_AGENT_TYPES = /* @__PURE__ */ new Set(["workflow-subagent"]);
function isDelegatedAgentType(agentType) {
  return !DEFAULT_AGENT_TYPES.has(agentType);
}
function expectationForAgentType(agentType) {
  for (const e of DELEGATION_EXPECTATIONS) if (e.typeRe.test(agentType)) return e;
  return null;
}
var COMMAND_SCAN_MAX = 2e4;
function isExternalCliCommand(command, expectation) {
  if (expectation.matchCommand) return expectation.matchCommand(command);
  const text = command.length > COMMAND_SCAN_MAX ? command.slice(0, COMMAND_SCAN_MAX) : command;
  return expectation.commandRe.test(text);
}
var COMMAND_PREVIEW_MAX = 120;
function parseTranscriptExternalCalls(jsonl, expectation) {
  let cliCalls = 0;
  let firstCommand = null;
  for (const raw of jsonl.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const message = parsed["message"];
    if (!isRecord(message)) continue;
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block["type"] !== "tool_use") continue;
      if (strOrNull(block["name"]) !== "Bash") continue;
      const input = block["input"];
      if (!isRecord(input)) continue;
      const command = strOrNull(input["command"]);
      if (command === null || !isExternalCliCommand(command, expectation)) continue;
      cliCalls++;
      if (firstCommand === null) firstCommand = command.replace(/\s+/g, " ").trim().slice(0, COMMAND_PREVIEW_MAX);
    }
  }
  return { cliCalls, firstCommand };
}
function emptyExternalDelegationReport() {
  return { delegatedAgents: 0, withoutCli: [], agents: [], unknown: [], flagged: false };
}
function buildExternalDelegationReport(perAgent) {
  const agents = [];
  const unknown = [];
  for (const input of perAgent) {
    const expectation = expectationForAgentType(input.agentType);
    if (expectation === null) {
      unknown.push({
        agentId: input.agentId,
        ...input.label !== void 0 ? { label: input.label } : {},
        agentType: input.agentType
      });
      continue;
    }
    if (input.scan === null) continue;
    agents.push({
      agentId: input.agentId,
      ...input.label !== void 0 ? { label: input.label } : {},
      agentType: input.agentType,
      expectation: expectation.id,
      cliCalls: input.scan.cliCalls,
      firstCommand: input.scan.firstCommand,
      cliSeen: input.scan.cliCalls > 0
    });
  }
  const withoutCli = agents.filter((a) => !a.cliSeen);
  return {
    delegatedAgents: agents.length,
    withoutCli,
    agents,
    unknown,
    flagged: withoutCli.length > 0
  };
}

// packages/debugger/src/report.ts
function readEnvelopeTrail(result) {
  const map = /* @__PURE__ */ new Map();
  const conflicted = /* @__PURE__ */ new Set();
  if (!isRecord(result)) return map;
  const envelope = result["envelope"];
  if (!isRecord(envelope)) return map;
  const trail = envelope["trail"];
  if (!Array.isArray(trail)) return map;
  for (const entry of trail) {
    if (!isRecord(entry)) continue;
    const stage = strOrNull(entry["stage"]);
    if (stage === null || conflicted.has(stage)) continue;
    const enrichment = {
      outcome: strOrNull(entry["outcome"]),
      decision: strOrNull(entry["decision"]),
      model: strOrNull(entry["model"]),
      effort: strOrNull(entry["effort"])
    };
    const seen = map.get(stage);
    if (seen === void 0) {
      map.set(stage, enrichment);
    } else if (seen.outcome !== enrichment.outcome || seen.decision !== enrichment.decision || seen.model !== enrichment.model || seen.effort !== enrichment.effort) {
      map.delete(stage);
      conflicted.add(stage);
    }
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
      phaseTitle: a.phaseTitle,
      model: enr?.model ?? null,
      effort: enr?.effort ?? null
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
  const labelById = /* @__PURE__ */ new Map();
  for (const a of agents) if (a.agentId !== null) labelById.set(a.agentId, a.label);
  let denials = emptyDenialReport();
  if (opts.denialsByAgent && opts.denialsByAgent.size > 0) {
    const enriched = [];
    for (const [agentId, list] of opts.denialsByAgent) {
      const label = labelById.get(agentId);
      enriched.push(label === void 0 ? list : list.map((d) => ({ ...d, label })));
    }
    denials = buildToolDenialReport(enriched);
  }
  let compaction = emptyCompactionReport();
  if (opts.compactionByAgent && opts.compactionByAgent.size > 0) {
    const enriched = [];
    for (const [agentId, c] of opts.compactionByAgent) {
      const label = labelById.get(agentId);
      enriched.push(label === void 0 ? { agentId, compaction: c } : { agentId, label, compaction: c });
    }
    compaction = buildCompactionReport(enriched);
  }
  let delegation = emptyExternalDelegationReport();
  if (opts.delegationByAgent && opts.delegationByAgent.size > 0) {
    const inputs = [];
    for (const [agentId, d] of opts.delegationByAgent) {
      const label = labelById.get(agentId);
      inputs.push(
        label === void 0 ? { agentId, agentType: d.agentType, scan: d.scan } : { agentId, label, agentType: d.agentType, scan: d.scan }
      );
    }
    delegation = buildExternalDelegationReport(inputs);
  }
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
    tokenBreakdown,
    denials,
    compaction,
    delegation
  };
}

// packages/debugger/src/report-format.ts
function num(n) {
  return n === null ? "\u2014" : n.toLocaleString("en-US");
}
function cell(s) {
  if (s === null || s === "") return "\u2014";
  return s.replace(/\|/g, "\\|");
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
  lines.push("## Tool denials");
  lines.push("");
  const den = r.denials;
  if (den === void 0 || den.total === 0) {
    lines.push("_No tool denials detected \u2014 no agent was blocked from a tool it asked for._");
  } else {
    const groups = den.bySignature.map((g) => `${g.signature} \xD7${g.count}`).join(", ");
    if (den.allRecovered) {
      const vias = recoveryVias(den).join(", ");
      lines.push(
        `\u26A0 **${den.total} tool call(s) DENIED across ${den.agentsAffected} agent(s) \u2014 ALL show a RECOVERY signal** (the agent later succeeded via ${vias}): ${groups}. Verify the recovery covered the same intent.`
      );
    } else {
      lines.push(
        `\u26A0 **${den.total} tool call(s) DENIED across ${den.agentsAffected} agent(s)** \u2014 this run may be DEGRADED (an agent silently could not use a tool it asked for): ${groups}.` + (den.recoveredCount > 0 ? ` ${den.recoveredCount} of ${den.total} show a recovery signal.` : "")
      );
    }
    lines.push("");
    lines.push("| Stage | Tool | Attempted | Denial | Reason | Recovered |");
    lines.push("|-------|------|-----------|--------|--------|-----------|");
    for (const d of den.denials) {
      lines.push(
        `| ${cell(d.label ?? null)} | ${cell(d.tool)} | ${cell(d.detail || null)} | ${cell(d.kind)} | ${cell(d.reason)} | ${d.recovered !== void 0 ? `via ${cell(d.recovered.via)}` : "\u2014"} |`
      );
    }
  }
  lines.push("");
  lines.push("## External delegation");
  lines.push("");
  const del = r.delegation;
  if (del === void 0 || del.delegatedAgents === 0 && del.unknown.length === 0) {
    lines.push("_No external delegation requested \u2014 no agent ran under an external agentType._");
  } else {
    if (del.flagged) {
      lines.push(
        `\u26A0 **${del.withoutCli.length} of ${del.delegatedAgents} delegated agent(s) show NO external-CLI tool_use** \u2014 the wrapper may have SELF-ANSWERED (output is same-family, presented as external). Verify from the agent transcript before trusting these outputs as decorrelated.`
      );
    } else if (del.delegatedAgents > 0) {
      lines.push(
        `\u2713 ${del.delegatedAgents} delegated agent(s) \u2014 every one shows a real external-CLI invocation.`
      );
    }
    if (del.agents.length > 0) {
      lines.push("");
      lines.push("| Stage | Agent type | CLI | Calls | First command |");
      lines.push("|-------|-----------|-----|------:|---------------|");
      for (const a of del.agents) {
        lines.push(
          `| ${cell(a.label ?? null)} | ${cell(a.agentType)} | ${a.cliSeen ? "\u2713" : "\u26A0 NONE"} | ${a.cliCalls} | ${cell(a.firstCommand)} |`
        );
      }
    }
    if (del.unknown.length > 0) {
      lines.push("");
      lines.push(
        `\u2139 ${del.unknown.length} delegation(s) to agentType(s) with no registered CLI signature \u2014 compliance not judged: ${del.unknown.map((u) => u.agentType).join(", ")}.`
      );
    }
  }
  lines.push("");
  lines.push("## Auto-compaction");
  lines.push("");
  const comp = r.compaction;
  if (comp === void 0 || comp.agentsCompacted === 0) {
    lines.push("_No agent compacted its context \u2014 every agent stayed within its window._");
  } else {
    lines.push(
      `\u2139 **${comp.agentsCompacted} agent(s) compacted their context** (peak ~${num(comp.peakTokens)} tokens) \u2014 an agent's context window filled up mid-run, so Claude Code auto-compacted it: the earliest ~${num(comp.droppedTokens)} tokens of its history were replaced with a short summary. The agent then kept working from that summary instead of the original detail, so anything it produced afterward may be less accurate. The run still SUCCEEDED \u2014 a heads-up to fan out more / read less per agent, not a failure.`
    );
    lines.push("");
    lines.push("| Stage | Peak tokens | Dropped | Trigger |");
    lines.push("|-------|------------:|--------:|---------|");
    for (const a of comp.agents) {
      lines.push(`| ${cell(a.label ?? null)} | ${num(a.peakTokens)} | ${num(a.droppedTokens)} | ${cell(a.trigger)} |`);
    }
  }
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
    lines.push("| Stage | Outcome | Decision | Model | Effort | Phase |");
    lines.push("|-------|---------|----------|-------|--------|-------|");
    for (const d of r.decisions) {
      lines.push(
        `| ${cell(d.stage)} | ${cell(d.outcome)} | ${cell(d.decision)} | ${cell(d.model ?? null)} | ${cell(d.effort ?? null)} | ${cell(d.phaseTitle)} |`
      );
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
import { join as join3 } from "node:path";
function resolveLogDir(env, outFlag) {
  if (outFlag !== void 0 && outFlag.trim() !== "") return { baseDir: outFlag, source: "flag" };
  const envDir = env["DWT_WORKFLOW_LOG_DIR"];
  if (typeof envDir === "string" && envDir.trim() !== "") return { baseDir: envDir, source: "env" };
  return null;
}
function isSafeAgentId(agentId) {
  return /^[A-Za-z0-9_-]+$/.test(agentId);
}
function scanTranscripts(transcriptDir, agentIds, opts = {}) {
  const presentTranscripts = /* @__PURE__ */ new Set();
  const transcriptSources = [];
  const usageByAgent = /* @__PURE__ */ new Map();
  const denialsByAgent = /* @__PURE__ */ new Map();
  const compactionByAgent = /* @__PURE__ */ new Map();
  const delegationByAgent = /* @__PURE__ */ new Map();
  const needRead = opts.withUsage === true || opts.withDenials === true || opts.withCompaction === true || opts.withDelegation === true;
  for (const agentId of agentIds) {
    if (!isSafeAgentId(agentId)) continue;
    const sourcePath = join3(transcriptDir, `agent-${agentId}.jsonl`);
    if (needRead) {
      let text;
      try {
        text = readFileSync2(sourcePath, "utf8");
      } catch {
        continue;
      }
      presentTranscripts.add(agentId);
      transcriptSources.push({ agentId, sourcePath });
      if (opts.withUsage) {
        const usage = parseTranscriptUsage(text);
        if (isNonEmptyUsage(usage)) usageByAgent.set(agentId, usage);
      }
      if (opts.withDenials) {
        const denials = parseTranscriptDenials(text, agentId);
        if (denials.length > 0) denialsByAgent.set(agentId, denials);
      }
      if (opts.withCompaction) {
        const compaction = parseTranscriptCompaction(text);
        if (compaction.compacted) compactionByAgent.set(agentId, compaction);
      }
      if (opts.withDelegation) {
        const agentType = readAgentTypeSidecar(join3(transcriptDir, `agent-${agentId}.meta.json`));
        if (agentType !== null && isDelegatedAgentType(agentType)) {
          const expectation = expectationForAgentType(agentType);
          delegationByAgent.set(agentId, {
            agentType,
            scan: expectation !== null ? parseTranscriptExternalCalls(text, expectation) : null
          });
        }
      }
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
  return { presentTranscripts, transcriptSources, usageByAgent, denialsByAgent, compactionByAgent, delegationByAgent };
}
function readAgentTypeSidecar(metaPath) {
  let text;
  try {
    text = readFileSync2(metaPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? strOrNull(parsed["agentType"]) : null;
  } catch {
    return null;
  }
}
function writeAuditFolder(args) {
  const dir = join3(args.baseDir, args.runId);
  try {
    mkdirSync(dir, { recursive: true });
    const files = [];
    writeFileSync(join3(dir, "report.md"), args.markdown, "utf8");
    files.push("report.md");
    writeFileSync(join3(dir, "journal.json"), args.journalText, "utf8");
    files.push("journal.json");
    if (args.transcriptSources.length > 0) {
      const tdir = join3(dir, "transcripts");
      mkdirSync(tdir, { recursive: true });
      for (const t of args.transcriptSources) {
        const rel = `transcripts/agent-${t.agentId}.jsonl`;
        try {
          copyFileSync(t.sourcePath, join3(dir, rel));
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
  const trouble = isTrouble(diagnosis.mode);
  const degraded = report.denials?.degraded ?? false;
  const compacted = report.compaction?.compacted ?? false;
  const selfAnswered = report.delegation?.flagged ?? false;
  const block = trouble || degraded || selfAnswered;
  let notice = `DWT audit \xB7 ${runId} (${cell2(report.workflowName)}) ${cell2(report.status)} \xB7 ${report.agentCount} agents \xB7 ${tok(report.totalTokens)} tok \xB7 ${report.decisions.length} decisions \u2192 pnpm wt:report ${runId}` + (diskDir !== null ? ` \xB7 written to ${diskDir}` : "");
  if (degraded && report.denials) {
    notice += ` \xB7 \u26A0 ${report.denials.total} tool denial(s)/${report.denials.agentsAffected} agent(s)`;
  }
  if (selfAnswered && report.delegation) {
    notice += ` \xB7 \u26A0 ${report.delegation.withoutCli.length}/${report.delegation.delegatedAgents} delegated agent(s) NO external CLI`;
  }
  if (compacted && report.compaction) {
    notice += ` \xB7 \u2139 ${report.compaction.agentsCompacted} agent(s) compacted context (peak ~${tok(report.compaction.peakTokens)} tok)`;
  }
  if (!block) return { systemMessage: notice, block: false, reason: "" };
  const lines = [];
  if (trouble) {
    const recon = report.reconciliation;
    const reconNote = recon.reconciles ? "reconciled" : `UNRECONCILED (\u0394 ${recon.delta === null ? "\u2014" : recon.delta.toLocaleString("en-US")}, ${recon.missingTokenAgents} agent(s) missing tokens)`;
    lines.push(`\u26A0 Workflow run ${runId} (${cell2(report.workflowName)}) needs attention \u2014 ${diagnosis.headline}`);
    lines.push(
      `cost: ${report.agentCount} agents \xB7 ${tok(report.totalTokens)} tok (${reconNote}) \xB7 ${tok(report.totalToolCalls)} tool calls`
    );
    if (diagnosis.findings.length > 0) {
      lines.push("findings:");
      for (const f of diagnosis.findings) lines.push(`  - [${f.kind}] ${f.detail}`);
    }
  }
  if (degraded && report.denials) {
    const d = report.denials;
    const groups = d.bySignature.map((g) => `${g.signature} \xD7${g.count}`).join(", ");
    if (d.allRecovered) {
      const vias = recoveryVias(d).join(", ");
      lines.push(
        `\u26A0 Workflow run ${runId} (${cell2(report.workflowName)}) \u2014 ${d.total} tool call(s) DENIED across ${d.agentsAffected} agent(s) (${groups}), but ALL show a RECOVERY signal: the agent(s) later succeeded via ${vias}.`
      );
      lines.push("  Verify the recovery covered the same intent; the full denial list is in the audit report.");
    } else {
      lines.push(
        `\u26A0 Workflow run ${runId} (${cell2(report.workflowName)}) may be DEGRADED \u2014 ${d.total} tool call(s) silently DENIED across ${d.agentsAffected} agent(s): ${groups}.`
      );
      lines.push(
        "  An agent could not use a tool it asked for (e.g. read the diff / run a test) \u2014 its output may be blind."
      );
      if (d.recoveredCount > 0) {
        lines.push(
          `  (${d.recoveredCount} of ${d.total} show a recovery signal \u2014 the agent later succeeded via an equivalent tool.)`
        );
      }
    }
  }
  if (selfAnswered && report.delegation) {
    const d = report.delegation;
    const types = [...new Set(d.withoutCli.map((a) => a.agentType))].join(", ");
    lines.push(
      `\u26A0 Workflow run ${runId} (${cell2(report.workflowName)}) requested EXTERNAL delegation (${types}) but ${d.withoutCli.length} of ${d.delegatedAgents} routed agent(s) show NO external-CLI tool_use \u2014 the wrapper may have SELF-ANSWERED, so those verdicts may be same-family, not external.`
    );
    lines.push("  Verify from the agent transcript(s) before trusting them as decorrelated; details in the audit report.");
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
import { join as join4 } from "node:path";
var REPORTED_CAP = 200;
var PROTO_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
function stateDir() {
  return join4(tmpdir(), "wt-stop-hook");
}
function statePath(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
  return join4(stateDir(), `${safe}.json`);
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
var DURABLE_SET_CAP = 500;
function durableSetPath(cwd, kind) {
  const safe = (projectSlug(cwd) || "unknown").slice(0, 200);
  return join4(stateDir(), `${kind}-${safe}.json`);
}
function readDurableSet(cwd, kind, field) {
  try {
    const data = JSON.parse(readFileSync3(durableSetPath(cwd, kind), "utf8"));
    if (!isRecord(data)) return [];
    return strArray(data[field]);
  } catch {
    return [];
  }
}
function writeDurableSet(cwd, kind, field, values) {
  try {
    mkdirSync2(stateDir(), { recursive: true });
    const merged = [.../* @__PURE__ */ new Set([...readDurableSet(cwd, kind, field), ...values])];
    writeFileSync2(durableSetPath(cwd, kind), JSON.stringify({ [field]: merged.slice(-DURABLE_SET_CAP) }));
  } catch {
  }
}
function readReportedRuns(cwd) {
  return readDurableSet(cwd, "reported-runs", "runs");
}
function writeReportedRuns(cwd, runs) {
  writeDurableSet(cwd, "reported-runs", "runs", runs);
}
function readGivenUpTasks(cwd) {
  return readDurableSet(cwd, "given-up-tasks", "tasks");
}
function writeGivenUpTasks(cwd, tasks) {
  writeDurableSet(cwd, "given-up-tasks", "tasks", tasks);
}

// packages/debugger/src/stop-hook.ts
function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => resolve2(data));
    process.stdin.on("error", () => resolve2(data));
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
  const reportedRuns = new Set(readReportedRuns(cwd));
  let reportedRunsChanged = false;
  const givenUpTasks = new Set(readGivenUpTasks(cwd));
  let givenUpTasksChanged = false;
  const { toResolve, running } = planStopActions(state.pending, payload.workflows);
  const surfaces = [];
  const stillPending = [];
  for (const id of toResolve) {
    if (state.reported.includes(id)) continue;
    const tries = (state.tries[id] ?? 0) + 1;
    state.tries[id] = tries;
    const resolved = findJournalByTaskId(id, { cwd });
    const runId = resolved?.runId ?? null;
    if (runId !== null && reportedRuns.has(runId)) {
      state.reported.push(id);
      delete state.tries[id];
      continue;
    }
    const journal = resolved ? parseJournal(resolved.text) : null;
    const diagnosis = journal ? diagnoseRun(journal) : null;
    if (diagnosis === null && givenUpTasks.has(id)) {
      state.reported.push(id);
      delete state.tries[id];
      continue;
    }
    const decision = decideSurface(diagnosis, tries);
    if (decision.surface === "full" && resolved && journal && diagnosis) {
      const tdir = transcriptDirFor(resolved.path, resolved.runId);
      const agentIds = agentEvents(journal).map((a) => a.agentId).filter((id2) => typeof id2 === "string");
      const logDir = resolveLogDir(process.env);
      const { presentTranscripts, transcriptSources, usageByAgent, denialsByAgent, compactionByAgent, delegationByAgent } = scanTranscripts(tdir, agentIds, {
        withUsage: logDir !== null,
        withDenials: true,
        withCompaction: true,
        withDelegation: true
      });
      const report = buildAuditReport(journal, {
        presentTranscripts,
        usageByAgent,
        denialsByAgent,
        compactionByAgent,
        delegationByAgent
      });
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
      if (runId !== null) {
        if (!reportedRuns.has(runId)) {
          reportedRuns.add(runId);
          reportedRunsChanged = true;
        }
      } else if (!givenUpTasks.has(id)) {
        givenUpTasks.add(id);
        givenUpTasksChanged = true;
      }
    } else {
      stillPending.push(id);
    }
  }
  const finalSurfaces = payload.stopHookActive ? surfaces.map((s) => ({ ...s, block: false })) : surfaces;
  state.pending = [.../* @__PURE__ */ new Set([...running, ...stillPending])];
  writeStopState(sessionId, state);
  if (reportedRunsChanged) writeReportedRuns(cwd, [...reportedRuns]);
  if (givenUpTasksChanged) writeGivenUpTasks(cwd, [...givenUpTasks]);
  emit(renderHookOutput(mergeStopSurfaces(finalSurfaces)));
}
var stopHookSelfTest = process.env.WT_FAIL_OPEN_TRACE_SELF_TEST;
var stopHookEntry = stopHookSelfTest === "*" || stopHookSelfTest === "wt-stop-hook.mjs" ? Promise.reject(new Error("forced fail-open self-test for wt-stop-hook.mjs")) : main();
stopHookEntry.catch((error) => {
  try {
    process.stderr.write(`wt-stop-hook.mjs: FAILED OPEN - ${error instanceof Error ? error.message : String(error)}
`);
  } catch {
  }
  process.stdout.write("{}");
  process.exit(0);
});

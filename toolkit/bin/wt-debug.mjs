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
function projectsBase(home) {
  return join(home, ".claude", "projects");
}
function scannedProjectDir(opts = {}) {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  return join(projectsBase(home), opts.project ?? projectSlug(cwd));
}
function looksLikeJournalPath(arg) {
  return arg.includes("/") || arg.includes("\\") || arg.endsWith(".json");
}
function resolveJournalPath(path) {
  const name = basename(path);
  if (!isJournalFile(name)) return null;
  const sessionDir = join(path, "..", "..");
  return readResolved({ path, sessionId: basename(sessionDir) });
}
function projectDirFor(journalPath) {
  return join(journalPath, "..", "..", "..");
}
function journalLookupErrorMessage(tool, runId, opts = {}) {
  if (runId && looksLikeJournalPath(runId)) {
    return `${tool}: cannot read journal path ${JSON.stringify(runId)} \u2014 not an existing wf_*.json file.`;
  }
  const which = runId && runId !== "latest" ? `run "${runId}"` : "any run in this project";
  return `${tool}: no journal found for ${which}.
  [scanned ${scannedProjectDir(opts)}]
  Journals live at ~/.claude/projects/<project>/<session>/workflows/wf_<runId>.json.
  Run from the project that produced the run, pass --project=<slug>, or pass the journal path directly.`;
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
function normalizeRunId(id) {
  const s = id.trim().replace(/\.json$/, "");
  return s.startsWith("wf_") ? s : `wf_${s}`;
}
function findJournal(runId, opts = {}) {
  const home = opts.home ?? homedir();
  const base = projectsBase(home);
  const cwd = opts.cwd ?? process.cwd();
  if (runId && looksLikeJournalPath(runId)) {
    return resolveJournalPath(runId);
  }
  if (runId && runId !== "latest") {
    const wanted = normalizeRunId(runId);
    const projectDirs = opts.project ? [join(base, opts.project)] : [join(base, projectSlug(cwd)), ...listDirs(base).map((d) => join(base, d))];
    const seen = /* @__PURE__ */ new Set();
    for (const dir of projectDirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      for (const entry of listJournals(dir)) {
        if (basename(entry.path).replace(/\.json$/, "") === wanted) return readResolved(entry);
      }
    }
    return null;
  }
  const projectDir = opts.project ? join(base, opts.project) : join(base, projectSlug(cwd));
  const journals = listJournals(projectDir);
  if (journals.length === 0) return null;
  let newest = journals[0];
  let newestMtime = mtimeMs(newest.path);
  for (const entry of journals.slice(1)) {
    const m = mtimeMs(entry.path);
    if (m > newestMtime) {
      newest = entry;
      newestMtime = m;
    }
  }
  return readResolved(newest);
}

// packages/debugger/src/diagnose.ts
var BUDGET_HINT = /budget|token target|\bfloor\b|remaining|exhaust/i;
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

// packages/debugger/src/format.ts
function formatDiagnosis(d, ctx = {}) {
  const lines = [];
  const s = d.stats;
  lines.push(`[${d.mode}] ${d.headline}`);
  lines.push(`  run ${s.runId}  \xB7  workflow ${s.workflowName}  \xB7  status ${s.status}`);
  lines.push(
    `  agents: ${s.doneAgents} done, ${s.incompleteAgents} incomplete, ${s.retriedAgents} retried  \xB7  ${s.totalTokens.toLocaleString("en-US")} tok  \xB7  ${s.totalToolCalls} tool calls  \xB7  ${s.durationMs} ms`
  );
  if (ctx.journalPath) lines.push(`  journal: ${ctx.journalPath}`);
  if (d.findings.length > 0) {
    lines.push("");
    lines.push("FINDINGS");
    for (const f of d.findings) lines.push(`  - [${f.kind}] ${f.detail}`);
  }
  lines.push("");
  if (d.resume.recommended) {
    lines.push("RESUME \u2014 recommended");
    lines.push(`  ${d.resume.rationale}`);
    lines.push(`  Workflow({ scriptPath, resumeFromRunId: "${s.runId}" })`);
    if (d.resume.sameSessionOnly) {
      lines.push(
        ctx.sessionId ? `  \u26A0 same session only \u2014 cache replays only in session ${ctx.sessionId}.` : "  \u26A0 same session only \u2014 cache replays only in the session that produced the run."
      );
    }
  } else {
    lines.push("RESUME \u2014 not recommended");
    lines.push(`  ${d.resume.rationale}`);
  }
  if (s.doneAgents + s.incompleteAgents > 0) {
    const reportCommand = ctx.reportCommand ?? "pnpm wt:report";
    const projectArg = ctx.project ? ` --project=${ctx.project}` : "";
    lines.push("");
    lines.push(`for per-agent cost + transcripts: ${reportCommand} ${s.runId}${projectArg}`);
  }
  return lines.join("\n");
}

// packages/debugger/src/cli-args.ts
var KNOWN_FLAGS = /* @__PURE__ */ new Set(["--json", "--project", "--out", "--quiet", "--help", "-h"]);
function takeValue(argv, i, flag) {
  const v = argv[i];
  if (v === void 0 || KNOWN_FLAGS.has(v)) {
    return { error: `${flag} requires a value.` };
  }
  return { value: v };
}
function equalsValue(arg, flag) {
  const v = arg.slice(flag.length + 1);
  if (v === "") return { error: `${flag} requires a value.` };
  return { value: v };
}
function parseDebugArgs(argv) {
  const r = { runId: null, json: false, project: void 0, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") r.json = true;
    else if (a === "--project") {
      const t = takeValue(argv, ++i, "--project");
      if (t.error) return { ...r, error: t.error };
      r.project = t.value;
    } else if (a.startsWith("--project=")) {
      const t = equalsValue(a, "--project");
      if (t.error) return { ...r, error: t.error };
      r.project = t.value;
    } else if (a === "--help" || a === "-h") r.help = true;
    else if (!a.startsWith("-")) r.runId = a;
  }
  return r;
}

// packages/debugger/src/cli.ts
function printHelp() {
  process.stdout.write(
    [
      "wt-debug \u2014 diagnose a Claude Code Workflow run from its journal",
      "",
      "Usage: wt-debug [runId|latest|<journal-path>] [--json] [--project <slug>]",
      "",
      "  runId        wf_<id> of the run (with or without the wf_ prefix). Omit or",
      '               pass "latest" to diagnose the newest run in the current project.',
      "               A literal ~/.claude/.../workflows/wf_<id>.json path also works.",
      "  --json       emit the raw diagnosis as JSON instead of the text report.",
      "  --project    search a specific ~/.claude/projects/<slug> instead of the cwd",
      '               (slugs start with "-"; both `--project <slug>` and',
      "               `--project=<slug>` forms are accepted).",
      ""
    ].join("\n") + "\n"
  );
}
function main() {
  const { runId, json, project, help, error } = parseDebugArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return 0;
  }
  if (error) {
    process.stderr.write(`wt-debug: ${error}
`);
    return 2;
  }
  const opts = project ? { project } : {};
  const resolved = findJournal(runId, opts);
  if (!resolved) {
    process.stderr.write(journalLookupErrorMessage("wt-debug", runId, opts) + "\n");
    return 1;
  }
  process.stderr.write(`[project dir: ${projectDirFor(resolved.path)}]
`);
  const journal = parseJournal(resolved.text);
  if (!journal) {
    process.stderr.write(`wt-debug: ${resolved.path} is not a readable workflow journal.
`);
    return 1;
  }
  const diagnosis = diagnoseRun(journal);
  if (json) {
    process.stdout.write(
      JSON.stringify(
        { ...diagnosis, journalPath: resolved.path, sessionId: resolved.sessionId },
        null,
        2
      ) + "\n"
    );
  } else {
    process.stdout.write(
      formatDiagnosis(diagnosis, {
        journalPath: resolved.path,
        sessionId: resolved.sessionId,
        ...project !== void 0 && { project }
      }) + "\n"
    );
  }
  return 0;
}
process.exit(main());

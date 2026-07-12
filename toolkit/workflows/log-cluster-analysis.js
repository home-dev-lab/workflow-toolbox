export const meta = {
  "name": "log-cluster-analysis",
  "description": "Clusters the error signatures in an oversized log by chunking the text deterministically, analyzing each chunk in parallel for error signatures, then synthesizing the per-chunk findings into cross-log clusters with counts and a summary.",
  "whenToUse": "Use when a log (or any large text) is too big for a single agent context and you need a map-analyze-then-synthesize pass — e.g. finding error clusters, extracting entities, or summarizing a huge diff. The launcher passes the text as args.log.",
  "phases": [
    {
      "title": "Analyze",
      "detail": "Chunk the log, analyze each chunk in parallel, synthesize clusters"
    },
    {
      "title": "Report",
      "detail": "Surface the clustered report with honest chunk/drop/truncate counts"
    }
  ]
}
var __wt = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // log-cluster-analysis.workflow.ts
  var log_cluster_analysis_workflow_exports = {};
  __export(log_cluster_analysis_workflow_exports, {
    default: () => log_cluster_analysis_workflow_default
  });

  // ../packages/runtime/src/digest.ts
  var DIGEST_PREFIX = "[wt:digest]";
  function formatDigest(d) {
    const body = { stage: d.stage };
    if (d.output !== void 0) body.output = d.output;
    if (d.taken !== void 0) body.taken = d.taken;
    if (d.notTaken !== void 0) body.notTaken = d.notTaken;
    if (d.counts !== void 0) {
      const counts = d.counts;
      const sorted = {};
      for (const k of Object.keys(counts).sort()) {
        const v = counts[k];
        if (v !== void 0) sorted[k] = v;
      }
      body.counts = sorted;
    }
    return `${DIGEST_PREFIX} ${JSON.stringify(body)}`;
  }

  // ../packages/runtime/src/prompt-tag.ts
  var PROMPT_TAG_PREFIX = "<!-- wt-meta ";
  function escapeValue(v) {
    return v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "&#10;");
  }
  function buildPromptTag(fields) {
    const parts = [];
    if (fields.label !== void 0) parts.push(`label="${escapeValue(fields.label)}"`);
    if (fields.phase !== void 0) parts.push(`phase="${escapeValue(fields.phase)}"`);
    if (parts.length === 0) return null;
    return `${PROMPT_TAG_PREFIX}${parts.join(" ")} -->`;
  }
  function withPromptTags(rt) {
    let currentPhase;
    const agent = (prompt, opts) => {
      const tag = buildPromptTag({ label: opts?.label, phase: opts?.phase ?? currentPhase });
      const tagged = tag !== null && !prompt.startsWith(tag) ? `${tag}

${prompt}` : prompt;
      return rt.agent(tagged, opts);
    };
    return {
      agent,
      parallel: rt.parallel,
      pipeline: rt.pipeline,
      phase: (title) => {
        currentPhase = title;
        rt.phase(title);
      },
      log: (message) => rt.log(message),
      budget: rt.budget,
      workflow: rt.workflow
    };
  }

  // ../packages/build/src/define-workflow.ts
  function normalizeArgs(raw) {
    if (raw === void 0) return void 0;
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  var KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  function validateMeta(meta) {
    if (!KEBAB_RE.test(meta.name)) {
      throw new Error(
        `defineWorkflow: invalid name "${meta.name}" \u2014 name must be non-empty kebab-case (e.g. "my-workflow", "plan-and-execute-v2"); only lowercase letters, digits, and hyphens are allowed, starting and ending with a letter or digit`
      );
    }
    if (meta.description.trim().length === 0) {
      throw new Error(
        `defineWorkflow: description must be a non-empty string \u2014 provide a short summary of what this workflow does`
      );
    }
    if (meta.phases !== void 0) {
      for (let i = 0; i < meta.phases.length; i++) {
        const phase = meta.phases[i];
        if (phase === void 0) continue;
        if (phase.title.trim().length === 0) {
          throw new Error(
            `defineWorkflow: phase at index ${i} has an empty title \u2014 every phase must have a non-empty title string`
          );
        }
      }
    }
  }
  function defineWorkflow(def) {
    validateMeta(def.meta);
    return {
      meta: def.meta,
      async run(rt, rawArgs) {
        const normalized = normalizeArgs(rawArgs);
        const input = def.parseInput !== void 0 ? def.parseInput(normalized) : normalized;
        return def.run(withPromptTags(rt), input);
      }
    };
  }
  var EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  var EFFORT_ROLE_VALUES = ["low", "medium", "high", "xhigh", "max", "auto"];
  var PER_AGENT_KEYS = ["model", "effort", "agentType", "isolation", "stallMs"];
  function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function asNonEmptyString(v, where) {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new Error(`parseConfig: ${where} must be a non-empty string, got ${JSON.stringify(v)}`);
    }
    return v;
  }
  function asEffort(v, where) {
    if (typeof v !== "string" || !EFFORTS.includes(v)) {
      throw new Error(`parseConfig: ${where} must be one of ${EFFORTS.join(", ")}, got ${JSON.stringify(v)}`);
    }
    return v;
  }
  function asEffortRoleValue(v, where) {
    if (typeof v !== "string" || !EFFORT_ROLE_VALUES.includes(v)) {
      throw new Error(`parseConfig: ${where} must be one of ${EFFORT_ROLE_VALUES.join(", ")}, got ${JSON.stringify(v)}`);
    }
    return v;
  }
  function parsePerAgent(raw) {
    if (!isRecord(raw)) throw new Error(`parseConfig: perAgent must be an object, got ${raw === null ? "null" : typeof raw}`);
    for (const key of Object.keys(raw)) {
      if (!PER_AGENT_KEYS.includes(key)) {
        throw new Error(`parseConfig: unknown perAgent key "${key}" \u2014 expected one of ${PER_AGENT_KEYS.join(", ")}`);
      }
    }
    const out = {};
    if (raw.model !== void 0) out.model = asNonEmptyString(raw.model, "perAgent.model");
    if (raw.effort !== void 0) out.effort = asEffort(raw.effort, "perAgent.effort");
    if (raw.agentType !== void 0) out.agentType = asNonEmptyString(raw.agentType, "perAgent.agentType");
    if (raw.isolation !== void 0) {
      if (raw.isolation !== "worktree") {
        throw new Error(`parseConfig: perAgent.isolation must be 'worktree' when set, got ${JSON.stringify(raw.isolation)}`);
      }
      out.isolation = "worktree";
    }
    if (raw.stallMs !== void 0) {
      const n = raw.stallMs;
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
        throw new Error(`parseConfig: perAgent.stallMs must be a positive finite number, got ${JSON.stringify(n)}`);
      }
      out.stallMs = n;
    }
    return out;
  }
  function parseStringMap(raw, where) {
    if (!isRecord(raw)) throw new Error(`parseConfig: ${where} must be an object, got ${raw === null ? "null" : typeof raw}`);
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = asNonEmptyString(v, `${where}.${k}`);
    return out;
  }
  function parseEffortMap(raw) {
    if (!isRecord(raw)) throw new Error(`parseConfig: effort must be an object, got ${raw === null ? "null" : typeof raw}`);
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = asEffortRoleValue(v, `effort.${k}`);
    return out;
  }
  function asBoolean(v, where) {
    if (typeof v !== "boolean") {
      throw new Error(`parseConfig: ${where} must be a boolean, got ${JSON.stringify(v)}`);
    }
    return v;
  }
  function parseNumberMap(raw, where) {
    if (!isRecord(raw)) throw new Error(`parseConfig: ${where} must be an object, got ${raw === null ? "null" : typeof raw}`);
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`parseConfig: ${where}.${k} must be a finite number, got ${JSON.stringify(v)}`);
      }
      out[k] = v;
    }
    return out;
  }
  function parseConfig(raw) {
    if (raw === void 0 || raw === null) return {};
    if (!isRecord(raw)) {
      throw new Error(`parseConfig: expected an object (or undefined), got ${typeof raw}`);
    }
    const config = {};
    if (raw.perAgent !== void 0) config.perAgent = parsePerAgent(raw.perAgent);
    if (raw.models !== void 0) config.models = parseStringMap(raw.models, "models");
    if (raw.effort !== void 0) config.effort = parseEffortMap(raw.effort);
    if (raw.agentTypes !== void 0) config.agentTypes = parseStringMap(raw.agentTypes, "agentTypes");
    if (raw.sizing !== void 0) config.sizing = parseNumberMap(raw.sizing, "sizing");
    if (raw.messaging !== void 0) config.messaging = asBoolean(raw.messaging, "messaging");
    return config;
  }

  // ../packages/std/src/resolve-effort.ts
  var EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
  function isEffortAlias(v) {
    return typeof v === "string" && EFFORT_ORDER.includes(v);
  }
  function resolveEffort(argsValue, stageDefault) {
    return isEffortAlias(argsValue) ? argsValue : stageDefault;
  }

  // ../packages/patterns/src/envelope.ts
  function makeRecord(stage, ok, extra) {
    return {
      stage,
      outcome: ok ? "ok" : "null",
      ...extra?.model !== void 0 ? { model: extra.model } : {},
      ...extra?.effort !== void 0 ? { effort: extra.effort } : {},
      ...extra?.decision !== void 0 ? { decision: extra.decision } : {}
    };
  }
  function collectTrail(...results) {
    const trail = [];
    for (const r of results) {
      if (r === null || r === void 0) continue;
      trail.push(...r.trail);
    }
    return trail;
  }
  function warn(rt, warnings, message) {
    warnings.push(message);
    rt.log(message);
  }
  function emitDigest(rt, d) {
    rt.log(formatDigest(d));
  }
  function applyCap(items, cap) {
    if (cap === void 0) {
      return { kept: items, truncated: 0 };
    }
    if (cap < 1) {
      throw new Error(
        `applyCap: cap must be >= 1, got ${cap} \u2014 set maxItems to a positive integer or omit it`
      );
    }
    if (cap >= items.length) {
      return { kept: items, truncated: 0 };
    }
    return {
      kept: items.slice(0, cap),
      truncated: items.length - cap
    };
  }
  function assertAgentTypeOption(stage, name, value) {
    if (value !== void 0 && value.trim().length === 0) {
      throw new Error(
        `${stage}: ${name} must be a non-empty subagent-type string (e.g. 'codex:codex-rescue') \u2014 omit it for the standard subagent`
      );
    }
  }

  // ../packages/patterns/src/chunked-analysis.ts
  var STAGE = "chunkedAnalysis";
  function chunkText(input, options) {
    const { maxChars, overlapChars = 0 } = options;
    if (!Number.isInteger(maxChars) || maxChars < 1) {
      throw new Error(
        `chunkText: maxChars must be an integer >= 1, got ${String(maxChars)}`
      );
    }
    if (!Number.isInteger(overlapChars) || overlapChars < 0) {
      throw new Error(
        `chunkText: overlapChars must be an integer >= 0, got ${String(overlapChars)}`
      );
    }
    if (overlapChars >= maxChars) {
      throw new Error(
        `chunkText: overlapChars (${overlapChars}) must be < maxChars (${maxChars}) \u2014 an overlap >= the chunk size makes no forward progress`
      );
    }
    const pieces = typeof input === "string" ? [input] : input;
    const out = [];
    for (const piece of pieces) {
      chunkOnePiece(piece, maxChars, overlapChars, out);
    }
    return out;
  }
  function chunkOnePiece(text, maxChars, overlapChars, out) {
    if (text.length === 0) return;
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxChars, text.length);
      if (end < text.length) {
        const nl = text.lastIndexOf("\n", end - 1);
        if (nl > start) end = nl + 1;
      }
      out.push(text.slice(start, end));
      if (end >= text.length) break;
      let next = end - overlapChars;
      if (next <= start) next = end;
      start = next;
    }
  }
  async function chunkedAnalysis(rt, options) {
    const {
      input,
      maxChars,
      overlapChars,
      analyzePrompt,
      analyzeSchema,
      analyzeModel,
      analyzeEffort,
      analyzeType,
      synthesizePrompt,
      synthesizeSchema,
      synthesizeModel,
      synthesizeEffort,
      synthesizeType,
      phase,
      maxChunks
    } = options;
    assertAgentTypeOption(STAGE, "analyzeType", analyzeType);
    assertAgentTypeOption(STAGE, "synthesizeType", synthesizeType);
    if (maxChunks !== void 0 && maxChunks < 1) {
      throw new Error(`chunkedAnalysis: maxChunks must be >= 1, got ${maxChunks}`);
    }
    const chunks = chunkText(input, {
      maxChars,
      ...overlapChars !== void 0 ? { overlapChars } : {}
    });
    if (chunks.length === 0) {
      throw new Error(
        "chunkedAnalysis: input produced no chunks (empty input) \u2014 provide non-empty content to analyze"
      );
    }
    let agentsSpawned = 0;
    const warnings = [];
    const trail = [];
    const { kept: keptChunks, truncated } = applyCap(chunks, maxChunks);
    const total = keptChunks.length;
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `chunkedAnalysis: ${truncated} of ${chunks.length} chunks truncated by maxChunks=${maxChunks ?? "?"}`
      );
    }
    const keptArray = keptChunks;
    const analyzeThunks = keptArray.map((chunk, i) => async () => {
      const opts = {
        label: `${STAGE}:chunk:${i}`,
        ...phase !== void 0 ? { phase } : {},
        ...analyzeSchema !== void 0 ? { schema: analyzeSchema } : {},
        ...analyzeModel !== void 0 ? { model: analyzeModel } : {},
        ...analyzeEffort !== void 0 ? { effort: analyzeEffort } : {},
        ...analyzeType !== void 0 ? { agentType: analyzeType } : {}
      };
      agentsSpawned++;
      return rt.agent(analyzePrompt(chunk, i, total), opts);
    });
    const analyzeResults = await rt.parallel(analyzeThunks);
    const chunkResults = [];
    let dropped = 0;
    for (let i = 0; i < analyzeResults.length; i++) {
      const r = analyzeResults[i];
      trail.push(makeRecord(`${STAGE}:chunk:${i}`, r !== null, {
        ...analyzeModel !== void 0 ? { model: analyzeModel } : {},
        ...analyzeEffort !== void 0 ? { effort: analyzeEffort } : {}
      }));
      if (r !== null) {
        chunkResults.push(r);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      warn(
        rt,
        warnings,
        `chunkedAnalysis: ${dropped} of ${keptArray.length} chunk analyzers returned null`
      );
    }
    let value = null;
    if (chunkResults.length === 0) {
      warn(rt, warnings, "chunkedAnalysis: every chunk analysis was null; synthesis skipped");
    } else {
      const synthOpts = {
        label: `${STAGE}:synthesize`,
        ...phase !== void 0 ? { phase } : {},
        ...synthesizeSchema !== void 0 ? { schema: synthesizeSchema } : {},
        ...synthesizeModel !== void 0 ? { model: synthesizeModel } : {},
        ...synthesizeEffort !== void 0 ? { effort: synthesizeEffort } : {},
        ...synthesizeType !== void 0 ? { agentType: synthesizeType } : {}
      };
      agentsSpawned++;
      const synthesis = await rt.agent(synthesizePrompt(chunkResults), synthOpts);
      trail.push(makeRecord(`${STAGE}:synthesize`, synthesis !== null, {
        ...synthesizeModel !== void 0 ? { model: synthesizeModel } : {},
        ...synthesizeEffort !== void 0 ? { effort: synthesizeEffort } : {}
      }));
      if (synthesis === null) {
        warn(rt, warnings, "chunkedAnalysis: synthesis agent returned null");
      } else {
        value = synthesis;
      }
    }
    const stats = {
      itemsIn: chunks.length,
      itemsOut: chunkResults.length,
      agentsSpawned,
      dropped,
      truncated
    };
    emitDigest(rt, {
      stage: STAGE,
      output: value === null ? "synthesis: none" : `synthesis from ${chunkResults.length}/${chunks.length} chunks`,
      counts: { chunks: chunks.length, analyzed: chunkResults.length, dropped, truncated }
    });
    return { value, stats, warnings, trail, chunkResults };
  }

  // log-cluster-analysis.workflow.ts
  var ANALYZE_EFFORT = "medium";
  var SYNTHESIZE_EFFORT = "high";
  var DEFAULT_MAX_CHARS = 4e3;
  var CHUNK_SCHEMA = {
    type: "object",
    properties: {
      hasErrors: { type: "boolean" },
      signatures: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", maxLength: 80 },
            count: { type: "integer", minimum: 1 }
          },
          required: ["kind", "count"],
          additionalProperties: false
        }
      }
    },
    required: ["hasErrors", "signatures"],
    additionalProperties: false
  };
  var CLUSTER_SCHEMA = {
    type: "object",
    properties: {
      clusters: {
        type: "array",
        maxItems: 30,
        items: {
          type: "object",
          properties: {
            label: { type: "string", maxLength: 120 },
            totalCount: { type: "integer", minimum: 1 }
          },
          required: ["label", "totalCount"],
          additionalProperties: false
        }
      },
      summary: { type: "string", maxLength: 2e3 }
    },
    required: ["clusters", "summary"],
    additionalProperties: false
  };
  function parseInput(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        'log-cluster-analysis: input must be an object with a "log" string \u2014 received: ' + (raw === null ? "null" : typeof raw)
      );
    }
    const obj = raw;
    if (typeof obj["log"] !== "string" || obj["log"].length === 0) {
      throw new Error(
        'log-cluster-analysis: "log" must be a non-empty string \u2014 the launcher reads the log file and passes its contents (the sandboxed workflow cannot read files itself)'
      );
    }
    let maxChars = DEFAULT_MAX_CHARS;
    if (obj["maxChars"] !== void 0) {
      if (typeof obj["maxChars"] !== "number" || !Number.isInteger(obj["maxChars"]) || obj["maxChars"] < 1) {
        throw new Error('log-cluster-analysis: "maxChars" must be an integer >= 1');
      }
      maxChars = obj["maxChars"];
    }
    let overlapChars = 0;
    if (obj["overlapChars"] !== void 0) {
      if (typeof obj["overlapChars"] !== "number" || !Number.isInteger(obj["overlapChars"]) || obj["overlapChars"] < 0) {
        throw new Error('log-cluster-analysis: "overlapChars" must be an integer >= 0');
      }
      overlapChars = obj["overlapChars"];
    }
    if (overlapChars >= maxChars) {
      throw new Error(
        `log-cluster-analysis: "overlapChars" (${overlapChars}) must be < "maxChars" (${maxChars})`
      );
    }
    let maxChunks = null;
    if (obj["maxChunks"] !== void 0) {
      if (typeof obj["maxChunks"] !== "number" || !Number.isInteger(obj["maxChunks"]) || obj["maxChunks"] < 1) {
        throw new Error('log-cluster-analysis: "maxChunks" must be an integer >= 1');
      }
      maxChunks = obj["maxChunks"];
    }
    const effort = parseConfig(obj).effort ?? null;
    return { log: obj["log"], maxChars, overlapChars, maxChunks, effort };
  }
  async function run(rt, input) {
    const analyzeEffort = resolveEffort(input.effort?.["analyze"], ANALYZE_EFFORT);
    const synthesizeEffort = resolveEffort(input.effort?.["synthesize"], SYNTHESIZE_EFFORT);
    rt.phase("Analyze");
    const analysis = await chunkedAnalysis(rt, {
      input: input.log,
      maxChars: input.maxChars,
      overlapChars: input.overlapChars,
      ...input.maxChunks !== null ? { maxChunks: input.maxChunks } : {},
      analyzeSchema: CHUNK_SCHEMA,
      analyzeEffort,
      analyzePrompt: (chunk, index, total) => `You are analyzing chunk ${index + 1} of ${total} of a larger log.
Identify distinct ERROR/exception signatures in THIS chunk only.
First decide whether this chunk contains any errors at all (hasErrors).
If it does, list each distinct signature as a short "kind" label plus how many times it appears in this chunk. Do NOT invent signatures \u2014 if there are none, return hasErrors=false and an empty signatures array.

--- chunk ${index + 1}/${total} ---
${chunk}`,
      synthesizeSchema: CLUSTER_SCHEMA,
      synthesizeEffort,
      synthesizePrompt: (chunkReports) => `Merge these per-chunk error findings into clusters across the WHOLE log.
Group signatures that are the same underlying error, sum their counts into totalCount, and give each cluster a concise label. Then write a short summary of the dominant failure modes.

Per-chunk findings (JSON):
${JSON.stringify(chunkReports)}`,
      phase: "Analyze"
    });
    rt.phase("Report");
    return {
      report: analysis.value,
      chunksAnalyzed: analysis.stats.itemsOut,
      chunksTotal: analysis.stats.itemsIn,
      dropped: analysis.stats.dropped,
      truncated: analysis.stats.truncated,
      envelope: { trail: collectTrail(analysis) },
      warnings: analysis.warnings
    };
  }
  var log_cluster_analysis_workflow_default = defineWorkflow({
    meta: {
      name: "log-cluster-analysis",
      description: "Clusters the error signatures in an oversized log by chunking the text deterministically, analyzing each chunk in parallel for error signatures, then synthesizing the per-chunk findings into cross-log clusters with counts and a summary.",
      whenToUse: "Use when a log (or any large text) is too big for a single agent context and you need a map-analyze-then-synthesize pass \u2014 e.g. finding error clusters, extracting entities, or summarizing a huge diff. The launcher passes the text as args.log.",
      phases: [
        { title: "Analyze", detail: "Chunk the log, analyze each chunk in parallel, synthesize clusters" },
        { title: "Report", detail: "Surface the clustered report with honest chunk/drop/truncate counts" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(log_cluster_analysis_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

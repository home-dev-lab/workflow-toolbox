export const meta = {
  "name": "pr-review",
  "description": "Multi-lens code review of a change set: classifies the change, spawns specialized reviewers, adversarially verifies findings, and synthesizes a verdict.",
  "whenToUse": "Use when you need a structured, adversarially-verified code review of a git ref range or change description. Pass mode: \"single-verifier\" for the quota-degraded proportionate-review rung (one consolidated reviewer instead of one per lens); the ladder's bottom rung (\"diff-read\": read the diff yourself, no findings to verify) is not a mode this workflow accepts — don't launch it for that case.",
  "phases": [
    {
      "title": "Fence",
      "detail": "Resolve the default leaf-agent fence (SendMessage denied by default) and the lean-routing default for the pure Synthesize stage"
    },
    {
      "title": "Probe",
      "detail": "Resolve the requested reviewer agentType (graceful Claude fallback)"
    },
    {
      "title": "Route",
      "detail": "Classify the change and produce a targeted summary"
    },
    {
      "title": "Review",
      "detail": "Spawn specialized reviewer agents per lens"
    },
    {
      "title": "Verify",
      "detail": "Adversarially verify each finding (fresh-evidence check)"
    },
    {
      "title": "Synthesize",
      "detail": "Produce an overall verdict from verified findings"
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

  // pr-review.workflow.ts
  var pr_review_workflow_exports = {};
  __export(pr_review_workflow_exports, {
    default: () => pr_review_workflow_default
  });

  // ../packages/runtime/src/constants.ts
  var BEST_MODEL = "opus";

  // ../packages/runtime/src/digest.ts
  var DIGEST_PREFIX = "[wt:digest]";
  function formatDigest(d) {
    const body = { stage: d.stage };
    if (d.phase !== void 0) body.phase = d.phase;
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

  // ../packages/runtime/src/with-agent-defaults.ts
  function withAgentDefaults(rt, defaults) {
    const agent = (prompt, opts) => rt.agent(prompt, { ...defaults, ...opts });
    return {
      agent,
      parallel: rt.parallel,
      pipeline: rt.pipeline,
      phase: (title) => rt.phase(title),
      log: (message) => rt.log(message),
      budget: rt.budget,
      workflow: rt.workflow
    };
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
  function resolveVerifierEffort(argsValue, stageDefault, floor = "high") {
    const safeFloor = isEffortAlias(floor) ? floor : "high";
    const resolved = resolveEffort(argsValue, stageDefault);
    return EFFORT_ORDER.indexOf(resolved) >= EFFORT_ORDER.indexOf(safeFloor) ? resolved : safeFloor;
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

  // ../packages/patterns/src/probe-agent-type.ts
  var STAGE = "probeAgentType";
  var DEFAULT_PROBE_PROMPT = "Availability probe. This is a REAL task: execute your normal procedure end-to-end (availability gate, then run the task through your external CLI \u2014 do NOT answer from your own knowledge). Task: reply with exactly: PROBE_OK";
  var DEFAULT_EXPECTED_TOKEN = "PROBE_OK";
  var LOCAL_AGENT_PROBE_PROMPT = "Availability probe. This task is fully self-contained: it needs no tools and no lookup \u2014 answering directly from this prompt is the correct procedure. Task: reply with exactly: PROBE_OK";
  var REASON_HEAD_CHARS = 200;
  function stripAnsi(text) {
    return text.replace(/\u001b?\[[0-9;]*m/g, "");
  }
  function head(text) {
    const t = text.trim();
    return t.length > REASON_HEAD_CHARS ? `${t.slice(0, REASON_HEAD_CHARS)}\u2026` : t;
  }
  function escapeRegExp(literal) {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  async function probeAgentType(rt, agentType, options = {}) {
    const { phase, probePrompt, expectedToken } = options;
    assertAgentTypeOption(STAGE, "agentType", agentType);
    if (expectedToken !== void 0 && expectedToken.trim().length === 0) {
      throw new Error(
        `${STAGE}: expectedToken must be a non-empty string \u2014 omit it for the default 'PROBE_OK'`
      );
    }
    const token = expectedToken ?? DEFAULT_EXPECTED_TOKEN;
    const prompt = probePrompt ?? DEFAULT_PROBE_PROMPT;
    let reply;
    let spawnError = null;
    try {
      reply = await rt.agent(prompt, {
        label: `${STAGE}:probe`,
        agentType,
        ...phase !== void 0 ? { phase } : {}
      });
    } catch (e) {
      reply = null;
      spawnError = head(e instanceof Error ? e.message : String(e));
    }
    let available = false;
    let reason = null;
    if (reply === null) {
      reason = spawnError ?? "probe agent returned null";
    } else if (typeof reply !== "string") {
      reason = "non-string probe reply";
    } else {
      const stripped = stripAnsi(reply).trim();
      const endsWithToken = new RegExp(`${escapeRegExp(token)}\\s*[.!]?$`).test(stripped);
      if (stripped.includes("UNAVAILABLE")) {
        const marker = /\S*UNAVAILABLE[\s\S]*/.exec(stripped);
        reason = head(marker ? marker[0] : stripped);
      } else if (endsWithToken) {
        available = true;
      } else {
        reason = `unexpected probe reply: ${head(stripped)}`;
      }
    }
    if (available) {
      rt.log(`${STAGE}: '${agentType}' available \u2014 routing externally`);
    } else {
      rt.log(
        `${STAGE}: '${agentType}' unavailable \u2014 falling back to the standard subagent (${reason ?? "unknown"})`
      );
    }
    emitDigest(rt, {
      stage: STAGE,
      ...phase !== void 0 ? { phase } : {},
      output: available ? `available: ${agentType}` : "fallback: standard subagent"
    });
    return {
      agentType: available ? agentType : void 0,
      available,
      reason
    };
  }

  // ../packages/patterns/src/leaf-fence.ts
  var LEAF_AGENT_TYPE = "workflow-toolbox:leaf";
  var FENCE_UNAVAILABLE_MESSAGE = "fence UNAVAILABLE \u2014 leaves run with SendMessage enabled this run";
  async function withLeafFence(rt, options = {}) {
    const { phase, agentType = LEAF_AGENT_TYPE, disabled = false, perAgent } = options;
    if (disabled) {
      return { rt, report: { resolvedAgentType: null, probe: null } };
    }
    const probeRt = perAgent !== void 0 ? withAgentDefaults(rt, perAgent) : rt;
    const probe = await probeAgentType(probeRt, agentType, {
      probePrompt: LOCAL_AGENT_PROBE_PROMPT,
      ...phase !== void 0 ? { phase } : {}
    });
    const defaults = probe.agentType !== void 0 ? { agentType: probe.agentType } : {};
    if (probe.agentType === void 0) {
      rt.log(`[leaf-fence] \u26A0 ${FENCE_UNAVAILABLE_MESSAGE} (requested: ${agentType}; reason: ${probe.reason ?? "unknown"})`);
    }
    return {
      rt: withAgentDefaults(rt, defaults),
      report: {
        resolvedAgentType: probe.agentType ?? null,
        probe: { requested: agentType, available: probe.available, reason: probe.reason }
      }
    };
  }

  // ../packages/patterns/src/lean-routing.ts
  var LEAN_AGENT_TYPE = "workflow-toolbox:lean";
  var ROUTING_UNAVAILABLE_MESSAGE = "routing UNAVAILABLE \u2014 calls through this runtime keep the FULL ambient context this run (no lean savings)";
  async function withLeanRouting(rt, options = {}) {
    const { phase, agentType = LEAN_AGENT_TYPE, disabled = false, perAgent } = options;
    if (disabled) {
      return { rt, report: { resolvedAgentType: null, probe: null } };
    }
    const probeRt = perAgent !== void 0 ? withAgentDefaults(rt, perAgent) : rt;
    const probe = await probeAgentType(probeRt, agentType, {
      probePrompt: LOCAL_AGENT_PROBE_PROMPT,
      ...phase !== void 0 ? { phase } : {}
    });
    const defaults = probe.agentType !== void 0 ? { agentType: probe.agentType } : {};
    if (probe.agentType === void 0) {
      rt.log(`[lean-routing] \u26A0 ${ROUTING_UNAVAILABLE_MESSAGE} (requested: ${agentType}; reason: ${probe.reason ?? "unknown"})`);
    }
    return {
      rt: withAgentDefaults(rt, defaults),
      report: {
        resolvedAgentType: probe.agentType ?? null,
        probe: { requested: agentType, available: probe.available, reason: probe.reason }
      }
    };
  }

  // ../packages/patterns/src/cache-warm.ts
  var WARMUP_PROMPT = "Reply with a single word: ready.";
  function offsetStages(stages, offset) {
    return stages.map(
      (stage) => (prev, originalItem, localIndex) => stage(prev, originalItem, localIndex + offset)
    );
  }
  async function pipelineWithCacheWarm(rt, items, stages, enabled) {
    if (!enabled || items.length <= 1) {
      return rt.pipeline(items, ...stages);
    }
    const [first, ...rest] = items;
    const firstResult = await rt.pipeline([first], ...offsetStages(stages, 0));
    const restResults = await rt.pipeline(rest, ...offsetStages(stages, 1));
    return [...firstResult, ...restResults];
  }
  async function runCacheWarmup(rt, warnings, label, patternName, opts) {
    const agentOpts = {
      label,
      ...opts.phase !== void 0 ? { phase: opts.phase } : {},
      ...opts.model !== void 0 ? { model: opts.model } : {},
      ...opts.effort !== void 0 ? { effort: opts.effort } : {},
      ...opts.agentType !== void 0 ? { agentType: opts.agentType } : {}
    };
    const result = await rt.agent(WARMUP_PROMPT, agentOpts);
    if (result === null) {
      warn(
        rt,
        warnings,
        `${patternName}: cache-warm agent (${label}) returned null \u2014 proceeding without a warmed cache`
      );
    }
    return makeRecord(label, result !== null, {
      ...opts.model !== void 0 ? { model: opts.model } : {},
      ...opts.effort !== void 0 ? { effort: opts.effort } : {}
    });
  }

  // ../packages/patterns/src/classify-and-act.ts
  var STAGE2 = "classifyAndAct";
  async function classifyAndAct(rt, options) {
    const { items, categories, classifyPrompt, actions, classifyModel, classifyEffort, classifyType, phase, maxItems, cacheWarm } = options;
    if (categories.length === 0) {
      throw new Error("classifyAndAct: categories must not be empty \u2014 provide at least one category");
    }
    const seen = /* @__PURE__ */ new Set();
    for (const cat of categories) {
      if (seen.has(cat)) {
        throw new Error(
          `classifyAndAct: duplicate category "${cat}" \u2014 each category must appear exactly once`
        );
      }
      seen.add(cat);
    }
    const missingFromActions = categories.filter((cat) => !(cat in actions));
    if (missingFromActions.length > 0) {
      throw new Error(
        `classifyAndAct: ${missingFromActions.map((c) => `category "${c}"`).join(", ")} ${missingFromActions.length === 1 ? "has" : "have"} no action \u2014 add an entry to options.actions or remove the category`
      );
    }
    assertAgentTypeOption(STAGE2, "classifyType", classifyType);
    for (const [category, spec] of Object.entries(actions)) {
      assertAgentTypeOption(STAGE2, `actions.${category}.agentType`, spec.agentType);
    }
    const { kept, truncated } = applyCap(items, maxItems);
    let agentsSpawned = 0;
    let classifyFailures = 0;
    let actionFailures = 0;
    const warnings = [];
    const pendingTrail = [];
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `classifyAndAct: ${truncated} of ${items.length} items truncated by maxItems=${maxItems ?? "?"}`
      );
    }
    const controlSchema = {
      type: "object",
      properties: {
        category: { type: "string", enum: [...categories] }
      },
      required: ["category"],
      additionalProperties: false
    };
    const classifyStage = async (_prev, originalItem, index) => {
      const item = originalItem;
      const classifyOpts = {
        schema: controlSchema,
        label: `${STAGE2}:classify:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...classifyModel !== void 0 ? { model: classifyModel } : {},
        ...classifyEffort !== void 0 ? { effort: classifyEffort } : {},
        ...classifyType !== void 0 ? { agentType: classifyType } : {}
      };
      agentsSpawned++;
      const classified = await rt.agent(classifyPrompt(item), classifyOpts);
      if (classified === null) {
        classifyFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0,
          record: makeRecord(`${STAGE2}:classify:${index}`, false, {
            ...classifyModel !== void 0 ? { model: classifyModel } : {},
            ...classifyEffort !== void 0 ? { effort: classifyEffort } : {}
          })
        });
        throw new Error("classify returned null");
      }
      if (!(classified.category in actions)) {
        classifyFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0,
          record: makeRecord(`${STAGE2}:classify:${index}`, false, {
            ...classifyModel !== void 0 ? { model: classifyModel } : {},
            ...classifyEffort !== void 0 ? { effort: classifyEffort } : {}
          })
        });
        throw new Error(`classify returned unknown category "${classified.category}"`);
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`${STAGE2}:classify:${index}`, true, {
          ...classifyModel !== void 0 ? { model: classifyModel } : {},
          ...classifyEffort !== void 0 ? { effort: classifyEffort } : {},
          decision: classified.category
        })
      });
      return { item, category: classified.category };
    };
    const actStage = async (prev, _originalItem, index) => {
      const { item, category } = prev;
      const spec = actions[category];
      if (spec === void 0) {
        classifyFailures++;
        throw new Error(`no action for category "${category}"`);
      }
      const actOpts = {
        label: `${STAGE2}:act:${category}:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...spec.schema !== void 0 ? { schema: spec.schema } : {},
        ...spec.model !== void 0 ? { model: spec.model } : {},
        ...spec.effort !== void 0 ? { effort: spec.effort } : {},
        ...spec.agentType !== void 0 ? { agentType: spec.agentType } : {}
      };
      agentsSpawned++;
      const result = await rt.agent(spec.prompt(item), actOpts);
      if (result === null) {
        actionFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 1,
          record: makeRecord(`${STAGE2}:act:${category}:${index}`, false, {
            ...spec.model !== void 0 ? { model: spec.model } : {},
            ...spec.effort !== void 0 ? { effort: spec.effort } : {}
          })
        });
        throw new Error("act returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(`${STAGE2}:act:${category}:${index}`, true, {
          ...spec.model !== void 0 ? { model: spec.model } : {},
          ...spec.effort !== void 0 ? { effort: spec.effort } : {}
        })
      });
      return { item, category, result };
    };
    const rawResults = await pipelineWithCacheWarm(
      rt,
      kept,
      [classifyStage, actStage],
      cacheWarm ?? true
    );
    const value = rawResults.filter(
      (r) => r !== null
    );
    if (classifyFailures > 0) {
      warn(
        rt,
        warnings,
        `classifyAndAct: ${classifyFailures} of ${kept.length} items failed classification`
      );
    }
    if (actionFailures > 0) {
      warn(
        rt,
        warnings,
        `classifyAndAct: ${actionFailures} items failed their action`
      );
    }
    const stats = {
      itemsIn: items.length,
      itemsOut: value.length,
      agentsSpawned,
      dropped: kept.length - value.length,
      truncated
    };
    pendingTrail.sort(
      (a, b) => a.itemIndex !== b.itemIndex ? a.itemIndex - b.itemIndex : a.stageOrder - b.stageOrder
    );
    const trail = pendingTrail.map((e) => e.record);
    const allCategories = [...categories];
    const chosen = new Set(value.map((r) => r.category));
    emitDigest(rt, {
      stage: STAGE2,
      ...phase !== void 0 ? { phase } : {},
      taken: allCategories.filter((c) => chosen.has(c)),
      notTaken: allCategories.filter((c) => !chosen.has(c)),
      counts: { in: items.length, out: value.length }
    });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/adversarial-verification.ts
  var STAGE3 = "adversarialVerification";
  var VERIFIER_SCHEMA = {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["confirmed", "partially-confirmed", "refuted", "unverifiable"]
      },
      reason: { type: "string" }
    },
    required: ["verdict", "reason"],
    additionalProperties: false
  };
  async function adversarialVerification(rt, options) {
    const {
      claims,
      renderClaim,
      votes: votesOpt = 3,
      refuteThreshold: refuteThresholdOpt,
      lenses,
      votesPerClaim,
      model,
      effort,
      phase,
      maxVerifyClaims,
      verifierType,
      cacheWarm
    } = options;
    const refuteThreshold = refuteThresholdOpt ?? 2;
    if (claims.length === 0) {
      throw new Error(
        "adversarialVerification: empty claims \u2014 provide at least one claim to verify"
      );
    }
    if (votesOpt < 1) {
      throw new Error(
        `adversarialVerification: votes must be >= 1, got ${votesOpt}`
      );
    }
    if (refuteThreshold < 1) {
      throw new Error(
        `adversarialVerification: refuteThreshold must be >= 1, got ${refuteThreshold}`
      );
    }
    if (votesPerClaim === void 0 && refuteThreshold > votesOpt) {
      throw new Error(
        `adversarialVerification: refuteThreshold (${refuteThreshold}) must not be > votes (${votesOpt})`
      );
    }
    if (lenses !== void 0 && lenses.length !== votesOpt) {
      throw new Error(
        `adversarialVerification: lenses.length (${lenses.length}) must equal votes (${votesOpt}) \u2014 each lens corresponds to one vote`
      );
    }
    if (lenses !== void 0 && votesPerClaim !== void 0) {
      throw new Error(
        "adversarialVerification: lenses cannot be combined with votesPerClaim \u2014 lenses require a fixed votes count (one lens per vote); use one or the other"
      );
    }
    const perClaimVotes = claims.map((claim, i) => {
      if (votesPerClaim === void 0) return votesOpt;
      const n = votesPerClaim(claim);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(
          `adversarialVerification: votesPerClaim(claims[${i}]) returned ${String(n)} \u2014 must be an integer >= 1`
        );
      }
      return n;
    });
    if (verifierType !== void 0 && verifierType.trim().length === 0) {
      throw new Error(
        'adversarialVerification: verifierType must be a non-empty subagent-type string (e.g. "magic-claude:ts-reviewer") \u2014 omit it for the standard subagent'
      );
    }
    if (maxVerifyClaims !== void 0 && maxVerifyClaims < 1) {
      throw new Error(
        `adversarialVerification: maxVerifyClaims must be >= 1, got ${maxVerifyClaims}`
      );
    }
    let agentsSpawned = 0;
    const warnings = [];
    const trail = [];
    const effectiveModel = model ?? BEST_MODEL;
    if (model !== void 0 && model !== BEST_MODEL) {
      warn(
        rt,
        warnings,
        `adversarialVerification: verifier model downgraded to "${model}" \u2014 verification quality is model-sensitive`
      );
    }
    const { kept: keptClaims, truncated } = applyCap(claims, maxVerifyClaims);
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `adversarialVerification: ${truncated} of ${claims.length} claims truncated by maxVerifyClaims=${maxVerifyClaims ?? "?"} \u2014 kept as unverified-by-cap`
      );
    }
    function buildVerifierPrompt(claim, lens) {
      const lensLine = lens !== void 0 ? `
Examine it through the lens of: ${lens}.` : "";
      return `Adversarially verify the following claim. Actively try to REFUTE it; default to "refuted" when uncertain.` + lensLine + `
Claim:
${renderClaim(claim)}`;
    }
    if (cacheWarm ?? true) {
      agentsSpawned++;
      trail.push(await runCacheWarmup(rt, warnings, `${STAGE3}:warm`, STAGE3, {
        ...phase !== void 0 ? { phase } : {},
        model: effectiveModel,
        ...effort !== void 0 ? { effort } : {},
        ...verifierType !== void 0 ? { agentType: verifierType } : {}
      }));
    }
    const trailByClaim = [];
    const verifiedKept = await Promise.all(
      keptClaims.map(async (claim, claimIndex) => {
        const claimVotes = perClaimVotes[claimIndex] ?? votesOpt;
        const voteThunks = Array.from({ length: claimVotes }, (_, voteIndex) => {
          return async () => {
            const lens = lenses !== void 0 ? lenses[voteIndex] : void 0;
            const prompt = buildVerifierPrompt(claim, lens);
            const opts = {
              schema: VERIFIER_SCHEMA,
              label: `${STAGE3}:verify:${claimIndex}:${voteIndex}`,
              ...phase !== void 0 ? { phase } : {},
              model: effectiveModel,
              ...effort !== void 0 ? { effort } : {},
              ...verifierType !== void 0 ? { agentType: verifierType } : {}
            };
            agentsSpawned++;
            return rt.agent(prompt, opts);
          };
        });
        const rawVotes = await rt.parallel(voteThunks);
        const votes = rawVotes.map(
          (v) => v
        );
        const claimRecords = [];
        for (let voteIndex = 0; voteIndex < votes.length; voteIndex++) {
          const vote = votes[voteIndex] ?? null;
          claimRecords.push(makeRecord(
            `${STAGE3}:verify:${claimIndex}:${voteIndex}`,
            vote !== null,
            {
              model: effectiveModel,
              ...effort !== void 0 ? { effort } : {},
              ...vote !== null ? { decision: vote.verdict } : {}
            }
          ));
        }
        trailByClaim[claimIndex] = claimRecords;
        const nonNull = votes.filter((v) => v !== null);
        const effectiveThreshold = Math.min(refuteThreshold, claimVotes);
        let verdict;
        if (nonNull.length === 0) {
          verdict = "unverifiable";
        } else if (nonNull.filter((v) => v.verdict === "refuted").length >= effectiveThreshold) {
          verdict = "refuted";
        } else if (nonNull.every((v) => v.verdict === "confirmed")) {
          verdict = "confirmed";
        } else {
          verdict = "partially-confirmed";
        }
        return { claim, verdict, votes };
      })
    );
    trail.push(...trailByClaim.flat());
    const truncatedClaims = claims.slice(keptClaims.length).map((claim) => ({ claim, verdict: "unverified-by-cap", votes: [] }));
    const value = [...verifiedKept, ...truncatedClaims];
    let nullVoteCount = 0;
    let allNullClaimsCount = 0;
    for (const verified of verifiedKept) {
      const nullsInClaim = verified.votes.filter((v) => v === null).length;
      nullVoteCount += nullsInClaim;
      if (nullsInClaim === verified.votes.length) {
        allNullClaimsCount++;
      }
    }
    if (nullVoteCount > 0) {
      warn(
        rt,
        warnings,
        `adversarialVerification: ${nullVoteCount} verifier votes returned null across ${verifiedKept.length} claims`
      );
    }
    if (allNullClaimsCount > 0) {
      warn(
        rt,
        warnings,
        `adversarialVerification: ${allNullClaimsCount} claims left unverifiable (all verifiers failed)`
      );
    }
    const stats = {
      itemsIn: claims.length,
      itemsOut: claims.length,
      // claims never dropped — always equal
      agentsSpawned,
      dropped: nullVoteCount,
      // null votes = lost work units
      truncated
    };
    const DIGEST_KEY = {
      confirmed: "confirmed",
      refuted: "refuted",
      "partially-confirmed": "partiallyConfirmed",
      unverifiable: "unverifiable",
      "unverified-by-cap": "unverifiedByCap"
    };
    const counts = {
      claims: claims.length,
      confirmed: 0,
      refuted: 0,
      partiallyConfirmed: 0,
      unverifiable: 0,
      unverifiedByCap: 0
    };
    for (const verdict of Object.keys(DIGEST_KEY)) {
      counts[DIGEST_KEY[verdict]] = value.filter((v) => v.verdict === verdict).length;
    }
    emitDigest(rt, { stage: STAGE3, ...phase !== void 0 ? { phase } : {}, counts });
    return { value, stats, warnings, trail };
  }

  // docs-provenance.ts
  var DOCS_PROVENANCE = [
    {
      // AgentType probing + the leaf fence + lean routing (availability gates,
      // probe prompts, graceful degradation semantics).
      sources: [
        "toolkit/packages/patterns/src/probe-agent-type.ts",
        "toolkit/packages/patterns/src/leaf-fence.ts",
        "toolkit/packages/patterns/src/lean-routing.ts",
        "plugin/agents/"
      ],
      docs: [
        "plugin/skills/workflow-composer/references/model-and-agent-routing.md",
        "plugin/skills/workflow-composer/SKILL.md"
      ]
    },
    {
      // The nine patterns + the result envelope (options, caps, envelope shape,
      // pattern count claims).
      sources: ["toolkit/packages/patterns/src/"],
      docs: [
        "plugin/skills/workflow-composer/references/patterns.md",
        "toolkit/README.md",
        "README.md"
      ]
    },
    {
      // Digest + prompt-tag wire protocols (what the observatory parses; the
      // reload-only semantics known-issues documents).
      sources: [
        "toolkit/packages/runtime/src/digest.ts",
        "toolkit/packages/runtime/src/prompt-tag.ts"
      ],
      docs: [
        "docs/public/known-issues.md",
        "plugin/skills/workflow-composer/references/observing-runs.md"
      ]
    },
    {
      // Runtime contract: sandbox typings, model/effort aliases, BEST_MODEL.
      sources: [
        "toolkit/packages/runtime/src/types.ts",
        "toolkit/packages/runtime/src/constants.ts",
        "toolkit/packages/runtime/src/with-agent-defaults.ts"
      ],
      docs: [
        "plugin/skills/workflow-composer/references/model-and-agent-routing.md",
        "plugin/skills/workflow-composer/references/api-reference.md"
      ]
    },
    {
      // Workflow linter rules + size cap (what "compliant artifact" means).
      sources: ["toolkit/packages/build/src/lint.ts"],
      docs: [
        "plugin/skills/workflow-composer/references/api-reference.md",
        "CLAUDE.md"
      ]
    },
    {
      // defineWorkflow / bundler / CLI (the authoring pipeline and its contract).
      sources: [
        "toolkit/packages/build/src/define-workflow.ts",
        "toolkit/packages/build/src/bundle.ts",
        "toolkit/packages/build/src/cli.ts"
      ],
      docs: [
        "plugin/skills/workflow-composer/SKILL.md",
        "toolkit/README.md",
        "README.md"
      ]
    },
    {
      // Orchestrator pipelines (definePipeline / bundlePipeline / PipelineSpec).
      sources: [
        "toolkit/packages/build/src/define-pipeline.ts",
        "toolkit/packages/build/src/bundle-pipeline.ts",
        "toolkit/packages/pipeline-spec/"
      ],
      docs: ["plugin/skills/workflow-composer/references/orchestrator-pipelines.md"]
    },
    {
      // Scaffold emitter (what `wt:scaffold` generates, PATTERN_NAMES).
      sources: ["toolkit/packages/scaffold/src/"],
      docs: [
        "plugin/skills/toolkit-scaffold/SKILL.md",
        "plugin/skills/workflow-composer/SKILL.md"
      ]
    },
    {
      // Run forensics (journal/transcript parsing, tool-denial detection).
      sources: ["toolkit/packages/debugger/src/"],
      docs: [
        "plugin/skills/workflow-debugger/SKILL.md",
        "docs/public/known-issues.md"
      ]
    },
    {
      // Smoke / canaries (the upgrade re-verification story).
      sources: ["toolkit/packages/smoke/src/"],
      docs: ["plugin/skills/upgrade-canary/SKILL.md"]
    },
    {
      // The pr-review composition itself (its worked example + the shipped list).
      sources: ["toolkit/examples/pr-review.workflow.ts"],
      docs: [
        "plugin/skills/workflow-composer/references/worked-example-pr-review.md",
        "plugin/skills/workflow-composer/references/shipped-compositions.md"
      ]
    },
    {
      // Every other shipped composition (the catalog doc + the dev-workflow story).
      sources: ["toolkit/examples/"],
      docs: [
        "plugin/skills/workflow-composer/references/shipped-compositions.md",
        "docs/public/dev-workflow.md"
      ]
    }
  ];
  function docsForChangedFiles(changedFiles, manifest = DOCS_PROVENANCE) {
    const out = [];
    for (const entry of manifest) {
      const touched = changedFiles.some(
        (f) => entry.sources.some(
          (source) => source.endsWith("/") ? f.startsWith(source) : f === source
        )
      );
      if (!touched) continue;
      for (const doc of entry.docs) if (!out.includes(doc)) out.push(doc);
    }
    return out;
  }

  // pr-review.workflow.ts
  var CLASSIFY_EFFORT = "low";
  var ROUTE_ACT_EFFORT = "medium";
  var REVIEW_EFFORT = "high";
  var VERIFY_EFFORT_DEFAULT = "high";
  var SYNTHESIZE_EFFORT = "medium";
  var CHANGE_SUMMARY_SCHEMA = {
    type: "object",
    properties: {
      summary: { type: "string", minLength: 12, maxLength: 1200 },
      riskAreas: { type: "array", items: { type: "string" } },
      // Repo-relative changed paths (`git diff --name-only <range>`). The
      // DECISION on this data is mechanical (deterministic path matching against
      // the committed docs-provenance manifest → docs-alignment lens on/off),
      // but the DATA is agent-reported from the real diff, not independently
      // verified — the script has no fs/git access to cross-check it.
      // maxItems is a schema-level runaway bound, not a truncation license — an
      // agent that lists fewer files only under-triggers the lens (the Tier 1
      // docs-contract gate still guards the anchors mechanically), and an EMPTY
      // list on a range-shaped target trips the degenerate-output warning below.
      changedFiles: { type: "array", items: { type: "string" }, maxItems: 200 },
      // NEW public surface this change ADDS (exports, HTTP routes, env vars,
      // CLI verbs/flags, config knobs) — the docs-coverage lens's arming
      // signal. Same trust posture as changedFiles: the DECISION is mechanical
      // script code, the DATA is agent-reported from the real diff. An empty
      // array is schema-valid ("nothing new exposed"), so a capitulating agent
      // only UNDER-arms the lens — the repos' inverse docs-contract gates
      // still hold the enumerable classes mechanically.
      addedPublicSurface: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 40 }
    },
    required: ["summary", "riskAreas", "changedFiles", "addedPublicSurface"],
    additionalProperties: false
  };
  var CHANGE_SUMMARY_RULES = 'All four fields are REQUIRED. Emit "changedFiles" FIRST (the repo-relative paths from `git diff --name-only <range>`, up to 200), then "addedPublicSurface" \u2014 ONLY the NEW public surface this change ADDS (new exports, HTTP routes, env vars, CLI verbs/flags, config knobs), one short entry each, e.g. "export: parsePipelineSpec" or "env var: SERVER_TTL"; an EMPTY array when the change exposes nothing new \u2014 then "riskAreas", then "summary" \u2014 at most 500 characters (the schema rejects longer). Never satisfy the schema with placeholder values ("test", "a"); if a field is hard to fill, shorten it \u2014 do not fake it.';
  var FINDINGS_SCHEMA = {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            file: { type: "string" },
            severity: { type: "string", enum: ["high", "medium", "low"] },
            detail: { type: "string" }
          },
          required: ["title", "file", "severity", "detail"],
          additionalProperties: false
        }
      }
    },
    required: ["findings"],
    additionalProperties: false
  };
  var SYNTHESIS_SCHEMA = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "request-changes"] },
      summary: { type: "string" }
    },
    required: ["verdict", "summary"],
    additionalProperties: false
  };
  var READ_ONLY_GIT = "Inspect via READ-ONLY git only \u2014 `git show <sha>:<path>`, `git diff <range>`, `git log` \u2014 NEVER `git checkout` / `git reset` / `git restore` / `git clean` (they mutate the shared working tree and will be denied).";
  var REVIEWER_LENSES = {
    bugfix: ["root-cause", "regression-risk", "test-coverage", "maintainability"],
    feature: ["correctness", "security", "api-design", "maintainability"],
    refactor: ["behavioral-equivalence", "test-coverage", "readability", "maintainability"],
    config: ["correctness", "security", "blast-radius", "maintainability"],
    docs: ["accuracy", "completeness", "clarity"]
  };
  var DEFAULT_LENSES = ["correctness", "security", "test-coverage", "maintainability"];
  var CONSOLIDATED_LENS = "consolidated";
  var MAX_PROVENANCE_ENTRIES = 64;
  var MAX_PROVENANCE_PATHS_PER_FIELD = 32;
  var MAX_PROVENANCE_PATH_LENGTH = 300;
  var PROVENANCE_PATH_RE = /^[^`\u0000-\u001f\u007f]+$/;
  function parseProvenance(raw) {
    if (raw === void 0 || raw === null) return null;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(
        'pr-review: "provenance" must be a NON-EMPTY array of { sources, docs } entries \u2014 omit it entirely to use the bundled dwt manifest'
      );
    }
    if (raw.length > MAX_PROVENANCE_ENTRIES) {
      throw new Error(
        `pr-review: "provenance" has ${raw.length} entries \u2014 the cap is ${MAX_PROVENANCE_ENTRIES}`
      );
    }
    return raw.map((entry, i) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `pr-review: provenance[${i}] must be an object with "sources" and "docs" string arrays`
        );
      }
      const e = entry;
      for (const field of ["sources", "docs"]) {
        const v = e[field];
        if (!Array.isArray(v) || v.length === 0 || v.some((s) => typeof s !== "string" || s.trim().length === 0)) {
          throw new Error(
            `pr-review: provenance[${i}].${field} must be a non-empty array of non-empty strings (repo-relative paths; a path ending in "/" covers its subtree, otherwise exact file match)`
          );
        }
        if (v.length > MAX_PROVENANCE_PATHS_PER_FIELD) {
          throw new Error(
            `pr-review: provenance[${i}].${field} has ${v.length} paths \u2014 the cap is ${MAX_PROVENANCE_PATHS_PER_FIELD}`
          );
        }
        for (const s of v) {
          if (s.length > MAX_PROVENANCE_PATH_LENGTH || !PROVENANCE_PATH_RE.test(s)) {
            throw new Error(
              `pr-review: provenance[${i}].${field} contains "${s.slice(0, 60)}\u2026" \u2014 each path must be \u2264 ${MAX_PROVENANCE_PATH_LENGTH} chars with no backticks or control characters`
            );
          }
        }
      }
      return { sources: e["sources"], docs: e["docs"] };
    });
  }
  var ALLOWED_MODES = ["full", "single-verifier"];
  function parseMode(raw) {
    if (raw === void 0 || raw === null) return "full";
    if (typeof raw !== "string" || !ALLOWED_MODES.includes(raw)) {
      throw new Error(
        `pr-review: "mode" must be one of ${ALLOWED_MODES.join(", ")} \u2014 got ${JSON.stringify(raw)}. ("diff-read" is deliberately NOT a mode: the proportionate-review ladder's bottom rung means "do not invoke this workflow at all" \u2014 read the diff directly instead.)`
      );
    }
    return raw;
  }
  function parseInput(raw) {
    if (typeof raw === "string") {
      if (raw.trim().length === 0) {
        throw new Error(
          'pr-review: target must be a non-empty string \u2014 provide a git ref range or change description (e.g. "HEAD~3..HEAD")'
        );
      }
      return {
        target: raw,
        mode: "full",
        reviewerType: null,
        verifierModel: null,
        verifierType: null,
        perAgent: null,
        effort: null,
        messaging: null,
        provenance: null
      };
    }
    if (raw === null || typeof raw !== "object") {
      throw new Error(
        'pr-review: input must be an object with a "target" field, or a bare non-empty string \u2014 received: ' + typeof raw
      );
    }
    const obj = raw;
    if (!("target" in obj) || obj["target"] === void 0) {
      throw new Error(
        'pr-review: missing required field "target" \u2014 provide a git ref range or change description'
      );
    }
    if (typeof obj["target"] !== "string" || obj["target"].trim().length === 0) {
      throw new Error(
        'pr-review: "target" must be a non-empty string \u2014 provide a git ref range or change description (e.g. "HEAD~3..HEAD")'
      );
    }
    let verifierModel = null;
    if (obj["verifierModel"] !== void 0 && obj["verifierModel"] !== null) {
      if (typeof obj["verifierModel"] !== "string" || obj["verifierModel"].trim().length === 0) {
        throw new Error(
          'pr-review: "verifierModel" must be a non-empty model alias string (e.g. "sonnet") \u2014 omit it for the default (opus)'
        );
      }
      verifierModel = obj["verifierModel"];
    }
    const cfg = parseConfig(obj);
    const perAgent = cfg.perAgent ?? null;
    const effort = cfg.effort ?? null;
    const reviewerType = cfg.agentTypes?.["review"] ?? null;
    const verifierType = cfg.agentTypes?.["verify"] ?? null;
    const messaging = cfg.messaging ?? null;
    const provenance = parseProvenance(obj["provenance"]);
    const mode = parseMode(obj["mode"]);
    return { target: obj["target"], mode, reviewerType, verifierModel, verifierType, perAgent, effort, messaging, provenance };
  }
  async function run(rt00, input) {
    rt00.phase("Fence");
    const { rt: rt0, report: leafFence } = await withLeafFence(rt00, {
      phase: "Fence",
      disabled: input.messaging === true,
      // The probe call itself must inherit the SAME blanket default the rest of the
      // run gets below — otherwise it silently runs on the raw session model/effort,
      // contradicting perAgent's own "every agent inherits" contract.
      ...input.perAgent !== null ? { perAgent: input.perAgent } : {}
    });
    const { rt: leanBase, report: leanRouting } = await withLeanRouting(rt0, {
      phase: "Fence",
      disabled: input.messaging === true,
      ...input.perAgent !== null ? { perAgent: input.perAgent } : {}
    });
    const rt = input.perAgent !== null ? withAgentDefaults(rt0, input.perAgent) : rt0;
    const leanRt = input.perAgent !== null ? withAgentDefaults(leanBase, input.perAgent) : leanBase;
    const warnings = [];
    let reviewersSpawned = 0;
    let dropped = 0;
    const lensTrails = [];
    const classifyEffort = resolveEffort(input.effort?.["classify"], CLASSIFY_EFFORT);
    const routeActEffort = resolveEffort(input.effort?.["route"], ROUTE_ACT_EFFORT);
    const reviewEffort = resolveEffort(input.effort?.["review"], REVIEW_EFFORT);
    const verifyEffort = resolveVerifierEffort(input.effort?.["verify"], VERIFY_EFFORT_DEFAULT);
    const synthesizeEffort = resolveEffort(input.effort?.["synthesize"], SYNTHESIZE_EFFORT);
    let resolvedReviewerType = null;
    let probeReport = null;
    if (input.reviewerType !== null) {
      rt.phase("Probe");
      const probe = await probeAgentType(rt, input.reviewerType, { phase: "Probe" });
      resolvedReviewerType = probe.agentType ?? null;
      probeReport = { requested: input.reviewerType, available: probe.available, reason: probe.reason };
    }
    let resolvedVerifierType = null;
    let verifierProbeReport = null;
    if (input.verifierType !== null) {
      rt.phase("Probe");
      const probe = await probeAgentType(rt, input.verifierType, { phase: "Probe" });
      resolvedVerifierType = probe.agentType ?? null;
      verifierProbeReport = { requested: input.verifierType, available: probe.available, reason: probe.reason };
    }
    rt.phase("Route");
    const routeResult = await classifyAndAct(rt, {
      items: [input.target],
      categories: ["feature", "bugfix", "refactor", "config", "docs"],
      classifyPrompt: (target) => `Inspect this change and classify it into exactly one category: feature, bugfix, refactor, config, or docs.
Change target: ${target}
${READ_ONLY_GIT}
Return { "category": "<one of the five categories>" }`,
      classifyEffort,
      actions: {
        feature: {
          schema: CHANGE_SUMMARY_SCHEMA,
          prompt: (target) => `You are reviewing a FEATURE change. Inspect the actual change (${target}) and produce a focused summary.
${READ_ONLY_GIT}
Return { "changedFiles": ["<path>", ...], "addedPublicSurface": ["<new export/route/env var/CLI flag>", ...], "riskAreas": ["<risk1>", ...], "summary": "<what the feature does>" }. ${CHANGE_SUMMARY_RULES}`,
          effort: routeActEffort
        },
        bugfix: {
          schema: CHANGE_SUMMARY_SCHEMA,
          prompt: (target) => `You are reviewing a BUGFIX change. Inspect the actual change (${target}) \u2014 re-derive from first principles.
${READ_ONLY_GIT}
Return { "changedFiles": ["<path>", ...], "addedPublicSurface": ["<new export/route/env var/CLI flag>", ...], "riskAreas": ["<risk1>", ...], "summary": "<what was broken and how it is fixed>" }. ${CHANGE_SUMMARY_RULES}`,
          effort: routeActEffort
        },
        refactor: {
          schema: CHANGE_SUMMARY_SCHEMA,
          prompt: (target) => `You are reviewing a REFACTOR change. Inspect the actual change (${target}).
${READ_ONLY_GIT}
Return { "changedFiles": ["<path>", ...], "addedPublicSurface": ["<new export/route/env var/CLI flag>", ...], "riskAreas": ["<risk1>", ...], "summary": "<what was refactored and why>" }. ${CHANGE_SUMMARY_RULES}`,
          effort: routeActEffort
        },
        config: {
          schema: CHANGE_SUMMARY_SCHEMA,
          prompt: (target) => `You are reviewing a CONFIG change. Inspect the actual change (${target}).
${READ_ONLY_GIT}
Return { "changedFiles": ["<path>", ...], "addedPublicSurface": ["<new export/route/env var/CLI flag>", ...], "riskAreas": ["<risk1>", ...], "summary": "<what config changed and its effect>" }. ${CHANGE_SUMMARY_RULES}`,
          effort: routeActEffort
        },
        docs: {
          schema: CHANGE_SUMMARY_SCHEMA,
          prompt: (target) => `You are reviewing a DOCS change. Inspect the actual change (${target}).
${READ_ONLY_GIT}
Return { "changedFiles": ["<path>", ...], "addedPublicSurface": ["<new export/route/env var/CLI flag>", ...], "riskAreas": ["<risk1>", ...], "summary": "<what documentation was updated>" }. ${CHANGE_SUMMARY_RULES}`,
          effort: routeActEffort
        }
      },
      phase: "Route"
    });
    for (const w of routeResult.warnings) warnings.push(w);
    const routedItem = routeResult.value[0];
    if (routedItem === void 0) {
      throw new Error(
        "pr-review: classification failed \u2014 no category could be assigned to the change. Warnings: " + warnings.join("; ")
      );
    }
    const category = routedItem.category;
    const changeSummary = routedItem.result;
    const junkAreas = changeSummary.riskAreas.length > 0 && changeSummary.riskAreas.every((r) => r.trim().length <= 2);
    if (junkAreas || changeSummary.summary.trim().length < 12) {
      const w = `route: degenerate change summary from the ${category} act stage (summary="${changeSummary.summary.slice(0, 40)}", riskAreas=${JSON.stringify(changeSummary.riskAreas.slice(0, 4))}) \u2014 reviewer seeding lost; findings still re-derive from the actual diff`;
      warnings.push(w);
      rt.log(`\u26A0 ${w}`);
    }
    const looksLikeGitRange = /[0-9a-f]{6,40}|\bHEAD\b|\.\./.test(input.target);
    if (changeSummary.changedFiles.length === 0 && looksLikeGitRange) {
      const w = `route: empty changedFiles from the ${category} act stage on a range-shaped target \u2014 likely schema capitulation; the docs-alignment lens is DISARMED for this run (docs-coverage arms off addedPublicSurface, a separate field \u2014 though a capitulating agent has likely emptied both; stale prose anchors remain covered by the mechanical docs-contract gate)`;
      warnings.push(w);
      rt.log(`\u26A0 ${w}`);
    }
    const provenanceSource = input.provenance !== null ? "input" : "bundled";
    const provenanceDocs = docsForChangedFiles(
      changeSummary.changedFiles,
      input.provenance ?? void 0
    );
    if (provenanceDocs.length > 0) {
      rt.log(
        `docs-alignment lens armed: ${provenanceDocs.length} mapped doc surface(s) for this change (${provenanceSource} manifest)`
      );
    }
    const docsTouchedInDiff = changeSummary.changedFiles.some(
      (f) => f.endsWith(".md") || provenanceDocs.includes(f)
    );
    const coverageSurfaces = !docsTouchedInDiff && changeSummary.addedPublicSurface.length > 0 ? changeSummary.addedPublicSurface : [];
    if (coverageSurfaces.length > 0) {
      rt.log(
        `docs-coverage lens armed: ${coverageSurfaces.length} added public surface(s), no doc file touched`
      );
    } else if (changeSummary.addedPublicSurface.length > 0) {
      rt.log(
        `docs-coverage lens silent: ${changeSummary.addedPublicSurface.length} added public surface(s) but doc files are part of this change \u2014 the docs-alignment lens and the mechanical gates cover that path`
      );
    }
    const baseLenses = REVIEWER_LENSES[category] ?? DEFAULT_LENSES;
    const lenses = [
      ...baseLenses,
      ...provenanceDocs.length > 0 ? ["docs-alignment"] : [],
      ...coverageSurfaces.length > 0 ? ["docs-coverage"] : []
    ];
    const isConsolidated = input.mode === "single-verifier";
    const reviewItems = isConsolidated ? [CONSOLIDATED_LENS] : lenses;
    const lensInstructionsFor = (lens) => {
      if (lens === "docs-coverage") {
        const sanitizedSurface = (s) => s.replace(/[`\u0000-\u001f\u007f\u2028\u2029]/g, " ").slice(0, 200);
        return `The routing stage reports this change ADDS the following public surface, while touching NO documentation file:
` + coverageSurfaces.map((s) => `- ${sanitizedSurface(s)}`).join("\n") + `

Mapped doc homes for the changed modules (docs-provenance manifest):
` + (provenanceDocs.length > 0 ? provenanceDocs.map((d) => `- \`${d}\``).join("\n") : `- (none mapped \u2014 name the natural home)`) + `

Read the ACTUAL change first (${READ_ONLY_GIT}). For EACH added surface, judge: is it USER-FACING (an author, operator, or consumer must know it to use the product) or internal plumbing?
- User-facing and undocumented = one finding: set \`file\` to the SOURCE path that grew the surface, and in \`detail\` name the doc surface where it should be described (a mapped home above when the module is mapped; otherwise the natural home, plus suggest adding the docs-provenance pair). Severity by consumer impact: a surface a consumer cannot discover without reading source = high; a niche or advanced knob = medium; marginal = low.
- Internal-only additions are NOT findings \u2014 at most note them as candidates for the repo's reasoned exemption allowlists.
Do NOT re-review the code quality itself (other lenses do), and do NOT report surfaces this change does not add.`;
      }
      if (lens === "docs-alignment") {
        return `These committed doc surfaces (repo-relative) document the modules this change touches:
` + provenanceDocs.map((d) => `- \`${d}\``).join("\n") + `

Read the ACTUAL change first (${READ_ONLY_GIT}), then read EACH mapped surface and check every claim it makes about the changed behavior is still true after this change \u2014 names, defaults, option lists, counts, quoted values, described semantics, worked examples.
A finding = one claim that is now false or misleading; set \`file\` to the DOC path and quote the stale sentence in \`detail\` with what it should say instead. Severity by consumer impact: an author following the doc builds the wrong thing = high; imprecise but harmless = low.
Do NOT review the code itself (other lenses do), and do NOT report doc prose the change does not affect.`;
      }
      return `Read the ACTUAL change (you have repo access). Do NOT trust the summary above \u2014 re-derive findings from first principles.
${READ_ONLY_GIT}
Focus ONLY on the "${lens}" lens.`;
    };
    const reviewStage = async (_prev, originalItem) => {
      const lens = originalItem;
      reviewersSpawned++;
      if (lens === CONSOLIDATED_LENS) {
        const consolidatedInstructions = lenses.map((l) => `### Lens: ${l}
${lensInstructionsFor(l)}`).join("\n\n");
        const result2 = await rt.agent(
          `## Role
You are reviewing this change in single-verifier mode: ONE consolidated pass covering every lens that would normally get its own reviewer (${lenses.join(", ")}).

## Change
- **Target:** \`${input.target}\`

### Summary (from the routing stage)
${changeSummary.summary}

### Risk areas
${changeSummary.riskAreas.map((r) => `- ${r}`).join("\n")}

## Instructions \u2014 cover EVERY lens below, in full
${consolidatedInstructions}

## Output
Return your findings across ALL lenses combined. Each finding: \`{ title, file, severity ('high'|'medium'|'low'), detail }\``,
          {
            schema: FINDINGS_SCHEMA,
            label: "pr-review:reviewer:consolidated",
            phase: "Review",
            effort: reviewEffort,
            // Same agentTypes.review routing as the per-lens path — this is
            // precisely the shape a cross-family/quota-degraded verifier wants.
            ...resolvedReviewerType !== null ? { agentType: resolvedReviewerType } : {}
          }
        );
        return result2;
      }
      const lensInstructions = lensInstructionsFor(lens);
      const result = await rt.agent(
        `## Role
You are a specialized code reviewer examining the **${lens}** aspect of this change.

## Change
- **Target:** \`${input.target}\`

### Summary (from the routing stage)
${changeSummary.summary}

### Risk areas
${changeSummary.riskAreas.map((r) => `- ${r}`).join("\n")}

## Instructions
${lensInstructions}

## Output
Return your findings. Each finding: \`{ title, file, severity ('high'|'medium'|'low'), detail }\``,
        {
          schema: FINDINGS_SCHEMA,
          label: `pr-review:reviewer:${lens}`,
          phase: "Review",
          effort: reviewEffort,
          // Optional subagent type (agentTypes.review knob), PROBE-RESOLVED at
          // run entry. Omitted when null → standard subagent (default; also the
          // graceful-fallback path when the requested type could not answer).
          // Routes the lens reviewers ONLY; verifiers and synthesizer stay generic.
          ...resolvedReviewerType !== null ? { agentType: resolvedReviewerType } : {}
        }
      );
      return result;
    };
    const verifyStage = async (prev, originalItem) => {
      const lens = originalItem;
      const reviewOutput = prev;
      if (reviewOutput === null) {
        dropped++;
        return null;
      }
      const findings = reviewOutput.findings;
      if (findings.length === 0) {
        return [];
      }
      const verifyResult = await adversarialVerification(rt, {
        // Verify-fan model: launch-time override via `args.verifierModel`, default opus (BEST_MODEL).
        // This verification is TARGETED + diff-grounded, so passing 'sonnet' at launch is a sound,
        // cheaper choice — but the committed DEFAULT stays opus (no implicit downgrade).
        ...input.verifierModel !== null ? { model: input.verifierModel } : {},
        // Verify-fan agentType: launch-time override via `args.agentTypes.verify`,
        // probe-resolved above. Omitted when null → the standard subagent (default,
        // also the graceful-fallback path when the requested type could not answer).
        ...resolvedVerifierType !== null ? { verifierType: resolvedVerifierType } : {},
        claims: findings,
        renderClaim: (finding) => `## Claim to verify (lens: ${lens})
**${finding.title}** \u2014 \`${finding.file}\` \xB7 severity: ${finding.severity}

${finding.detail}

## Instructions
IMPORTANT: Do NOT trust the reviewer summary above. Open the actual diff at \`${input.target}\` and re-derive whether this finding is genuine from first principles.
${READ_ONLY_GIT}`,
        lenses: ["correctness", "security", "does-it-reproduce"],
        votes: 3,
        maxVerifyClaims: 5,
        effort: verifyEffort,
        phase: "Verify"
      });
      for (const w of verifyResult.warnings) warnings.push(w);
      lensTrails.push(verifyResult);
      return verifyResult.value;
    };
    const pipelineResults = await rt.pipeline(
      reviewItems,
      reviewStage,
      verifyStage
    );
    const allVerifiedFindings = [];
    for (const item of pipelineResults) {
      if (item === null) {
        continue;
      }
      const verifiedArray = item;
      for (const vc of verifiedArray) {
        allVerifiedFindings.push(vc);
      }
    }
    const findingsRaw = allVerifiedFindings.length;
    const findingsRefuted = allVerifiedFindings.filter((vc) => vc.verdict === "refuted").length;
    const findingsVerified = findingsRaw - findingsRefuted;
    const outputFindings = allVerifiedFindings.map((vc) => ({
      title: vc.claim.title,
      file: vc.claim.file,
      severity: vc.claim.severity,
      detail: vc.claim.detail,
      verdict: vc.verdict
    }));
    const synthesisFindings = allVerifiedFindings.filter((vc) => vc.verdict !== "refuted").map((vc) => ({
      title: vc.claim.title,
      file: vc.claim.file,
      severity: vc.claim.severity,
      detail: vc.claim.detail,
      verdict: vc.verdict
    }));
    rt.phase("Synthesize");
    const synthesisPrompt = `## Task
You are synthesizing a code review for the change \`${input.target}\` (category: ${category}).

### Change summary
${changeSummary.summary}

## Verified findings (non-refuted)
\`\`\`json
` + JSON.stringify(synthesisFindings, null, 2) + `
\`\`\`

## Output
Produce an overall verdict: "approve" if no high-severity confirmed findings remain, "request-changes" otherwise. Include a concise summary.
Return { "verdict": "approve"|"request-changes", "summary": "<concise summary>" }`;
    const synthesisAgent = await leanRt.agent(synthesisPrompt, {
      schema: SYNTHESIS_SCHEMA,
      label: "pr-review:synthesize",
      phase: "Synthesize",
      effort: synthesizeEffort
    });
    if (synthesisAgent === null) {
      throw new Error(
        "pr-review: synthesis agent failed \u2014 unable to produce a verdict. Use resumeFromRunId to retry from the Synthesize phase (reviewed findings are cached)."
      );
    }
    return {
      category,
      verdict: synthesisAgent.verdict,
      summary: synthesisAgent.summary,
      mode: input.mode,
      findings: outputFindings,
      // Reviewer routing outcome: the pure identifier actually used (null =
      // standard subagent) + the structured probe story when routing was requested.
      reviewerType: resolvedReviewerType,
      probe: probeReport,
      verifierType: resolvedVerifierType,
      verifierProbe: verifierProbeReport,
      leafFence,
      leanRouting,
      provenanceDocs,
      provenanceSource,
      coverageSurfaces,
      stats: {
        reviewersSpawned,
        findingsRaw,
        findingsVerified,
        findingsRefuted,
        dropped
      },
      envelope: { trail: collectTrail(routeResult, ...lensTrails) },
      warnings
    };
  }
  var pr_review_workflow_default = defineWorkflow({
    meta: {
      name: "pr-review",
      description: "Multi-lens code review of a change set: classifies the change, spawns specialized reviewers, adversarially verifies findings, and synthesizes a verdict.",
      whenToUse: `Use when you need a structured, adversarially-verified code review of a git ref range or change description. Pass mode: "single-verifier" for the quota-degraded proportionate-review rung (one consolidated reviewer instead of one per lens); the ladder's bottom rung ("diff-read": read the diff yourself, no findings to verify) is not a mode this workflow accepts \u2014 don't launch it for that case.`,
      phases: [
        { title: "Fence", detail: "Resolve the default leaf-agent fence (SendMessage denied by default) and the lean-routing default for the pure Synthesize stage" },
        { title: "Probe", detail: "Resolve the requested reviewer agentType (graceful Claude fallback)" },
        { title: "Route", detail: "Classify the change and produce a targeted summary" },
        { title: "Review", detail: "Spawn specialized reviewer agents per lens" },
        { title: "Verify", detail: "Adversarially verify each finding (fresh-evidence check)" },
        { title: "Synthesize", detail: "Produce an overall verdict from verified findings" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(pr_review_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

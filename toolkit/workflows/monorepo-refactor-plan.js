export const meta = {
  "name": "monorepo-refactor-plan",
  "description": "Planning half of an L3 HITL pair: inspects monorepo areas, classifies problems, produces a deep analysis brief, decomposes into change proposals, adversarially verifies them, and synthesizes a structured plan artifact for human review.",
  "whenToUse": "Use when you need a structured, adversarially-verified refactoring plan for a monorepo. The human reviews the output artifact and passes the approved plan to monorepo-refactor-execute.",
  "phases": [
    {
      "title": "Map",
      "detail": "Classify and observe problem areas in the monorepo"
    },
    {
      "title": "Analyze",
      "detail": "Deep per-area analysis and consolidated brief"
    },
    {
      "title": "Plan",
      "detail": "Dynamic decomposition into independent change proposals"
    },
    {
      "title": "Verify",
      "detail": "Adversarially verify change proposals (fresh-evidence check)"
    },
    {
      "title": "Synthesize",
      "detail": "Produce the final structured plan artifact"
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

  // monorepo-refactor-plan.workflow.ts
  var monorepo_refactor_plan_workflow_exports = {};
  __export(monorepo_refactor_plan_workflow_exports, {
    default: () => monorepo_refactor_plan_workflow_default
  });

  // ../packages/runtime/src/constants.ts
  var BEST_MODEL = "opus";

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

  // ../packages/patterns/src/classify-and-act.ts
  var STAGE = "classifyAndAct";
  async function classifyAndAct(rt, options) {
    const { items, categories, classifyPrompt, actions, classifyModel, classifyEffort, classifyType, phase, maxItems } = options;
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
    assertAgentTypeOption(STAGE, "classifyType", classifyType);
    for (const [category, spec] of Object.entries(actions)) {
      assertAgentTypeOption(STAGE, `actions.${category}.agentType`, spec.agentType);
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
        label: `${STAGE}:classify:${index}`,
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
          record: makeRecord(`${STAGE}:classify:${index}`, false, {
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
          record: makeRecord(`${STAGE}:classify:${index}`, false, {
            ...classifyModel !== void 0 ? { model: classifyModel } : {},
            ...classifyEffort !== void 0 ? { effort: classifyEffort } : {}
          })
        });
        throw new Error(`classify returned unknown category "${classified.category}"`);
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`${STAGE}:classify:${index}`, true, {
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
        label: `${STAGE}:act:${category}:${index}`,
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
          record: makeRecord(`${STAGE}:act:${category}:${index}`, false, {
            ...spec.model !== void 0 ? { model: spec.model } : {},
            ...spec.effort !== void 0 ? { effort: spec.effort } : {}
          })
        });
        throw new Error("act returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(`${STAGE}:act:${category}:${index}`, true, {
          ...spec.model !== void 0 ? { model: spec.model } : {},
          ...spec.effort !== void 0 ? { effort: spec.effort } : {}
        })
      });
      return { item, category, result };
    };
    const rawResults = await rt.pipeline(kept, classifyStage, actStage);
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
      stage: STAGE,
      taken: allCategories.filter((c) => chosen.has(c)),
      notTaken: allCategories.filter((c) => !chosen.has(c)),
      counts: { in: items.length, out: value.length }
    });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/fan-out-and-synthesize.ts
  var STAGE2 = "fanOutAndSynthesize";
  async function fanOutAndSynthesize(rt, options) {
    const {
      tasks,
      taskPrompt,
      taskSchema,
      taskModel,
      taskEffort,
      taskType,
      synthesisPrompt,
      synthesisSchema,
      synthesisModel,
      synthesisEffort,
      synthesisType,
      phase,
      maxItems
    } = options;
    if (tasks.length === 0) {
      throw new Error(
        "fanOutAndSynthesize: tasks must not be empty \u2014 nothing to fan out"
      );
    }
    assertAgentTypeOption(STAGE2, "taskType", taskType);
    assertAgentTypeOption(STAGE2, "synthesisType", synthesisType);
    const { kept, truncated } = applyCap(tasks, maxItems);
    let agentsSpawned = 0;
    const warnings = [];
    const trail = [];
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `fanOutAndSynthesize: ${truncated} of ${tasks.length} tasks truncated by maxItems=${maxItems ?? "?"}`
      );
    }
    const keptArray = kept;
    const taskThunks = keptArray.map((task, i) => async () => {
      const taskOpts = {
        label: `${STAGE2}:task:${i}`,
        ...phase !== void 0 ? { phase } : {},
        ...taskSchema !== void 0 ? { schema: taskSchema } : {},
        ...taskModel !== void 0 ? { model: taskModel } : {},
        ...taskEffort !== void 0 ? { effort: taskEffort } : {},
        ...taskType !== void 0 ? { agentType: taskType } : {}
      };
      agentsSpawned++;
      return rt.agent(taskPrompt(task, i), taskOpts);
    });
    const taskResults = await rt.parallel(taskThunks);
    const parts = [];
    let dropped = 0;
    for (let i = 0; i < taskResults.length; i++) {
      const r = taskResults[i];
      trail.push(makeRecord(`${STAGE2}:task:${i}`, r !== null, {
        ...taskModel !== void 0 ? { model: taskModel } : {},
        ...taskEffort !== void 0 ? { effort: taskEffort } : {}
      }));
      if (r !== null) {
        parts.push(r);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      warn(
        rt,
        warnings,
        `fanOutAndSynthesize: ${dropped} of ${keptArray.length} fan-out agents returned null`
      );
    }
    let value = null;
    if (parts.length === 0) {
      warn(rt, warnings, "fanOutAndSynthesize: fan-out produced no parts; synthesis skipped");
    } else {
      const synthOpts = {
        label: `${STAGE2}:synthesize`,
        ...phase !== void 0 ? { phase } : {},
        ...synthesisSchema !== void 0 ? { schema: synthesisSchema } : {},
        ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
        ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {},
        ...synthesisType !== void 0 ? { agentType: synthesisType } : {}
      };
      agentsSpawned++;
      const synthesis = await rt.agent(synthesisPrompt(parts), synthOpts);
      trail.push(makeRecord(`${STAGE2}:synthesize`, synthesis !== null, {
        ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
        ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {}
      }));
      if (synthesis === null) {
        warn(rt, warnings, "fanOutAndSynthesize: synthesis agent returned null");
      } else {
        value = synthesis;
      }
    }
    const stats = {
      itemsIn: tasks.length,
      itemsOut: parts.length,
      agentsSpawned,
      dropped,
      truncated
    };
    emitDigest(rt, {
      stage: STAGE2,
      output: value === null ? "synthesis: none" : `synthesis from ${parts.length}/${tasks.length} tasks`,
      counts: { tasks: tasks.length, completed: parts.length }
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
      verifierType
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
    emitDigest(rt, { stage: STAGE3, counts });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/plan-and-execute.ts
  var STAGE4 = "planAndExecute";
  var PLAN_SCHEMA = {
    type: "object",
    properties: {
      subtasks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            description: { type: "string" }
          },
          required: ["description"],
          additionalProperties: false
        }
      }
    },
    required: ["subtasks"],
    additionalProperties: false
  };
  async function planAndExecute(rt, options) {
    const {
      planPrompt,
      planModel,
      planEffort,
      planType,
      workerPrompt,
      workerSchema,
      workerModel,
      workerEffort,
      workerType,
      synthesisPrompt,
      synthesisSchema,
      synthesisModel,
      synthesisEffort,
      synthesisType,
      phase,
      maxSubtasks
    } = options;
    if (planPrompt.trim().length === 0) {
      throw new Error(
        "planAndExecute: planPrompt must not be empty \u2014 provide a non-whitespace planning prompt"
      );
    }
    if (maxSubtasks !== void 0 && maxSubtasks < 1) {
      throw new Error(
        `planAndExecute: maxSubtasks must be >= 1, got ${maxSubtasks}`
      );
    }
    assertAgentTypeOption(STAGE4, "planType", planType);
    assertAgentTypeOption(STAGE4, "workerType", workerType);
    assertAgentTypeOption(STAGE4, "synthesisType", synthesisType);
    let agentsSpawned = 0;
    const warnings = [];
    const trail = [];
    const planOpts = {
      schema: PLAN_SCHEMA,
      label: `${STAGE4}:plan`,
      ...phase !== void 0 ? { phase } : {},
      ...planModel !== void 0 ? { model: planModel } : {},
      ...planEffort !== void 0 ? { effort: planEffort } : {},
      ...planType !== void 0 ? { agentType: planType } : {}
    };
    agentsSpawned++;
    const plan = await rt.agent(planPrompt, planOpts);
    if (plan === null) {
      warn(rt, warnings, "planAndExecute: planner returned null \u2014 nothing executed");
      trail.push(makeRecord(`${STAGE4}:plan`, false, {
        ...planModel !== void 0 ? { model: planModel } : {},
        ...planEffort !== void 0 ? { effort: planEffort } : {}
      }));
      const stats2 = {
        itemsIn: 0,
        itemsOut: 0,
        agentsSpawned,
        dropped: 0,
        truncated: 0
      };
      emitDigest(rt, { stage: STAGE4, output: "synthesis: none", counts: { planned: 0, executed: 0, dropped: 0, truncated: 0 } });
      return { value: null, stats: stats2, warnings, workerResults: [], trail };
    }
    const plannedSubtasks = plan.subtasks;
    const plannedCount = plannedSubtasks.length;
    const { kept: keptSubtasks, truncated } = applyCap(plannedSubtasks, maxSubtasks);
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `planAndExecute: ${truncated} of ${plannedCount} subtasks truncated by maxSubtasks=${maxSubtasks ?? "?"}`
      );
    }
    trail.push(makeRecord(`${STAGE4}:plan`, true, {
      ...planModel !== void 0 ? { model: planModel } : {},
      ...planEffort !== void 0 ? { effort: planEffort } : {},
      decision: `subtasks=${keptSubtasks.length}`
    }));
    const keptArray = keptSubtasks;
    const workerThunks = keptArray.map((subtask, i) => async () => {
      const opts = {
        label: `${STAGE4}:work:${i}`,
        ...phase !== void 0 ? { phase } : {},
        ...workerSchema !== void 0 ? { schema: workerSchema } : {},
        ...workerModel !== void 0 ? { model: workerModel } : {},
        ...workerEffort !== void 0 ? { effort: workerEffort } : {},
        ...workerType !== void 0 ? { agentType: workerType } : {}
      };
      agentsSpawned++;
      return rt.agent(workerPrompt(subtask, i), opts);
    });
    const rawWorkerResults = await rt.parallel(workerThunks);
    const successfulResults = [];
    let droppedWorkers = 0;
    for (let i = 0; i < rawWorkerResults.length; i++) {
      const r = rawWorkerResults[i];
      trail.push(makeRecord(`${STAGE4}:work:${i}`, r !== null, {
        ...workerModel !== void 0 ? { model: workerModel } : {},
        ...workerEffort !== void 0 ? { effort: workerEffort } : {}
      }));
      if (r !== null) {
        successfulResults.push(r);
      } else {
        droppedWorkers++;
      }
    }
    if (droppedWorkers > 0) {
      warn(
        rt,
        warnings,
        `planAndExecute: ${droppedWorkers} of ${keptArray.length} workers returned null`
      );
    }
    if (successfulResults.length === 0) {
      warn(rt, warnings, "planAndExecute: all workers failed; synthesis skipped");
      const stats2 = {
        itemsIn: plannedCount,
        itemsOut: 0,
        agentsSpawned,
        dropped: droppedWorkers,
        truncated
      };
      emitDigest(rt, { stage: STAGE4, output: "synthesis: none", counts: { planned: plannedCount, executed: 0, dropped: droppedWorkers, truncated } });
      return { value: null, stats: stats2, warnings, workerResults: [], trail };
    }
    const synthOpts = {
      label: `${STAGE4}:synthesize`,
      ...phase !== void 0 ? { phase } : {},
      ...synthesisSchema !== void 0 ? { schema: synthesisSchema } : {},
      ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
      ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {},
      ...synthesisType !== void 0 ? { agentType: synthesisType } : {}
    };
    agentsSpawned++;
    const synthesis = await rt.agent(synthesisPrompt(successfulResults), synthOpts);
    trail.push(makeRecord(`${STAGE4}:synthesize`, synthesis !== null, {
      ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
      ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {}
    }));
    let value = null;
    if (synthesis === null) {
      warn(rt, warnings, "planAndExecute: synthesis agent returned null");
    } else {
      value = synthesis;
    }
    const stats = {
      itemsIn: plannedCount,
      itemsOut: successfulResults.length,
      agentsSpawned,
      dropped: droppedWorkers,
      truncated
    };
    emitDigest(rt, {
      stage: STAGE4,
      output: value === null ? "synthesis: none" : "synthesis: ok",
      counts: { planned: plannedCount, executed: successfulResults.length, dropped: droppedWorkers, truncated }
    });
    return { value, stats, warnings, workerResults: successfulResults, trail };
  }

  // monorepo-refactor-plan.workflow.ts
  var CLASSIFY_EFFORT = "low";
  var MAP_ACT_EFFORT = "high";
  var MAP_HEALTHY_EFFORT = "low";
  var ANALYZE_TASK_EFFORT = "high";
  var ANALYZE_SYNTHESIS_EFFORT = "medium";
  var PLAN_EFFORT = "high";
  var PLAN_WORK_EFFORT = "high";
  var PLAN_SYNTHESIS_EFFORT = "medium";
  var VERIFY_EFFORT_DEFAULT = "high";
  var SYNTHESIZE_EFFORT = "high";
  var OBSERVATION_SCHEMA = {
    type: "object",
    properties: {
      observations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            detail: { type: "string" }
          },
          required: ["file", "detail"],
          additionalProperties: false
        }
      }
    },
    required: ["observations"],
    additionalProperties: false
  };
  var ANALYSIS_SCHEMA = {
    type: "object",
    properties: {
      problems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            problem: { type: "string" },
            impact: { type: "string" }
          },
          required: ["file", "problem", "impact"],
          additionalProperties: false
        }
      }
    },
    required: ["problems"],
    additionalProperties: false
  };
  var BRIEF_SCHEMA = {
    type: "object",
    properties: {
      brief: { type: "string" },
      hotspots: { type: "array", items: { type: "string" } }
    },
    required: ["brief", "hotspots"],
    additionalProperties: false
  };
  var CHANGES_SCHEMA = {
    type: "object",
    properties: {
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            action: { type: "string" },
            rationale: { type: "string" },
            impact: { type: "string", enum: ["low", "medium", "high"] }
          },
          required: ["file", "action", "rationale", "impact"],
          additionalProperties: false
        }
      }
    },
    required: ["changes"],
    additionalProperties: false
  };
  var PLAN_ARTIFACT_SCHEMA = {
    type: "object",
    properties: {
      planTitle: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            order: { type: "number" },
            file: { type: "string" },
            action: { type: "string" },
            rationale: { type: "string" }
          },
          required: ["order", "file", "action", "rationale"],
          additionalProperties: false
        }
      }
    },
    required: ["planTitle", "steps"],
    additionalProperties: false
  };
  function parseInput(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        'monorepo-refactor-plan: input must be an object with "goal" (string) and "areas" (string[]) \u2014 received: ' + (raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw)
      );
    }
    const obj = raw;
    if (typeof obj["goal"] !== "string" || obj["goal"].trim().length === 0) {
      throw new Error(
        'monorepo-refactor-plan: "goal" must be a non-empty string \u2014 describe the refactoring objective (e.g. "Reduce duplication across packages")'
      );
    }
    if (!Array.isArray(obj["areas"]) || obj["areas"].length === 0) {
      throw new Error(
        'monorepo-refactor-plan: "areas" must be a non-empty array of strings \u2014 provide at least one monorepo package or directory to inspect (e.g. ["packages/core", "packages/ui"])'
      );
    }
    for (let i = 0; i < obj["areas"].length; i++) {
      const area = obj["areas"][i];
      if (typeof area !== "string" || area.trim().length === 0) {
        throw new Error(
          `monorepo-refactor-plan: "areas[${i}]" must be a non-empty string \u2014 each element must be a monorepo package or directory path`
        );
      }
    }
    const effort = parseConfig(obj).effort ?? null;
    return {
      goal: obj["goal"],
      areas: obj["areas"],
      effort
    };
  }
  async function run(rt, input) {
    const warnings = [];
    const stats = {};
    const classifyEffort = resolveEffort(input.effort?.["classify"], CLASSIFY_EFFORT);
    const mapActEffort = resolveEffort(input.effort?.["mapAct"], MAP_ACT_EFFORT);
    const mapHealthyEffort = resolveEffort(input.effort?.["mapHealthy"], MAP_HEALTHY_EFFORT);
    const analyzeTaskEffort = resolveEffort(input.effort?.["analyzeTask"], ANALYZE_TASK_EFFORT);
    const analyzeSynthesisEffort = resolveEffort(input.effort?.["analyzeSynthesis"], ANALYZE_SYNTHESIS_EFFORT);
    const planEffort = resolveEffort(input.effort?.["plan"], PLAN_EFFORT);
    const planWorkEffort = resolveEffort(input.effort?.["planWork"], PLAN_WORK_EFFORT);
    const planSynthesisEffort = resolveEffort(input.effort?.["planSynthesis"], PLAN_SYNTHESIS_EFFORT);
    const verifyEffort = resolveVerifierEffort(input.effort?.["verify"], VERIFY_EFFORT_DEFAULT);
    const synthesizeEffort = resolveEffort(input.effort?.["synthesize"], SYNTHESIZE_EFFORT);
    rt.phase("Map");
    const mapResult = await classifyAndAct(rt, {
      items: input.areas,
      categories: ["dead-code", "duplication", "api-drift", "structure", "healthy"],
      classifyPrompt: (area) => `Inspect this monorepo area against the refactoring goal and classify it into exactly one category: dead-code, duplication, api-drift, structure, or healthy.
Goal: ${input.goal}
Area: ${area}
Return { "category": "<one of the five categories>" }`,
      classifyEffort,
      actions: {
        "dead-code": {
          schema: OBSERVATION_SCHEMA,
          prompt: (area) => `You are making a focused observation on DEAD-CODE in this monorepo area.
Goal: ${input.goal}
Area: ${area}
Inspect the area and report files containing dead or unreachable code.
Return { "observations": [{ "file": "<path>", "detail": "<what makes it dead code>" }] }`,
          effort: mapActEffort
        },
        "duplication": {
          schema: OBSERVATION_SCHEMA,
          prompt: (area) => `You are making a focused observation on DUPLICATION in this monorepo area.
Goal: ${input.goal}
Area: ${area}
Inspect the area and report files with duplicated logic or copy-paste code.
Return { "observations": [{ "file": "<path>", "detail": "<what is duplicated and where>" }] }`,
          effort: mapActEffort
        },
        "api-drift": {
          schema: OBSERVATION_SCHEMA,
          prompt: (area) => `You are making a focused observation on API-DRIFT in this monorepo area.
Goal: ${input.goal}
Area: ${area}
Inspect the area and report files where API contracts have diverged across packages.
Return { "observations": [{ "file": "<path>", "detail": "<the drift and its effect>" }] }`,
          effort: mapActEffort
        },
        "structure": {
          schema: OBSERVATION_SCHEMA,
          prompt: (area) => `You are making a focused observation on STRUCTURE problems in this monorepo area.
Goal: ${input.goal}
Area: ${area}
Inspect the area and report files with structural issues (wrong location, bad boundaries, etc.).
Return { "observations": [{ "file": "<path>", "detail": "<the structural problem>" }] }`,
          effort: mapActEffort
        },
        "healthy": {
          schema: OBSERVATION_SCHEMA,
          // 'haiku' for mechanical healthy-area check — no deep analysis needed
          model: "haiku",
          effort: mapHealthyEffort,
          prompt: (area) => `This monorepo area appears healthy relative to the goal.
Goal: ${input.goal}
Area: ${area}
Confirm it is healthy and return an empty observations list.
Return { "observations": [] }`
        }
      },
      phase: "Map"
    });
    for (const w of mapResult.warnings) warnings.push(w);
    stats["map"] = mapResult.stats;
    const classifiedAreas = mapResult.value.map((item) => ({
      area: item.item,
      category: item.category,
      observations: item.result.observations
    }));
    rt.phase("Analyze");
    let analysisTasks = classifiedAreas;
    if (classifiedAreas.length === 0) {
      warn(
        rt,
        warnings,
        "Map phase produced no classified areas (all classification agents dropped) \u2014 analyzing raw input areas without observations"
      );
      analysisTasks = input.areas.map((area) => ({ area, category: "unmapped", observations: [] }));
    }
    const analyzeResult = await fanOutAndSynthesize(rt, {
      tasks: analysisTasks,
      taskPrompt: (task) => `Perform a deep analysis of this monorepo area.
Goal: ${input.goal}
Area: ${task.area}
Category: ${task.category}
Observations: ${JSON.stringify(task.observations)}
Re-derive from the actual code \u2014 do NOT trust the observations above blindly.
Return { "problems": [{ "file": "<path>", "problem": "<what is wrong>", "impact": "<high|medium|low>" }] }`,
      taskSchema: ANALYSIS_SCHEMA,
      taskEffort: analyzeTaskEffort,
      synthesisPrompt: (parts) => `Consolidate into a single analysis brief from these per-area deep analyses.
Goal: ${input.goal}
Analyses: ${JSON.stringify(parts)}
Return { "brief": "<consolidated summary of key problems>", "hotspots": ["<file1>", ...] }`,
      synthesisSchema: BRIEF_SCHEMA,
      synthesisEffort: analyzeSynthesisEffort,
      phase: "Analyze"
    });
    for (const w of analyzeResult.warnings) warnings.push(w);
    stats["analyze"] = analyzeResult.stats;
    const brief = analyzeResult.value ?? { brief: "No analysis available", hotspots: [] };
    rt.phase("Plan");
    const planResult = await planAndExecute(rt, {
      planPrompt: `Decompose into independent change proposals for this monorepo refactoring.
Goal: ${input.goal}
Analysis brief: ${brief.brief}
Hotspots: ${brief.hotspots.join(", ")}
Produce a list of independent, parallel-safe change proposals.
Each subtask description should identify ONE file and ONE concrete action.
Return { "subtasks": [{ "description": "<proposal description>" }] }`,
      planEffort,
      workerPrompt: (subtask) => `Detail the change proposal: ${subtask.description}
Goal: ${input.goal}
Expand this into concrete file changes with rationale.
Set "impact" to "low" ONLY for a package-internal cleanup with no exported-API change; "medium" or "high" otherwise (cross-package moves, public API changes). Impact decides how much independent scrutiny the proposal gets in the Verify phase \u2014 understating it ships unverified changes into the plan, so when unsure pick the higher value.
Return { "changes": [{ "file": "<path>", "action": "<what to do>", "rationale": "<why>", "impact": "<low|medium|high>" }] }`,
      workerSchema: CHANGES_SCHEMA,
      workerEffort: planWorkEffort,
      synthesisPrompt: (results) => `Compose a draft refactoring plan from these detailed change proposals.
Goal: ${input.goal}
Change proposals: ${JSON.stringify(results)}
Produce a coherent draft plan narrative (plain text) that will feed the final plan synthesis.`,
      synthesisEffort: planSynthesisEffort,
      maxSubtasks: 8,
      phase: "Plan"
    });
    for (const w of planResult.warnings) warnings.push(w);
    stats["plan"] = planResult.stats;
    rt.phase("Verify");
    let verifiedChanges = [];
    const rejectedChanges = [];
    let verifyResult = null;
    const workerChanges = planResult.workerResults.flatMap((r) => r.changes);
    const selfRatedLow = workerChanges.filter((c) => c.impact === "low").length;
    if (workerChanges.length >= 4 && selfRatedLow / workerChanges.length > 0.8) {
      warn(
        rt,
        warnings,
        `${selfRatedLow} of ${workerChanges.length} change proposals self-rate impact "low" \u2014 an implausibly high fraction; the self-assessed impact gates verification scrutiny, so treat this plan with suspicion`
      );
    }
    if (workerChanges.length > 0) {
      verifyResult = await adversarialVerification(rt, {
        claims: workerChanges,
        renderClaim: (change) => `Change proposal: "${change.action}" in ${change.file}
Rationale: ${change.rationale}

IMPORTANT: Do NOT trust the rationale above. Open the actual file at ${change.file} and re-derive from the code whether this change is necessary and correct.`,
        // Impact-aware votes: a low-impact proposal gets 1 refute-first vote;
        // medium/high keep the full 2-of-3 quorum (effectiveThreshold = min(2, claimVotes)).
        votesPerClaim: (change) => change.impact === "low" ? 1 : 3,
        maxVerifyClaims: 10,
        effort: verifyEffort,
        phase: "Verify"
      });
      for (const w of verifyResult.warnings) warnings.push(w);
      stats["verify"] = verifyResult.stats;
      verifiedChanges = verifyResult.value;
    } else {
      warn(rt, warnings, "Plan phase produced no change proposals \u2014 Verify phase skipped");
    }
    const keptChanges = [];
    for (const vc of verifiedChanges) {
      if (vc.verdict === "refuted") {
        rejectedChanges.push({
          file: vc.claim.file,
          action: vc.claim.action,
          rationale: vc.claim.rationale,
          verdict: vc.verdict
        });
      } else {
        keptChanges.push(vc.claim);
      }
    }
    rt.phase("Synthesize");
    const synthesizePrompt = `Produce the final plan artifact from these verified change proposals.
Goal: ${input.goal}
Kept changes (non-refuted): ${JSON.stringify(keptChanges)}
Produce a structured plan with a title and ordered steps.
Return { "planTitle": "<descriptive title>", "steps": [{ "order": <n>, "file": "<path>", "action": "<what>", "rationale": "<why>" }] }`;
    const planArtifactAgent = await rt.agent(synthesizePrompt, {
      schema: PLAN_ARTIFACT_SCHEMA,
      label: "monorepo-refactor-plan:synthesize",
      phase: "Synthesize",
      effort: synthesizeEffort
    });
    if (planArtifactAgent === null) {
      throw new Error(
        "monorepo-refactor-plan: final plan synthesis failed \u2014 unable to produce a plan artifact. Use resumeFromRunId to retry from the Synthesize phase (all prior work is cached)."
      );
    }
    return {
      goal: input.goal,
      plan: planArtifactAgent,
      rejected: rejectedChanges,
      stats,
      envelope: { trail: collectTrail(mapResult, analyzeResult, planResult, verifyResult) },
      warnings
    };
  }
  var monorepo_refactor_plan_workflow_default = defineWorkflow({
    meta: {
      name: "monorepo-refactor-plan",
      description: "Planning half of an L3 HITL pair: inspects monorepo areas, classifies problems, produces a deep analysis brief, decomposes into change proposals, adversarially verifies them, and synthesizes a structured plan artifact for human review.",
      whenToUse: "Use when you need a structured, adversarially-verified refactoring plan for a monorepo. The human reviews the output artifact and passes the approved plan to monorepo-refactor-execute.",
      phases: [
        { title: "Map", detail: "Classify and observe problem areas in the monorepo" },
        { title: "Analyze", detail: "Deep per-area analysis and consolidated brief" },
        { title: "Plan", detail: "Dynamic decomposition into independent change proposals" },
        { title: "Verify", detail: "Adversarially verify change proposals (fresh-evidence check)" },
        { title: "Synthesize", detail: "Produce the final structured plan artifact" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(monorepo_refactor_plan_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

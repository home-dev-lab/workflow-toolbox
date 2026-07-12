export const meta = {
  "name": "doc-rewrite",
  "description": "Rewrites a document against a set of quality criteria using an evaluator-optimizer loop: generates diverse candidate rewrites, filters them, then iteratively refines the best candidate until all criteria are met or the iteration budget is exhausted.",
  "whenToUse": "Use when you need to rewrite a document to meet specific quality criteria, with iterative refinement until the evaluator approves the result.",
  "phases": [
    {
      "title": "Generate",
      "detail": "Generate diverse candidate rewrites and filter against criteria"
    },
    {
      "title": "Refine",
      "detail": "Evaluator-optimizer loop: evaluate the draft, improve until criteria met"
    },
    {
      "title": "Finalize",
      "detail": "Surface the final document with honest approval status"
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

  // doc-rewrite.workflow.ts
  var doc_rewrite_workflow_exports = {};
  __export(doc_rewrite_workflow_exports, {
    default: () => doc_rewrite_workflow_default
  });

  // ../packages/runtime/src/digest.ts
  var DIGEST_PREFIX = "[wt:digest]";
  var LOOP_STAGE = "loopUntilDone";
  var LOOP_ITER_MARKER = " \u27F2";
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
  function assertAgentTypeOption(stage, name, value) {
    if (value !== void 0 && value.trim().length === 0) {
      throw new Error(
        `${stage}: ${name} must be a non-empty subagent-type string (e.g. 'codex:codex-rescue') \u2014 omit it for the standard subagent`
      );
    }
  }

  // ../packages/patterns/src/cache-warm.ts
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

  // ../packages/patterns/src/generate-and-filter.ts
  var STAGE = "generateAndFilter";
  var REJECTED = /* @__PURE__ */ Symbol("generate-and-filter:REJECTED");
  async function generateAndFilter(rt, options) {
    const { count, generatePrompt, generateSchema, generateModel, generateEffort, generateType, filterPrompt, filterModel, filterEffort, filterType, phase, cacheWarm } = options;
    if (count < 1) {
      throw new Error(
        `generateAndFilter: count must be >= 1, got ${count} \u2014 set count to a positive integer`
      );
    }
    assertAgentTypeOption(STAGE, "generateType", generateType);
    assertAgentTypeOption(STAGE, "filterType", filterType);
    let agentsSpawned = 0;
    let generateFailures = 0;
    let filterFailures = 0;
    const warnings = [];
    const pendingTrail = [];
    const filterSchema = {
      type: "object",
      properties: {
        pass: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["pass", "reason"],
      additionalProperties: false
    };
    const generateStage = async (_prev, _originalItem, index) => {
      const genOpts = {
        label: `${STAGE}:generate:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...generateSchema !== void 0 ? { schema: generateSchema } : {},
        ...generateModel !== void 0 ? { model: generateModel } : {},
        ...generateEffort !== void 0 ? { effort: generateEffort } : {},
        ...generateType !== void 0 ? { agentType: generateType } : {}
      };
      agentsSpawned++;
      const candidate = await rt.agent(generatePrompt(index), genOpts);
      if (candidate === null) {
        generateFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0,
          record: makeRecord(`${STAGE}:generate:${index}`, false, {
            ...generateModel !== void 0 ? { model: generateModel } : {},
            ...generateEffort !== void 0 ? { effort: generateEffort } : {}
          })
        });
        throw new Error("generate returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`${STAGE}:generate:${index}`, true, {
          ...generateModel !== void 0 ? { model: generateModel } : {},
          ...generateEffort !== void 0 ? { effort: generateEffort } : {}
        })
      });
      return candidate;
    };
    const filterStage = async (prev, _originalItem, index) => {
      const candidate = prev;
      const filterOpts = {
        schema: filterSchema,
        label: `${STAGE}:filter:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...filterModel !== void 0 ? { model: filterModel } : {},
        ...filterEffort !== void 0 ? { effort: filterEffort } : {},
        ...filterType !== void 0 ? { agentType: filterType } : {}
      };
      agentsSpawned++;
      const verdict = await rt.agent(
        filterPrompt(candidate),
        filterOpts
      );
      if (verdict === null) {
        filterFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 1,
          record: makeRecord(`${STAGE}:filter:${index}`, false, {
            ...filterModel !== void 0 ? { model: filterModel } : {},
            ...filterEffort !== void 0 ? { effort: filterEffort } : {}
          })
        });
        throw new Error("filter returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(`${STAGE}:filter:${index}`, true, {
          ...filterModel !== void 0 ? { model: filterModel } : {},
          ...filterEffort !== void 0 ? { effort: filterEffort } : {},
          decision: verdict.pass ? "pass" : "fail"
        })
      });
      if (!verdict.pass) {
        return REJECTED;
      }
      return candidate;
    };
    const indices = Array.from({ length: count }, (_, i) => i);
    const rawResults = await pipelineWithCacheWarm(
      rt,
      indices,
      [generateStage, filterStage],
      cacheWarm ?? true
    );
    const value = [];
    for (const r of rawResults) {
      if (r !== null && r !== REJECTED) {
        value.push(r);
      }
    }
    if (generateFailures > 0) {
      warn(
        rt,
        warnings,
        `generateAndFilter: ${generateFailures} of ${count} candidates failed generation`
      );
    }
    if (filterFailures > 0) {
      warn(
        rt,
        warnings,
        `generateAndFilter: ${filterFailures} candidates failed filtering (excluded \u2014 fail-closed)`
      );
    }
    const rejected = count - value.length - (generateFailures + filterFailures);
    if (rejected > 0) {
      rt.log(`generateAndFilter: ${rejected} of ${count} candidates rejected by filter`);
    }
    const stats = {
      itemsIn: count,
      itemsOut: value.length,
      agentsSpawned,
      dropped: generateFailures + filterFailures,
      truncated: 0
    };
    pendingTrail.sort(
      (a, b) => a.itemIndex !== b.itemIndex ? a.itemIndex - b.itemIndex : a.stageOrder - b.stageOrder
    );
    const trail = pendingTrail.map((e) => e.record);
    emitDigest(rt, {
      stage: STAGE,
      counts: {
        requested: count,
        kept: value.length,
        rejected: Math.max(0, rejected),
        failed: generateFailures + filterFailures
      }
    });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/loop-until-done.ts
  var STAGE2 = LOOP_STAGE;
  async function loopUntilDone(rt, options) {
    const { initial, body, maxIterations, dryRounds, budgetFloor } = options;
    if (maxIterations !== void 0 && maxIterations < 1) {
      throw new Error(
        `loopUntilDone: maxIterations must be >= 1, got ${maxIterations}`
      );
    }
    if (dryRounds !== void 0 && dryRounds < 1) {
      throw new Error(
        `loopUntilDone: dryRounds must be >= 1, got ${dryRounds}`
      );
    }
    if (budgetFloor !== void 0 && budgetFloor < 0) {
      throw new Error(
        `loopUntilDone: budgetFloor must be >= 0, got ${budgetFloor}`
      );
    }
    if (budgetFloor !== void 0 && maxIterations === void 0 && dryRounds === void 0 && rt.budget.total === null) {
      throw new Error(
        `loopUntilDone: budgetFloor is the only stop condition but no budget target is set (rt.budget.total is null) \u2014 an inert floor means an unbounded loop; add maxIterations or dryRounds, or run with a token target`
      );
    }
    const warnings = [];
    const trail = [];
    let state = initial;
    let iterationsDone = 0;
    let consecutiveDry = 0;
    let agentsSpawned = 0;
    let currentIteration = 0;
    const countingRt = {
      agent: (prompt, opts) => {
        agentsSpawned++;
        const label = opts?.label != null ? `${opts.label}${LOOP_ITER_MARKER}${currentIteration}` : `${STAGE2}:iter:${currentIteration}`;
        return rt.agent(prompt, { ...opts, label });
      },
      parallel: (thunks) => rt.parallel(thunks),
      pipeline: (...args) => rt.pipeline(...args),
      phase: (title) => rt.phase(title),
      log: (message) => rt.log(message),
      budget: rt.budget,
      workflow: rt.workflow
    };
    if (budgetFloor !== void 0 && rt.budget.total === null) {
      warn(
        rt,
        warnings,
        `loopUntilDone: budgetFloor=${budgetFloor} is inert (no budget target set)`
      );
    }
    const runLoop = async () => {
      while (true) {
        if (budgetFloor !== void 0 && rt.budget.total !== null) {
          const remaining = rt.budget.remaining();
          if (remaining <= budgetFloor) {
            warn(
              rt,
              warnings,
              `loopUntilDone: stopped by budgetFloor (remaining=${remaining} <= floor=${budgetFloor}) after ${iterationsDone} iterations`
            );
            return "budgetFloor";
          }
        }
        if (maxIterations !== void 0 && iterationsDone >= maxIterations) {
          warn(
            rt,
            warnings,
            `loopUntilDone: stopped by maxIterations=${maxIterations} after ${iterationsDone} iterations`
          );
          if (trail.length > 0) {
            trail[trail.length - 1].decision = "maxIterations";
          }
          return "maxIterations";
        }
        currentIteration = iterationsDone + 1;
        const tick = await body(countingRt, state, iterationsDone + 1);
        const tickIndex = iterationsDone;
        state = tick.state;
        iterationsDone++;
        trail.push(makeRecord(`${STAGE2}:tick:${tickIndex}`, tick.state !== null));
        if (tick.done === true) {
          trail[trail.length - 1].decision = "done";
          return "done";
        }
        if (dryRounds !== void 0) {
          if (tick.progressed === false) {
            consecutiveDry++;
          } else {
            consecutiveDry = 0;
          }
          if (consecutiveDry >= dryRounds) {
            warn(
              rt,
              warnings,
              `loopUntilDone: stopped by dryRounds=${dryRounds} after ${iterationsDone} iterations`
            );
            trail[trail.length - 1].decision = "dryRounds";
            return "dryRounds";
          }
        }
      }
    };
    const stoppedBy = await runLoop();
    emitDigest(rt, { stage: STAGE2, output: stoppedBy, counts: { iterations: iterationsDone } });
    return buildResult(state, iterationsDone, stoppedBy, warnings, trail, agentsSpawned);
  }
  function buildResult(state, iterations, stoppedBy, warnings, trail, agentsSpawned) {
    const stats = {
      itemsIn: iterations,
      itemsOut: iterations,
      agentsSpawned,
      dropped: 0,
      truncated: 0
    };
    return {
      value: { state, iterations, stoppedBy },
      stats,
      warnings,
      trail
    };
  }

  // doc-rewrite.workflow.ts
  var GENERATE_EFFORT = "high";
  var FILTER_EFFORT = "medium";
  var EVALUATE_EFFORT_DEFAULT = "high";
  var OPTIMIZE_EFFORT = "high";
  var CANDIDATE_SCHEMA = {
    type: "object",
    properties: {
      rewrite: { type: "string" },
      angle: { type: "string" }
    },
    required: ["rewrite", "angle"],
    additionalProperties: false
  };
  var EVALUATOR_SCHEMA = {
    type: "object",
    properties: {
      pass: { type: "boolean" },
      feedback: { type: "string" }
    },
    required: ["pass", "feedback"],
    additionalProperties: false
  };
  var OPTIMIZER_SCHEMA = {
    type: "object",
    properties: {
      rewrite: { type: "string" }
    },
    required: ["rewrite"],
    additionalProperties: false
  };
  var ANGLES = [
    "concision-first",
    // index 0: minimize words, maximize signal
    "examples-first",
    // index 1: lead with concrete usage examples
    "structure-first"
    // index 2: organize with clear headers and hierarchy
  ];
  function angleForIndex(index) {
    return ANGLES[index % ANGLES.length] ?? "concision-first";
  }
  function parseInput(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        'doc-rewrite: input must be an object with "docPath" and "criteria" fields \u2014 received: ' + (raw === null ? "null" : typeof raw)
      );
    }
    const obj = raw;
    if (obj["docPath"] === void 0) {
      throw new Error(
        'doc-rewrite: missing required field "docPath" \u2014 provide the path to the document to rewrite'
      );
    }
    if (typeof obj["docPath"] !== "string" || obj["docPath"].trim().length === 0) {
      throw new Error(
        'doc-rewrite: "docPath" must be a non-empty string \u2014 provide the path to the document to rewrite'
      );
    }
    if (obj["criteria"] === void 0) {
      throw new Error(
        'doc-rewrite: missing required field "criteria" \u2014 provide an array of non-empty evaluation criteria strings'
      );
    }
    if (!Array.isArray(obj["criteria"])) {
      throw new Error(
        'doc-rewrite: "criteria" must be an array of non-empty strings'
      );
    }
    const rawCriteria = obj["criteria"];
    if (rawCriteria.length === 0) {
      throw new Error(
        'doc-rewrite: "criteria" must be a non-empty array \u2014 provide at least one evaluation criterion'
      );
    }
    for (let i = 0; i < rawCriteria.length; i++) {
      const c = rawCriteria[i];
      if (typeof c !== "string" || c.trim().length === 0) {
        throw new Error(
          `doc-rewrite: criteria[${i}] must be a non-empty string \u2014 all criteria must be non-empty`
        );
      }
    }
    const criteria = rawCriteria;
    let candidates = 3;
    if (obj["candidates"] !== void 0) {
      if (typeof obj["candidates"] !== "number" || !Number.isInteger(obj["candidates"])) {
        throw new Error(
          'doc-rewrite: "candidates" must be an integer between 1 and 5'
        );
      }
      candidates = obj["candidates"];
      if (candidates < 1 || candidates > 5) {
        throw new Error(
          `doc-rewrite: "candidates" must be between 1 and 5, got ${candidates}`
        );
      }
    }
    let maxIterations = 4;
    if (obj["maxIterations"] !== void 0) {
      if (typeof obj["maxIterations"] !== "number" || !Number.isInteger(obj["maxIterations"])) {
        throw new Error(
          'doc-rewrite: "maxIterations" must be an integer >= 1'
        );
      }
      maxIterations = obj["maxIterations"];
      if (maxIterations < 1) {
        throw new Error(
          `doc-rewrite: "maxIterations" must be >= 1, got ${maxIterations}`
        );
      }
    }
    const effort = parseConfig(obj).effort ?? null;
    return {
      docPath: obj["docPath"],
      criteria,
      candidates,
      maxIterations,
      effort
    };
  }
  async function run(rt, input) {
    const warnings = [];
    const generateEffort = resolveEffort(input.effort?.["generate"], GENERATE_EFFORT);
    const filterEffort = resolveEffort(input.effort?.["filter"], FILTER_EFFORT);
    const evaluateEffort = resolveVerifierEffort(input.effort?.["evaluate"], EVALUATE_EFFORT_DEFAULT);
    const optimizeEffort = resolveEffort(input.effort?.["optimize"], OPTIMIZE_EFFORT);
    rt.phase("Generate");
    const generateResult = await generateAndFilter(rt, {
      count: input.candidates,
      generateSchema: CANDIDATE_SCHEMA,
      generateEffort,
      filterEffort,
      generatePrompt: (index) => {
        const angle = angleForIndex(index);
        return `Generate a rewrite of the document at path: ${input.docPath}
Rewrite angle: ${angle}
You must READ the document at ${input.docPath} directly \u2014 you have filesystem access.
Evaluation criteria (your rewrite must satisfy all of them):
` + input.criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n") + `
Return { "rewrite": "<full rewritten document>", "angle": "${angle}" }`;
      },
      filterPrompt: (candidate) => `Evaluate this candidate rewrite against EACH criterion STRICTLY.
Original document is at: ${input.docPath} \u2014 read it to compare.
Criteria:
` + input.criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n") + `
Candidate rewrite (angle: ${candidate.angle}):
${candidate.rewrite}

Pass ONLY if ALL criteria are met. Return { "pass": true|false, "reason": "<explanation>" }`,
      phase: "Generate"
    });
    for (const w of generateResult.warnings) warnings.push(w);
    let seedDraft;
    const survivors = generateResult.value;
    if (survivors.length > 0) {
      const firstSurvivor = survivors[0];
      seedDraft = firstSurvivor !== void 0 ? firstSurvivor.rewrite : "";
    } else {
      warn(
        rt,
        warnings,
        "doc-rewrite [Generate]: all candidates were rejected by the filter \u2014 this is typically a CRITERIA problem: criteria that are too strict will reject every candidate. Review your criteria for feasibility. Seeding the refinement loop with a fresh rewrite."
      );
      const freshSeed = await rt.agent(
        `Generate a single rewrite of the document at path: ${input.docPath}
You must READ the document at ${input.docPath} directly.
Criteria:
` + input.criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n") + `
Do your best to satisfy as many criteria as possible.
Return { "rewrite": "<full rewritten document>", "angle": "balanced" }`,
        {
          schema: CANDIDATE_SCHEMA,
          label: "doc-rewrite:seed-fallback",
          phase: "Generate",
          // Same stage class as generateAndFilter's generate role — this is the
          // fallback path for the identical job.
          effort: generateEffort
        }
      );
      if (freshSeed === null) {
        throw new Error(
          "doc-rewrite: all filter candidates were rejected AND the fallback seed agent failed. Use resumeFromRunId to retry \u2014 completed generate calls are cached."
        );
      }
      seedDraft = freshSeed.rewrite;
    }
    rt.phase("Refine");
    const loopResult = await loopUntilDone(rt, {
      maxIterations: input.maxIterations,
      initial: { draft: seedDraft, feedback: null },
      body: async (loopRt, state) => {
        const evaluatorPrompt = `Evaluator: does this draft meet ALL criteria? Read the original at ${input.docPath}.
Criteria:
` + input.criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n") + `

Current draft:
${state.draft}

Evaluate STRICTLY against the original document's intent (read ${input.docPath}).
Return { "pass": true|false, "feedback": "<what passes or what needs improvement>" }`;
        const evaluation = await loopRt.agent(evaluatorPrompt, {
          schema: EVALUATOR_SCHEMA,
          label: "doc-rewrite:evaluator",
          phase: "Refine",
          effort: evaluateEffort
        });
        if (evaluation === null) {
          return { state, done: false, progressed: false };
        }
        if (evaluation.pass) {
          return { state: { draft: state.draft, feedback: evaluation.feedback }, done: true };
        }
        const optimizerPrompt = `Optimizer: improve this draft based on the evaluator feedback.
Original document is at: ${input.docPath} \u2014 read it for context.
Criteria:
` + input.criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n") + `

Current draft:
${state.draft}

Evaluator feedback: ${evaluation.feedback}

Produce an improved version that addresses all feedback points.
Return { "rewrite": "<full improved document>" }`;
        const optimized = await loopRt.agent(optimizerPrompt, {
          schema: OPTIMIZER_SCHEMA,
          label: "doc-rewrite:optimizer",
          phase: "Refine",
          effort: optimizeEffort
        });
        if (optimized === null) {
          return {
            state: { draft: state.draft, feedback: evaluation.feedback },
            done: false,
            progressed: false
          };
        }
        return {
          state: { draft: optimized.rewrite, feedback: evaluation.feedback },
          done: false,
          progressed: true
        };
      }
    });
    for (const w of loopResult.warnings) warnings.push(w);
    rt.phase("Finalize");
    const { state: finalState, iterations, stoppedBy } = loopResult.value;
    return {
      finalDoc: finalState.draft,
      // HONEST: approved only when the evaluator explicitly said "done"
      approved: stoppedBy === "done",
      iterations,
      stoppedBy,
      envelope: { trail: collectTrail(generateResult, loopResult) },
      warnings
    };
  }
  var doc_rewrite_workflow_default = defineWorkflow({
    meta: {
      name: "doc-rewrite",
      description: "Rewrites a document against a set of quality criteria using an evaluator-optimizer loop: generates diverse candidate rewrites, filters them, then iteratively refines the best candidate until all criteria are met or the iteration budget is exhausted.",
      whenToUse: "Use when you need to rewrite a document to meet specific quality criteria, with iterative refinement until the evaluator approves the result.",
      phases: [
        { title: "Generate", detail: "Generate diverse candidate rewrites and filter against criteria" },
        { title: "Refine", detail: "Evaluator-optimizer loop: evaluate the draft, improve until criteria met" },
        { title: "Finalize", detail: "Surface the final document with honest approval status" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(doc_rewrite_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

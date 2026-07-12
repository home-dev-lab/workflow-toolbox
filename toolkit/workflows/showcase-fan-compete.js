export const meta = {
  "name": "showcase-fan-compete",
  "description": "demo-showcase-v2 pipeline L2 nested stage: fanOutAndSynthesize (scatter-gather) + tournament (judge panel). Every agent honors args.perAgent, defaulting to haiku + low. A render fixture, not real work.",
  "whenToUse": "Runs inside the nested L2 pipeline of demo-showcase-v2 (or standalone as a render fixture). Not a real task workflow.",
  "phases": [
    {
      "title": "Fan",
      "detail": "fanOutAndSynthesize — scatter angle workers, gather one brief"
    },
    {
      "title": "Compete",
      "detail": "tournament — attempts, judges, synthesis funnel"
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

  // showcase-fan-compete.workflow.ts
  var showcase_fan_compete_workflow_exports = {};
  __export(showcase_fan_compete_workflow_exports, {
    default: () => showcase_fan_compete_workflow_default
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

  // ../packages/patterns/src/cache-warm.ts
  var WARMUP_PROMPT = "Reply with a single word: ready.";
  async function parallelWithCacheWarm(rt, thunks, enabled) {
    if (!enabled || thunks.length <= 1) {
      return rt.parallel(thunks);
    }
    const [first, ...rest] = thunks;
    const firstResult = await Promise.resolve().then(() => first()).then((v) => v).catch(() => null);
    const restResults = await rt.parallel(rest);
    return [firstResult, ...restResults];
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

  // ../packages/patterns/src/fan-out-and-synthesize.ts
  var STAGE = "fanOutAndSynthesize";
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
      maxItems,
      cacheWarm
    } = options;
    if (tasks.length === 0) {
      throw new Error(
        "fanOutAndSynthesize: tasks must not be empty \u2014 nothing to fan out"
      );
    }
    assertAgentTypeOption(STAGE, "taskType", taskType);
    assertAgentTypeOption(STAGE, "synthesisType", synthesisType);
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
        label: `${STAGE}:task:${i}`,
        ...phase !== void 0 ? { phase } : {},
        ...taskSchema !== void 0 ? { schema: taskSchema } : {},
        ...taskModel !== void 0 ? { model: taskModel } : {},
        ...taskEffort !== void 0 ? { effort: taskEffort } : {},
        ...taskType !== void 0 ? { agentType: taskType } : {}
      };
      agentsSpawned++;
      return rt.agent(taskPrompt(task, i), taskOpts);
    });
    const taskResults = await parallelWithCacheWarm(rt, taskThunks, cacheWarm ?? false);
    const parts = [];
    let dropped = 0;
    for (let i = 0; i < taskResults.length; i++) {
      const r = taskResults[i];
      trail.push(makeRecord(`${STAGE}:task:${i}`, r !== null, {
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
        label: `${STAGE}:synthesize`,
        ...phase !== void 0 ? { phase } : {},
        ...synthesisSchema !== void 0 ? { schema: synthesisSchema } : {},
        ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
        ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {},
        ...synthesisType !== void 0 ? { agentType: synthesisType } : {}
      };
      agentsSpawned++;
      const synthesis = await rt.agent(synthesisPrompt(parts), synthOpts);
      trail.push(makeRecord(`${STAGE}:synthesize`, synthesis !== null, {
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
      stage: STAGE,
      output: value === null ? "synthesis: none" : `synthesis from ${parts.length}/${tasks.length} tasks`,
      counts: { tasks: tasks.length, completed: parts.length }
    });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/tournament.ts
  var STAGE2 = "tournament";
  var JUDGE_SCHEMA = {
    type: "object",
    properties: {
      score: { type: "number", minimum: 0, maximum: 10 },
      reason: { type: "string" }
    },
    required: ["score", "reason"],
    additionalProperties: false
  };
  function median(scores) {
    const sorted = [...scores].sort((a, b) => a - b);
    const upper = sorted[Math.floor(sorted.length / 2)];
    if (upper === void 0) return null;
    if (sorted.length % 2 === 1) {
      return upper;
    }
    const lower = sorted[sorted.length / 2 - 1];
    return lower === void 0 ? null : (lower + upper) / 2;
  }
  async function tournament(rt, options) {
    const {
      angles,
      attemptPrompt,
      attemptSchema,
      attemptModel,
      attemptEffort,
      attemptType,
      judgeCount: judgeCountOpt = 3,
      judgePrompt,
      judgeModel,
      judgeEffort,
      judgeType,
      synthesisPrompt,
      synthesisSchema,
      synthesisModel,
      synthesisEffort,
      synthesisType,
      phase,
      cacheWarm
    } = options;
    if (angles.length < 2) {
      throw new Error(
        `tournament: angles must have >= 2 entries (got ${angles.length}) \u2014 one attempt is not a tournament`
      );
    }
    const seenAngles = /* @__PURE__ */ new Set();
    for (const angle of angles) {
      if (seenAngles.has(angle)) {
        throw new Error(
          `tournament: duplicate angle "${angle}" \u2014 each angle must appear exactly once`
        );
      }
      seenAngles.add(angle);
    }
    if (judgeCountOpt < 1) {
      throw new Error(
        `tournament: judgeCount must be >= 1, got ${judgeCountOpt}`
      );
    }
    assertAgentTypeOption(STAGE2, "attemptType", attemptType);
    assertAgentTypeOption(STAGE2, "judgeType", judgeType);
    assertAgentTypeOption(STAGE2, "synthesisType", synthesisType);
    let agentsSpawned = 0;
    let droppedAttempts = 0;
    let nullJudgeVoteCount = 0;
    const warnings = [];
    const trail = [];
    if (cacheWarm) {
      agentsSpawned++;
      trail.push(await runCacheWarmup(rt, warnings, `${STAGE2}:attempt:warm`, STAGE2, {
        ...phase !== void 0 ? { phase } : {},
        ...attemptModel !== void 0 ? { model: attemptModel } : {},
        ...attemptEffort !== void 0 ? { effort: attemptEffort } : {},
        ...attemptType !== void 0 ? { agentType: attemptType } : {}
      }));
    }
    const attemptThunks = angles.map((angle, i) => async () => {
      const opts = {
        label: `${STAGE2}:attempt:${i}`,
        ...phase !== void 0 ? { phase } : {},
        ...attemptSchema !== void 0 ? { schema: attemptSchema } : {},
        ...attemptModel !== void 0 ? { model: attemptModel } : {},
        ...attemptEffort !== void 0 ? { effort: attemptEffort } : {},
        ...attemptType !== void 0 ? { agentType: attemptType } : {}
      };
      agentsSpawned++;
      return rt.agent(attemptPrompt(angle, i), opts);
    });
    const attemptResults = await rt.parallel(attemptThunks);
    const survivingAttempts = [];
    for (let i = 0; i < attemptResults.length; i++) {
      const attempt = attemptResults[i];
      trail.push(makeRecord(`${STAGE2}:attempt:${i}`, attempt !== null, {
        ...attemptModel !== void 0 ? { model: attemptModel } : {},
        ...attemptEffort !== void 0 ? { effort: attemptEffort } : {}
      }));
      if (attempt !== null) {
        survivingAttempts.push({ attempt, angle: angles[i], originalIndex: i });
      } else {
        droppedAttempts++;
      }
    }
    if (droppedAttempts > 0) {
      warn(
        rt,
        warnings,
        `tournament: ${droppedAttempts} of ${angles.length} attempts returned null`
      );
    }
    if (survivingAttempts.length === 0) {
      warn(rt, warnings, "tournament: all attempts failed; nothing to judge");
      const stats2 = {
        itemsIn: angles.length,
        itemsOut: 0,
        agentsSpawned,
        dropped: droppedAttempts,
        truncated: 0
      };
      emitDigest(rt, { stage: STAGE2, counts: { attempts: 0 } });
      return { value: null, stats: stats2, warnings, trail };
    }
    const ranked = [];
    let unjudgeableCount = 0;
    if (cacheWarm) {
      agentsSpawned++;
      trail.push(await runCacheWarmup(rt, warnings, `${STAGE2}:judge:warm`, STAGE2, {
        ...phase !== void 0 ? { phase } : {},
        ...judgeModel !== void 0 ? { model: judgeModel } : {},
        ...judgeEffort !== void 0 ? { effort: judgeEffort } : {},
        ...judgeType !== void 0 ? { agentType: judgeType } : {}
      }));
    }
    const panels = await Promise.all(
      survivingAttempts.map(({ attempt, originalIndex }) => {
        const judgeThunks = Array.from({ length: judgeCountOpt }, (_, judgeIndex) => {
          return async () => {
            const opts = {
              schema: JUDGE_SCHEMA,
              label: `${STAGE2}:judge:${originalIndex}:${judgeIndex}`,
              ...phase !== void 0 ? { phase } : {},
              ...judgeModel !== void 0 ? { model: judgeModel } : {},
              ...judgeEffort !== void 0 ? { effort: judgeEffort } : {},
              ...judgeType !== void 0 ? { agentType: judgeType } : {}
            };
            agentsSpawned++;
            return rt.agent(judgePrompt(attempt), opts);
          };
        });
        return rt.parallel(judgeThunks);
      })
    );
    survivingAttempts.forEach(({ attempt, angle, originalIndex }, i) => {
      const judgeResults = panels[i] ?? [];
      for (let judgeIndex = 0; judgeIndex < judgeResults.length; judgeIndex++) {
        const judgeResult = judgeResults[judgeIndex] ?? null;
        trail.push(makeRecord(`${STAGE2}:judge:${originalIndex}:${judgeIndex}`, judgeResult !== null, {
          ...judgeModel !== void 0 ? { model: judgeModel } : {},
          ...judgeEffort !== void 0 ? { effort: judgeEffort } : {},
          ...judgeResult !== null ? { decision: `score=${judgeResult.score}` } : {}
        }));
      }
      const validScores = judgeResults.filter((r) => r !== null).map((r) => r.score);
      nullJudgeVoteCount += judgeResults.filter((r) => r === null).length;
      const medianScore = median(validScores);
      if (medianScore === null) {
        unjudgeableCount++;
        warn(
          rt,
          warnings,
          `tournament: attempt for angle "${angle}" received no judge votes \u2014 excluded from ranking`
        );
      } else {
        ranked.push({ attempt, angle, score: medianScore, originalIndex });
      }
    });
    if (nullJudgeVoteCount > 0) {
      warn(
        rt,
        warnings,
        `tournament: ${nullJudgeVoteCount} judge votes returned null`
      );
    }
    if (ranked.length === 0) {
      warn(rt, warnings, "tournament: empty ranking after judging; synthesis skipped");
      const stats2 = {
        itemsIn: angles.length,
        itemsOut: 0,
        agentsSpawned,
        // dropped = null attempts + unjudgeable attempts (lost work units = attempts)
        // null judge votes are NOT counted in dropped — the attempt survived via median of rest
        dropped: droppedAttempts + unjudgeableCount,
        truncated: 0
      };
      emitDigest(rt, { stage: STAGE2, counts: { attempts: 0 } });
      return { value: null, stats: stats2, warnings, trail };
    }
    ranked.sort((a, b) => b.score - a.score);
    const synthOpts = {
      label: `${STAGE2}:synthesize`,
      ...phase !== void 0 ? { phase } : {},
      ...synthesisSchema !== void 0 ? { schema: synthesisSchema } : {},
      ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
      ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {},
      ...synthesisType !== void 0 ? { agentType: synthesisType } : {}
    };
    agentsSpawned++;
    const synthesis = await rt.agent(synthesisPrompt(ranked), synthOpts);
    const winnerOriginalIndex = ranked[0]?.originalIndex ?? 0;
    trail.push(makeRecord(`${STAGE2}:synthesize`, synthesis !== null, {
      ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
      ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {},
      decision: `winner=${winnerOriginalIndex}`
    }));
    let value = null;
    if (synthesis === null) {
      warn(rt, warnings, "tournament: synthesis agent returned null");
    } else {
      value = synthesis;
    }
    const stats = {
      itemsIn: angles.length,
      itemsOut: ranked.length,
      agentsSpawned,
      dropped: droppedAttempts + unjudgeableCount,
      truncated: 0
    };
    const winner = ranked[0];
    emitDigest(rt, {
      stage: STAGE2,
      ...winner !== void 0 ? { taken: [`attempt:${winner.originalIndex}`] } : {},
      notTaken: ranked.slice(1).map((r) => `attempt:${r.originalIndex}`),
      counts: { attempts: ranked.length }
    });
    return { value, stats, warnings, trail };
  }

  // showcase-fan-compete.workflow.ts
  var GUARD = " IMPORTANT: render demo \u2014 reply with a short line of TEXT ONLY. Do NOT use any tools, and do NOT create, modify, or delete any files.";
  function parseInput(raw) {
    const obj = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return { perAgent: parseConfig(obj).perAgent ?? null };
  }
  async function run(rt0, input) {
    const model = input.perAgent?.model ?? "haiku";
    const rt = withAgentDefaults(rt0, { effort: "low", ...input.perAgent ?? {}, model });
    rt.phase("Fan");
    const fan = await fanOutAndSynthesize(rt, {
      tasks: ["colors", "personality", "catchphrase"],
      taskPrompt: (task, i) => `Render demo, angle ${i}. One short idea about the mascot's ${task}.${GUARD}`,
      synthesisPrompt: (parts) => `Render demo. Fuse these ${parts.length} angle notes into one mascot brief line.${GUARD}`,
      phase: "Fan"
    });
    rt.phase("Compete");
    const compete = await tournament(rt, {
      angles: ["bold", "whimsical"],
      attemptPrompt: (angle, i) => `Render demo, attempt ${i}. Write a ${angle} mascot tagline (one short line).${GUARD}`,
      judgePrompt: (attempt) => `Render demo. Score this tagline 1-10: "${attempt}".${GUARD}`,
      synthesisPrompt: (ranked) => `Render demo. From the best of ${ranked.length} taglines, write the final one line.${GUARD}`,
      phase: "Compete"
    });
    return {
      stage: "fan-compete",
      brief: fan.value,
      tagline: compete.value,
      envelope: { trail: collectTrail(fan, compete) }
    };
  }
  var showcase_fan_compete_workflow_default = defineWorkflow({
    meta: {
      name: "showcase-fan-compete",
      description: "demo-showcase-v2 pipeline L2 nested stage: fanOutAndSynthesize (scatter-gather) + tournament (judge panel). Every agent honors args.perAgent, defaulting to haiku + low. A render fixture, not real work.",
      whenToUse: "Runs inside the nested L2 pipeline of demo-showcase-v2 (or standalone as a render fixture). Not a real task workflow.",
      phases: [
        { title: "Fan", detail: "fanOutAndSynthesize \u2014 scatter angle workers, gather one brief" },
        { title: "Compete", detail: "tournament \u2014 attempts, judges, synthesis funnel" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(showcase_fan_compete_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

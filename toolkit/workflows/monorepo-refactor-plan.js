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
        return def.run(rt, input);
      }
    };
  }

  // ../packages/patterns/src/envelope.ts
  function makeRecord(stage, ok, extra) {
    return {
      stage,
      outcome: ok ? "ok" : "null",
      ...extra?.model !== void 0 ? { model: extra.model } : {},
      ...extra?.decision !== void 0 ? { decision: extra.decision } : {}
    };
  }
  function warn(rt, warnings, message) {
    warnings.push(message);
    rt.log(message);
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

  // ../packages/patterns/src/classify-and-act.ts
  async function classifyAndAct(rt, options) {
    const { items, categories, classifyPrompt, actions, classifyModel, phase, maxItems } = options;
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
        label: `classifyAndAct:classify:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...classifyModel !== void 0 ? { model: classifyModel } : {}
      };
      agentsSpawned++;
      const classified = await rt.agent(classifyPrompt(item), classifyOpts);
      if (classified === null) {
        classifyFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0,
          record: makeRecord(`classifyAndAct:classify:${index}`, false, classifyModel !== void 0 ? { model: classifyModel } : void 0)
        });
        throw new Error("classify returned null");
      }
      if (!(classified.category in actions)) {
        classifyFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0,
          record: makeRecord(`classifyAndAct:classify:${index}`, false, classifyModel !== void 0 ? { model: classifyModel } : void 0)
        });
        throw new Error(`classify returned unknown category "${classified.category}"`);
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`classifyAndAct:classify:${index}`, true, {
          ...classifyModel !== void 0 ? { model: classifyModel } : {},
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
        label: `classifyAndAct:act:${category}:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...spec.schema !== void 0 ? { schema: spec.schema } : {},
        ...spec.model !== void 0 ? { model: spec.model } : {}
      };
      agentsSpawned++;
      const result = await rt.agent(spec.prompt(item), actOpts);
      if (result === null) {
        actionFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 1,
          record: makeRecord(`classifyAndAct:act:${category}:${index}`, false, spec.model !== void 0 ? { model: spec.model } : void 0)
        });
        throw new Error("act returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(`classifyAndAct:act:${category}:${index}`, true, spec.model !== void 0 ? { model: spec.model } : void 0)
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
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/generate-and-filter.ts
  var REJECTED = Symbol("generate-and-filter:REJECTED");

  // ../packages/patterns/src/fan-out-and-synthesize.ts
  async function fanOutAndSynthesize(rt, options) {
    const {
      tasks,
      taskPrompt,
      taskSchema,
      taskModel,
      synthesisPrompt,
      synthesisSchema,
      synthesisModel,
      phase,
      maxItems
    } = options;
    if (tasks.length === 0) {
      throw new Error(
        "fanOutAndSynthesize: tasks must not be empty \u2014 nothing to fan out"
      );
    }
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
        label: `fanOutAndSynthesize:task:${i}`,
        ...phase !== void 0 ? { phase } : {},
        ...taskSchema !== void 0 ? { schema: taskSchema } : {},
        ...taskModel !== void 0 ? { model: taskModel } : {}
      };
      agentsSpawned++;
      return rt.agent(taskPrompt(task, i), taskOpts);
    });
    const taskResults = await rt.parallel(taskThunks);
    const parts = [];
    let dropped = 0;
    for (let i = 0; i < taskResults.length; i++) {
      const r = taskResults[i];
      trail.push(makeRecord(`fanOutAndSynthesize:task:${i}`, r !== null, taskModel !== void 0 ? { model: taskModel } : void 0));
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
        label: "fanOutAndSynthesize:synthesize",
        ...phase !== void 0 ? { phase } : {},
        ...synthesisSchema !== void 0 ? { schema: synthesisSchema } : {},
        ...synthesisModel !== void 0 ? { model: synthesisModel } : {}
      };
      agentsSpawned++;
      const synthesis = await rt.agent(synthesisPrompt(parts), synthOpts);
      trail.push(makeRecord("fanOutAndSynthesize:synthesize", synthesis !== null, synthesisModel !== void 0 ? { model: synthesisModel } : void 0));
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
    return { value, stats, warnings, trail };
  }

  // ../packages/runtime/src/constants.ts
  var BEST_MODEL = "fable";

  // ../packages/patterns/src/adversarial-verification.ts
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
      phase,
      maxVerifyClaims
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
              label: `adversarialVerification:verify:${claimIndex}:${voteIndex}`,
              ...phase !== void 0 ? { phase } : {},
              model: effectiveModel
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
            `adversarialVerification:verify:${claimIndex}:${voteIndex}`,
            vote !== null,
            {
              model: effectiveModel,
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
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/plan-and-execute.ts
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
      workerPrompt,
      workerSchema,
      workerModel,
      synthesisPrompt,
      synthesisSchema,
      synthesisModel,
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
    let agentsSpawned = 0;
    const warnings = [];
    const trail = [];
    const planOpts = {
      schema: PLAN_SCHEMA,
      label: "planAndExecute:plan",
      ...phase !== void 0 ? { phase } : {},
      ...planModel !== void 0 ? { model: planModel } : {}
    };
    agentsSpawned++;
    const plan = await rt.agent(planPrompt, planOpts);
    if (plan === null) {
      warn(rt, warnings, "planAndExecute: planner returned null \u2014 nothing executed");
      trail.push(makeRecord("planAndExecute:plan", false, planModel !== void 0 ? { model: planModel } : void 0));
      const stats2 = {
        itemsIn: 0,
        itemsOut: 0,
        agentsSpawned,
        dropped: 0,
        truncated: 0
      };
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
    trail.push(makeRecord("planAndExecute:plan", true, {
      ...planModel !== void 0 ? { model: planModel } : {},
      decision: `subtasks=${keptSubtasks.length}`
    }));
    const keptArray = keptSubtasks;
    const workerThunks = keptArray.map((subtask, i) => async () => {
      const opts = {
        label: `planAndExecute:work:${i}`,
        ...phase !== void 0 ? { phase } : {},
        ...workerSchema !== void 0 ? { schema: workerSchema } : {},
        ...workerModel !== void 0 ? { model: workerModel } : {}
      };
      agentsSpawned++;
      return rt.agent(workerPrompt(subtask, i), opts);
    });
    const rawWorkerResults = await rt.parallel(workerThunks);
    const successfulResults = [];
    let droppedWorkers = 0;
    for (let i = 0; i < rawWorkerResults.length; i++) {
      const r = rawWorkerResults[i];
      trail.push(makeRecord(`planAndExecute:work:${i}`, r !== null, workerModel !== void 0 ? { model: workerModel } : void 0));
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
      return { value: null, stats: stats2, warnings, workerResults: [], trail };
    }
    const synthOpts = {
      label: "planAndExecute:synthesize",
      ...phase !== void 0 ? { phase } : {},
      ...synthesisSchema !== void 0 ? { schema: synthesisSchema } : {},
      ...synthesisModel !== void 0 ? { model: synthesisModel } : {}
    };
    agentsSpawned++;
    const synthesis = await rt.agent(synthesisPrompt(successfulResults), synthOpts);
    trail.push(makeRecord("planAndExecute:synthesize", synthesis !== null, synthesisModel !== void 0 ? { model: synthesisModel } : void 0));
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
    return { value, stats, warnings, workerResults: successfulResults, trail };
  }

  // monorepo-refactor-plan.workflow.ts
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
            rationale: { type: "string" }
          },
          required: ["file", "action", "rationale"],
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
    return {
      goal: obj["goal"],
      areas: obj["areas"]
    };
  }
  async function run(rt, input) {
    const warnings = [];
    const stats = {};
    rt.phase("Map");
    const mapResult = await classifyAndAct(rt, {
      items: input.areas,
      categories: ["dead-code", "duplication", "api-drift", "structure", "healthy"],
      classifyPrompt: (area) => `Inspect this monorepo area against the refactoring goal and classify it into exactly one category: dead-code, duplication, api-drift, structure, or healthy.
Goal: ${input.goal}
Area: ${area}
Return { "category": "<one of the five categories>" }`,
      actions: {
        "dead-code": {
          schema: OBSERVATION_SCHEMA,
          prompt: (area) => `You are making a focused observation on DEAD-CODE in this monorepo area.
Goal: ${input.goal}
Area: ${area}
Inspect the area and report files containing dead or unreachable code.
Return { "observations": [{ "file": "<path>", "detail": "<what makes it dead code>" }] }`
        },
        "duplication": {
          schema: OBSERVATION_SCHEMA,
          prompt: (area) => `You are making a focused observation on DUPLICATION in this monorepo area.
Goal: ${input.goal}
Area: ${area}
Inspect the area and report files with duplicated logic or copy-paste code.
Return { "observations": [{ "file": "<path>", "detail": "<what is duplicated and where>" }] }`
        },
        "api-drift": {
          schema: OBSERVATION_SCHEMA,
          prompt: (area) => `You are making a focused observation on API-DRIFT in this monorepo area.
Goal: ${input.goal}
Area: ${area}
Inspect the area and report files where API contracts have diverged across packages.
Return { "observations": [{ "file": "<path>", "detail": "<the drift and its effect>" }] }`
        },
        "structure": {
          schema: OBSERVATION_SCHEMA,
          prompt: (area) => `You are making a focused observation on STRUCTURE problems in this monorepo area.
Goal: ${input.goal}
Area: ${area}
Inspect the area and report files with structural issues (wrong location, bad boundaries, etc.).
Return { "observations": [{ "file": "<path>", "detail": "<the structural problem>" }] }`
        },
        "healthy": {
          schema: OBSERVATION_SCHEMA,
          // 'haiku' for mechanical healthy-area check — no deep analysis needed
          model: "haiku",
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
      synthesisPrompt: (parts) => `Consolidate into a single analysis brief from these per-area deep analyses.
Goal: ${input.goal}
Analyses: ${JSON.stringify(parts)}
Return { "brief": "<consolidated summary of key problems>", "hotspots": ["<file1>", ...] }`,
      synthesisSchema: BRIEF_SCHEMA,
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
      workerPrompt: (subtask) => `Detail the change proposal: ${subtask.description}
Goal: ${input.goal}
Expand this into concrete file changes with rationale.
Return { "changes": [{ "file": "<path>", "action": "<what to do>", "rationale": "<why>" }] }`,
      workerSchema: CHANGES_SCHEMA,
      synthesisPrompt: (results) => `Compose a draft refactoring plan from these detailed change proposals.
Goal: ${input.goal}
Change proposals: ${JSON.stringify(results)}
Produce a coherent draft plan narrative (plain text) that will feed the final plan synthesis.`,
      maxSubtasks: 8,
      phase: "Plan"
    });
    for (const w of planResult.warnings) warnings.push(w);
    stats["plan"] = planResult.stats;
    rt.phase("Verify");
    let verifiedChanges = [];
    const rejectedChanges = [];
    const workerChanges = planResult.workerResults.flatMap((r) => r.changes);
    if (workerChanges.length > 0) {
      const verifyResult = await adversarialVerification(rt, {
        claims: workerChanges,
        renderClaim: (change) => `Change proposal: "${change.action}" in ${change.file}
Rationale: ${change.rationale}

IMPORTANT: Do NOT trust the rationale above. Open the actual file at ${change.file} and re-derive from the code whether this change is necessary and correct.`,
        maxVerifyClaims: 10,
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
      phase: "Synthesize"
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

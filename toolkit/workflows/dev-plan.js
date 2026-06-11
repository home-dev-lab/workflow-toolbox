export const meta = {
  "name": "dev-plan",
  "description": "Planning half of the dev-workflow family: discovers the repository context, dynamically decomposes the goal into self-sufficient implementation tasks, adversarially critiques each task claim against the actual code, and synthesizes a validated PlanArtifact (tasks with ids, contracts, test plans, done criteria, and a cycle-checked dependency graph) for human review.",
  "whenToUse": "Use to plan a feature or fix before implementation. The human reviews/edits the PlanArtifact, then passes the approved artifact to dev-implement.",
  "phases": [
    {
      "title": "Discover",
      "detail": "Parallel per-area exploration, consolidated project context"
    },
    {
      "title": "Plan",
      "detail": "Dynamic decomposition into self-sufficient candidate tasks"
    },
    {
      "title": "Critique",
      "detail": "Adversarially verify task claims against the actual code"
    },
    {
      "title": "Synthesize",
      "detail": "Final PlanArtifact + deterministic graph validation in code"
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

  // dev-plan.workflow.ts
  var dev_plan_workflow_exports = {};
  __export(dev_plan_workflow_exports, {
    default: () => dev_plan_workflow_default
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

  // ../packages/patterns/src/paths.ts
  function relativizeUnder(root, path) {
    const stripped = root.replace(/\/+$/, "");
    if (!stripped.startsWith("/")) return null;
    if (!path.startsWith(stripped + "/")) return null;
    const rel = path.slice(stripped.length + 1);
    if (rel === "") return null;
    if (rel.startsWith("/")) return null;
    if (rel.split("/").includes("..")) return null;
    return rel;
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

  // dev-plan.workflow.ts
  var DISCOVERY_SCHEMA = {
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
      },
      testCommand: { type: "string" },
      buildCommand: { type: "string" },
      conventions: { type: "string" }
    },
    required: ["observations", "testCommand", "buildCommand", "conventions"],
    additionalProperties: false
  };
  var CONTEXT_SCHEMA = {
    type: "object",
    properties: {
      testCommand: { type: "string" },
      buildCommand: { type: "string" },
      conventions: { type: "string" },
      repoBrief: { type: "string" }
    },
    required: ["testCommand", "buildCommand", "conventions", "repoBrief"],
    additionalProperties: false
  };
  var TASK_FILE_SCHEMA = {
    type: "object",
    properties: {
      path: { type: "string" },
      status: { type: "string", enum: ["existing", "new"] },
      role: { type: "string" }
    },
    required: ["path", "status", "role"],
    additionalProperties: false
  };
  var CANDIDATE_TASKS_SCHEMA = {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            intent: { type: "string" },
            files: { type: "array", items: TASK_FILE_SCHEMA },
            contracts: { type: "string" },
            testPlan: { type: "string" },
            doneCriteria: { type: "array", items: { type: "string" } },
            risk: { type: "string", enum: ["low", "medium", "high"] }
          },
          required: ["title", "intent", "files", "contracts", "testPlan", "doneCriteria", "risk"],
          additionalProperties: false
        }
      }
    },
    required: ["tasks"],
    additionalProperties: false
  };
  var PLAN_ARTIFACT_SCHEMA = {
    type: "object",
    properties: {
      goal: { type: "string" },
      context: {
        type: "object",
        properties: {
          projectDir: { type: "string" },
          testCommand: { type: "string" },
          buildCommand: { type: "string" },
          conventions: { type: "string" }
        },
        required: ["projectDir", "testCommand", "buildCommand", "conventions"],
        additionalProperties: false
      },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            intent: { type: "string" },
            files: { type: "array", items: TASK_FILE_SCHEMA },
            contracts: { type: "string" },
            testPlan: { type: "string" },
            doneCriteria: { type: "array", items: { type: "string" } },
            dependsOn: { type: "array", items: { type: "string" } }
          },
          required: ["id", "title", "intent", "files", "contracts", "testPlan", "doneCriteria", "dependsOn"],
          additionalProperties: false
        }
      },
      risks: { type: "array", items: { type: "string" } },
      outOfScope: { type: "array", items: { type: "string" } }
    },
    required: ["goal", "context", "tasks", "risks", "outOfScope"],
    additionalProperties: false
  };
  function parseInput(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        'dev-plan: input must be an object with "goal" (string), optional "areas" (string[]) and optional "projectDir" (string) \u2014 received: ' + (raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw)
      );
    }
    const obj = raw;
    if (typeof obj["goal"] !== "string" || obj["goal"].trim().length === 0) {
      throw new Error(
        'dev-plan: "goal" must be a non-empty string \u2014 describe the feature or fix to plan (e.g. "Add input validation to the CLI"). Include corrections from prior runs here.'
      );
    }
    let areas;
    if (obj["areas"] === void 0) {
      areas = ["."];
    } else {
      if (!Array.isArray(obj["areas"]) || obj["areas"].length === 0) {
        throw new Error(
          'dev-plan: "areas" must be a non-empty array of strings (or omitted to default to ["."]) \u2014 each element is a directory to discover (e.g. ["src", "test"])'
        );
      }
      for (let i = 0; i < obj["areas"].length; i++) {
        const area = obj["areas"][i];
        if (typeof area !== "string" || area.trim().length === 0) {
          throw new Error(
            `dev-plan: "areas[${i}]" must be a non-empty string \u2014 each element must be a directory path`
          );
        }
      }
      areas = obj["areas"];
    }
    let projectDir = ".";
    if (obj["projectDir"] !== void 0) {
      if (typeof obj["projectDir"] !== "string" || obj["projectDir"].trim().length === 0) {
        throw new Error(
          'dev-plan: "projectDir" must be a non-empty string (or omitted to default to ".") \u2014 the directory the implementer will run commands from'
        );
      }
      projectDir = obj["projectDir"];
    }
    return { goal: obj["goal"], areas, projectDir };
  }
  var RERUN_HINT = "Do NOT resumeFromRunId \u2014 resume replays the same invalid synthesis from cache. Re-run fresh (adjust the goal if the planner keeps producing this shape).";
  function validateArtifact(artifact) {
    const tasks = artifact.tasks;
    if (tasks.length === 0) {
      throw new Error(`dev-plan: synthesized artifact has an empty "tasks" list. ${RERUN_HINT}`);
    }
    const ids = /* @__PURE__ */ new Set();
    for (const task of tasks) {
      if (ids.has(task.id)) {
        throw new Error(
          `dev-plan: duplicate task id "${task.id}" in synthesized artifact \u2014 ids must be unique. ${RERUN_HINT}`
        );
      }
      ids.add(task.id);
    }
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep)) {
          throw new Error(
            `dev-plan: task "${task.id}" dependsOn references unknown task id "${dep}". ${RERUN_HINT}`
          );
        }
      }
    }
    const deps = /* @__PURE__ */ new Map();
    for (const task of tasks) deps.set(task.id, task.dependsOn);
    const state = /* @__PURE__ */ new Map();
    for (const task of tasks) {
      if (state.has(task.id)) continue;
      const stack = [{ id: task.id, nextDep: 0 }];
      state.set(task.id, "visiting");
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame === void 0) break;
        const frameDeps = deps.get(frame.id) ?? [];
        if (frame.nextDep >= frameDeps.length) {
          state.set(frame.id, "done");
          stack.pop();
          continue;
        }
        const dep = frameDeps[frame.nextDep];
        frame.nextDep++;
        const depState = state.get(dep);
        if (depState === "visiting") {
          const path = stack.map((f) => f.id).concat(dep).join(" -> ");
          throw new Error(`dev-plan: dependency cycle detected in synthesized artifact: ${path}. ${RERUN_HINT}`);
        }
        if (depState === void 0) {
          state.set(dep, "visiting");
          stack.push({ id: dep, nextDep: 0 });
        }
      }
    }
  }
  async function run(rt, input) {
    const warnings = [];
    const stats = {};
    rt.phase("Discover");
    const discoverResult = await fanOutAndSynthesize(rt, {
      tasks: input.areas,
      taskPrompt: (area) => `Explore this repository area to ground a development plan.
Goal: ${input.goal}
Project root: ${input.projectDir}
Area: ${area}
Read the actual files. Report: observations relevant to the goal (entry points, existing helpers, test layout), the test command, the build command (empty string if none), and the coding conventions you can verify (style, test framework, idioms).
testCommand and buildCommand MUST be a single shell command executable VERBATIM from the project root \u2014 no prose, no parenthetical commentary, no alternatives. Anything that is advice (gates, caveats, related commands) belongs in conventions instead.
Return { "observations": [{ "file": "<path>", "detail": "<relevant fact>" }], "testCommand": "<cmd or empty>", "buildCommand": "<cmd or empty>", "conventions": "<digest>" }`,
      taskSchema: DISCOVERY_SCHEMA,
      synthesisPrompt: (parts) => `Consolidate the per-area discoveries into one project context for a development plan.
Goal: ${input.goal}
Discoveries: ${JSON.stringify(parts)}
Resolve disagreements conservatively (prefer the command actually present in the area closest to the project root). testCommand and buildCommand MUST each be a single shell command executable VERBATIM from the project root \u2014 no prose, no parenthetical commentary; move any advice into conventions. The conventions digest must be self-sufficient: a reader with NO other context must be able to write idiomatic code from it.
Return { "testCommand": "<cmd or empty>", "buildCommand": "<cmd or empty>", "conventions": "<digest>", "repoBrief": "<one-paragraph project summary>" }`,
      synthesisSchema: CONTEXT_SCHEMA,
      phase: "Discover"
    });
    for (const w of discoverResult.warnings) warnings.push(w);
    stats["discover"] = discoverResult.stats;
    if (discoverResult.value === null) {
      warn(
        rt,
        warnings,
        "Discover phase produced no consolidated context (synthesis dropped) \u2014 planning continues with an EMPTY context; expect a weaker artifact"
      );
    }
    const context = discoverResult.value ?? {
      testCommand: "",
      buildCommand: "",
      conventions: "",
      repoBrief: ""
    };
    rt.phase("Plan");
    const planResult = await planAndExecute(rt, {
      planPrompt: `Decompose the development goal into independent implementation subtasks.
Goal: ${input.goal}
Project brief: ${context.repoBrief}
Conventions: ${context.conventions}
Each subtask must be one coherent unit of work a single developer could TDD in isolation. Prefer fewer, well-scoped subtasks over many fragments.
Return { "subtasks": [{ "description": "<subtask description>" }] }`,
      workerPrompt: (subtask) => `Detail the implementation task: ${subtask.description}
Goal: ${input.goal}
Project brief: ${context.repoBrief}
Conventions: ${context.conventions}
Open the actual files to verify your claims. Produce SELF-SUFFICIENT task records: a fresh-context implementer will see ONLY this record plus the project context.
- intent: WHAT + WHY, readable with zero other context
- files: every file touched, status "existing" (verify it exists!) or "new"; "path" RELATIVE to the project root, never absolute
- contracts: signatures/shapes/invariants the implementation must honor
- testPlan: which failing test(s) to write FIRST
- doneCriteria: each independently checkable
- risk: "low" ONLY for an isolated change (a new file or a single-file edit with no public API or cross-module contract); "medium" or "high" otherwise. Risk decides how much independent scrutiny the task gets in the Critique phase \u2014 understating it ships unverified mistakes into the plan, so when unsure pick the higher value.
Return { "tasks": [{ "title", "intent", "files": [{ "path", "status", "role" }], "contracts", "testPlan", "doneCriteria": ["<criterion>"], "risk": "<low|medium|high>" }] }`,
      workerSchema: CANDIDATE_TASKS_SCHEMA,
      synthesisPrompt: (results) => `Compose a short draft plan narrative from these candidate implementation tasks.
Goal: ${input.goal}
Candidate tasks: ${JSON.stringify(results)}
Plain text. This is a working note for the final synthesis, not the artifact.`,
      maxSubtasks: 8,
      phase: "Plan"
    });
    for (const w of planResult.warnings) warnings.push(w);
    stats["plan"] = planResult.stats;
    const candidateTasks = planResult.workerResults.flatMap((r) => r.tasks);
    rt.phase("Critique");
    let verifiedTasks = [];
    const rejected = [];
    const isIsolatedLowRisk = (task) => task.risk === "low" && task.files.length <= 1;
    const flooredCount = candidateTasks.filter(
      (t) => t.risk === "low" && !isIsolatedLowRisk(t)
    ).length;
    if (flooredCount > 0) {
      warn(
        rt,
        warnings,
        `${flooredCount} task(s) self-rated risk "low" while touching multiple files \u2014 structurally not an isolated change; keeping the full verification quorum for them`
      );
    }
    const selfRatedLow = candidateTasks.filter((t) => t.risk === "low").length;
    if (candidateTasks.length >= 4 && selfRatedLow / candidateTasks.length > 0.8) {
      warn(
        rt,
        warnings,
        `${selfRatedLow} of ${candidateTasks.length} candidate tasks self-rate risk "low" \u2014 an implausibly high fraction; the self-assessed risk gates verification scrutiny, so treat this plan with suspicion`
      );
    }
    if (candidateTasks.length > 0) {
      const critiqueResult = await adversarialVerification(rt, {
        claims: candidateTasks,
        renderClaim: (task) => `Plan task claim: "${task.title}"
Intent: ${task.intent}
Files: ${JSON.stringify(task.files)}
Contracts: ${task.contracts}
Done criteria: ${JSON.stringify(task.doneCriteria)}

IMPORTANT: Do NOT trust this task record. Open the actual files and re-derive:
(1) every file with status "existing" exists, every "new" does NOT already exist;
(2) the contracts match the real code (signatures, types, exports);
(3) each done criterion is concretely checkable (a test or an inspectable fact).
Refute the task if any claim is wrong.`,
        // Risk-aware votes: a low-risk task gets 1 refute-first vote; medium/high
        // keep the full 2-of-3 quorum (effectiveThreshold = min(2, claimVotes)).
        // The single-vote path additionally requires the STRUCTURAL isolation
        // the "low" label claims (single file) — see the floor above.
        votesPerClaim: (task) => isIsolatedLowRisk(task) ? 1 : 3,
        maxVerifyClaims: 12,
        phase: "Critique"
      });
      for (const w of critiqueResult.warnings) warnings.push(w);
      stats["critique"] = critiqueResult.stats;
      verifiedTasks = critiqueResult.value;
    } else {
      warn(rt, warnings, "Plan phase produced no candidate tasks \u2014 Critique phase skipped");
    }
    const keptTasks = [];
    for (const vt of verifiedTasks) {
      if (vt.verdict === "refuted") {
        rejected.push({
          title: vt.claim.title,
          files: vt.claim.files.map((f) => f.path),
          verdict: vt.verdict,
          reason: vt.votes.flatMap((v) => v !== null && v.verdict === "refuted" ? [v.reason] : []).join("; ")
        });
      } else {
        keptTasks.push(vt.claim);
      }
    }
    rt.phase("Synthesize");
    const synthesizePrompt = `Produce the final PlanArtifact from these verified implementation tasks.
Goal: ${input.goal}
Project context: ${JSON.stringify({ projectDir: input.projectDir, ...context })}
Kept tasks (critique survivors): ${JSON.stringify(keptTasks)}
Draft narrative: ${planResult.value ?? "(none)"}
Assign sequential ids ("T1", "T2", \u2026) and a dependsOn graph (ids only, no cycles \u2014 a task lists ONLY tasks whose output it genuinely needs). Order tasks so dependencies come first. Derive risks and outOfScope (explicit NON-goals \u2014 the anti-drift fence).
File paths must be RELATIVE to projectDir, never absolute (dev-implement maps them into per-task worktrees and rejects absolute paths).
Return { "goal", "context": { "projectDir", "testCommand", "buildCommand", "conventions" }, "tasks": [{ "id", "title", "intent", "files": [{ "path", "status", "role" }], "contracts", "testPlan", "doneCriteria": [], "dependsOn": [] }], "risks": [], "outOfScope": [] }`;
    const synthesized = await rt.agent(synthesizePrompt, {
      schema: PLAN_ARTIFACT_SCHEMA,
      label: "dev-plan:synthesize",
      phase: "Synthesize"
    });
    if (synthesized === null) {
      throw new Error(
        "dev-plan: final PlanArtifact synthesis failed \u2014 the synthesis agent died. Use resumeFromRunId to retry from the Synthesize phase (all prior work is cached)."
      );
    }
    validateArtifact(synthesized);
    const normalizedTasks = synthesized.tasks.map((task) => {
      let changed = false;
      const files = task.files.map((file) => {
        if (!file.path.startsWith("/")) return file;
        const rel = relativizeUnder(input.projectDir, file.path);
        if (rel !== null) {
          warn(rt, warnings, `dev-plan: task ${task.id} file path relativized: ${file.path} -> ${rel}`);
          changed = true;
          return { ...file, path: rel };
        }
        warn(
          rt,
          warnings,
          `dev-plan: task ${task.id} file path "${file.path}" is absolute and cannot be relativized under projectDir "${input.projectDir}" \u2014 fix it at the human gate or dev-implement will reject the artifact`
        );
        return file;
      });
      return changed ? { ...task, files } : task;
    });
    const artifact = {
      ...synthesized,
      goal: input.goal,
      context: { ...synthesized.context, projectDir: input.projectDir },
      tasks: normalizedTasks
    };
    return { artifact, rejected, stats, warnings };
  }
  var dev_plan_workflow_default = defineWorkflow({
    meta: {
      name: "dev-plan",
      description: "Planning half of the dev-workflow family: discovers the repository context, dynamically decomposes the goal into self-sufficient implementation tasks, adversarially critiques each task claim against the actual code, and synthesizes a validated PlanArtifact (tasks with ids, contracts, test plans, done criteria, and a cycle-checked dependency graph) for human review.",
      whenToUse: "Use to plan a feature or fix before implementation. The human reviews/edits the PlanArtifact, then passes the approved artifact to dev-implement.",
      phases: [
        { title: "Discover", detail: "Parallel per-area exploration, consolidated project context" },
        { title: "Plan", detail: "Dynamic decomposition into self-sufficient candidate tasks" },
        { title: "Critique", detail: "Adversarially verify task claims against the actual code" },
        { title: "Synthesize", detail: "Final PlanArtifact + deterministic graph validation in code" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(dev_plan_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

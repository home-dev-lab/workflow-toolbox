export const meta = {
  "name": "monorepo-refactor-execute",
  "description": "Execution half of an L3 HITL pair: takes the human-approved plan artifact from monorepo-refactor-plan, executes each step in an isolated worktree, independently verifies each change with a fresh-evidence checker, and produces a deterministic report.",
  "whenToUse": "Use after a human has reviewed and approved the plan artifact from monorepo-refactor-plan. Pass the approved artifact (goal + plan with steps) as the workflow args.",
  "phases": [
    {
      "title": "Execute",
      "detail": "Apply each plan step in an isolated worktree (parallel mutation)"
    },
    {
      "title": "Check",
      "detail": "Independently verify each change with a fresh-evidence checker"
    },
    {
      "title": "Report",
      "detail": "Deterministic tally of succeeded/failed/dropped steps (in code, no agent)"
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

  // monorepo-refactor-execute.workflow.ts
  var monorepo_refactor_execute_workflow_exports = {};
  __export(monorepo_refactor_execute_workflow_exports, {
    default: () => monorepo_refactor_execute_workflow_default
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
  function warn(rt, warnings, message) {
    warnings.push(message);
    rt.log(message);
  }

  // monorepo-refactor-execute.workflow.ts
  var EXECUTE_RESULT_SCHEMA = {
    type: "object",
    properties: {
      done: { type: "boolean" },
      filesTouched: { type: "array", items: { type: "string" } },
      note: { type: "string" }
    },
    required: ["done", "filesTouched", "note"],
    additionalProperties: false
  };
  var CHECK_RESULT_SCHEMA = {
    type: "object",
    properties: {
      verified: { type: "boolean" },
      evidence: { type: "string" }
    },
    required: ["verified", "evidence"],
    additionalProperties: false
  };
  function parseInput(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        "monorepo-refactor-execute: input must be an object \u2014 received: " + (raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw)
      );
    }
    const obj = raw;
    if (typeof obj["goal"] !== "string" || obj["goal"].trim().length === 0) {
      throw new Error(
        'monorepo-refactor-execute: "goal" must be a non-empty string \u2014 provide the refactoring goal from the approved plan artifact'
      );
    }
    if (obj["plan"] === null || typeof obj["plan"] !== "object" || Array.isArray(obj["plan"])) {
      throw new Error(
        'monorepo-refactor-execute: "plan" must be an object \u2014 provide the approved plan artifact from monorepo-refactor-plan'
      );
    }
    const plan = obj["plan"];
    if (typeof plan["planTitle"] !== "string" || plan["planTitle"].trim().length === 0) {
      throw new Error(
        'monorepo-refactor-execute: "plan.planTitle" must be a non-empty string \u2014 the approved plan artifact must include a planTitle'
      );
    }
    if (!Array.isArray(plan["steps"]) || plan["steps"].length === 0) {
      throw new Error(
        'monorepo-refactor-execute: "plan.steps" must be a non-empty array \u2014 provide at least one step in the approved plan (if all steps were pruned, there is nothing to execute)'
      );
    }
    const steps = plan["steps"];
    const parsedSteps = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s === null || typeof s !== "object" || Array.isArray(s)) {
        throw new Error(
          `monorepo-refactor-execute: "plan.steps[${i}]" must be an object \u2014 each step must have order, file, action, and rationale`
        );
      }
      const step = s;
      if (typeof step["order"] !== "number") {
        throw new Error(`monorepo-refactor-execute: "plan.steps[${i}].order" must be a number`);
      }
      if (typeof step["file"] !== "string" || step["file"].trim().length === 0) {
        throw new Error(`monorepo-refactor-execute: "plan.steps[${i}].file" must be a non-empty string`);
      }
      if (typeof step["action"] !== "string" || step["action"].trim().length === 0) {
        throw new Error(`monorepo-refactor-execute: "plan.steps[${i}].action" must be a non-empty string`);
      }
      if (typeof step["rationale"] !== "string") {
        throw new Error(`monorepo-refactor-execute: "plan.steps[${i}].rationale" must be a string`);
      }
      parsedSteps.push({
        order: step["order"],
        file: step["file"],
        action: step["action"],
        rationale: step["rationale"]
      });
    }
    return {
      goal: obj["goal"],
      plan: {
        planTitle: plan["planTitle"],
        steps: parsedSteps
      }
    };
  }
  async function run(rt, input) {
    const warnings = [];
    rt.phase("Execute");
    rt.phase("Check");
    const executeStage = async (_prev, originalItem) => {
      const step = originalItem;
      const execResult = await rt.agent(
        `Apply the change described below to the monorepo.
Goal: ${input.goal}
Step ${step.order}: ${step.action} in ${step.file}
Rationale: ${step.rationale}
Make the change. Report what you did.
Return { "done": true|false, "filesTouched": ["<path>", ...], "note": "<what was done or why it failed>" }`,
        {
          schema: EXECUTE_RESULT_SCHEMA,
          label: `monorepo-refactor-execute:execute:${step.order}`,
          phase: "Execute",
          // Required for parallel mutating agents (arch §8 Risk): each executor
          // gets its own isolated working tree, so concurrent mutations cannot
          // corrupt each other. Worktrees are expensive (per-agent setup) — use
          // ONLY for parallel mutation, never for read-only analysis.
          isolation: "worktree"
        }
      );
      return { step, executeResult: execResult, checkResult: null };
    };
    const checkStage = async (prev) => {
      const data = prev;
      if (data.executeResult === null) {
        return data;
      }
      const checkResult = await rt.agent(
        `Verify the change exists in the working tree for this step.
Goal: ${input.goal}
Step ${data.step.order}: ${data.step.action} in ${data.step.file}
Executor self-report: ${JSON.stringify(data.executeResult)}

IMPORTANT: Do NOT trust the executor self-report above. Read the actual diff for ${data.step.file} and run the relevant tests. Re-derive from first principles whether the change was actually applied correctly.
Return { "verified": true|false, "evidence": "<what you found in the diff/tests>" }`,
        {
          schema: CHECK_RESULT_SCHEMA,
          label: `monorepo-refactor-execute:check:${data.step.order}`,
          phase: "Check"
        }
      );
      return { ...data, checkResult };
    };
    const pipelineResults = await rt.pipeline(
      input.plan.steps,
      executeStage,
      checkStage
    );
    rt.phase("Report");
    const reportSteps = [];
    let succeeded = 0;
    let failed = 0;
    let dropped = 0;
    for (const raw of pipelineResults) {
      if (raw === null) {
        dropped++;
        warn(
          rt,
          warnings,
          "monorepo-refactor-execute: a pipeline item was dropped entirely \u2014 use resumeFromRunId to retry after fixing the root cause"
        );
        continue;
      }
      const data = raw;
      if (data.executeResult === null) {
        dropped++;
        reportSteps.push({
          order: data.step.order,
          file: data.step.file,
          action: data.step.action,
          executed: false,
          verified: false,
          note: "Executor agent returned null \u2014 relaunch with resumeFromRunId after fixing root cause"
        });
        continue;
      }
      const executed = data.executeResult.done;
      const verified = data.checkResult?.verified ?? false;
      const note = data.executeResult.note;
      const evidence = data.checkResult?.evidence;
      const reportStep = {
        order: data.step.order,
        file: data.step.file,
        action: data.step.action,
        executed,
        verified,
        ...note !== void 0 ? { note } : {},
        ...evidence !== void 0 ? { evidence } : {}
      };
      reportSteps.push(reportStep);
      if (executed && verified) {
        succeeded++;
      } else {
        failed++;
      }
    }
    if (failed > 0 || dropped > 0) {
      warn(
        rt,
        warnings,
        `monorepo-refactor-execute: ${failed} step(s) failed, ${dropped} step(s) dropped \u2014 fix the root cause and relaunch with resumeFromRunId; completed steps replay from cache`
      );
    }
    return {
      goal: input.goal,
      planTitle: input.plan.planTitle,
      steps: reportSteps,
      succeeded,
      failed,
      dropped,
      warnings
    };
  }
  var monorepo_refactor_execute_workflow_default = defineWorkflow({
    meta: {
      name: "monorepo-refactor-execute",
      description: "Execution half of an L3 HITL pair: takes the human-approved plan artifact from monorepo-refactor-plan, executes each step in an isolated worktree, independently verifies each change with a fresh-evidence checker, and produces a deterministic report.",
      whenToUse: "Use after a human has reviewed and approved the plan artifact from monorepo-refactor-plan. Pass the approved artifact (goal + plan with steps) as the workflow args.",
      phases: [
        { title: "Execute", detail: "Apply each plan step in an isolated worktree (parallel mutation)" },
        { title: "Check", detail: "Independently verify each change with a fresh-evidence checker" },
        { title: "Report", detail: "Deterministic tally of succeeded/failed/dropped steps (in code, no agent)" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(monorepo_refactor_execute_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

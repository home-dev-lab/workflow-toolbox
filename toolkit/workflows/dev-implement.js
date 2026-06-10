export const meta = {
  "name": "dev-implement",
  "description": "Execution half of the dev-workflow family: re-validates the approved PlanArtifact from dev-plan (the human may have edited it), runs each task sequentially in dependency order through a bounded TDD loop (failing tests first, implement against the contracts, then an independent checker reads the real test output), and reports a deterministic succeeded/failed/skipped tally with per-task evidence.",
  "whenToUse": "Use after a human has reviewed and approved the PlanArtifact from dev-plan. Pass { artifact } (plus optional mutation/maxIterationsPerTask) as the workflow args. Sequential mode works without git.",
  "phases": [
    {
      "title": "Implement",
      "detail": "Per task in dependency order: write failing tests, implement (TDD loop)"
    },
    {
      "title": "Check",
      "detail": "Independent fresh-evidence checker runs the real test command per iteration"
    },
    {
      "title": "Report",
      "detail": "Deterministic succeeded/failed/skipped tally (in code, no agent)"
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

  // dev-implement.workflow.ts
  var dev_implement_workflow_exports = {};
  __export(dev_implement_workflow_exports, {
    default: () => dev_implement_workflow_default
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

  // ../packages/patterns/src/generate-and-filter.ts
  var REJECTED = Symbol("generate-and-filter:REJECTED");

  // ../packages/patterns/src/loop-until-done.ts
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
        const tick = await body(rt, state, iterationsDone + 1);
        const tickIndex = iterationsDone;
        state = tick.state;
        iterationsDone++;
        trail.push(makeRecord(`loopUntilDone:tick:${tickIndex}`, tick.state !== null));
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
    return buildResult(state, iterationsDone, stoppedBy, warnings, trail);
  }
  function buildResult(state, iterations, stoppedBy, warnings, trail) {
    const stats = {
      itemsIn: iterations,
      itemsOut: iterations,
      agentsSpawned: 0,
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

  // dev-implement.workflow.ts
  var RED_RESULT_SCHEMA = {
    type: "object",
    properties: {
      written: { type: "boolean" },
      testFiles: { type: "array", items: { type: "string" } },
      note: { type: "string" }
    },
    required: ["written", "testFiles", "note"],
    additionalProperties: false
  };
  var GREEN_RESULT_SCHEMA = {
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
      green: { type: "boolean" },
      evidence: { type: "string" },
      failureSummary: { type: "string" }
    },
    required: ["green", "evidence", "failureSummary"],
    additionalProperties: false
  };
  function requireString(obj, key, where) {
    const v = obj[key];
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new Error(`dev-implement: ${where}.${key} must be a non-empty string`);
    }
    return v;
  }
  function requireStringArray(obj, key, where) {
    const v = obj[key];
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
      throw new Error(`dev-implement: ${where}.${key} must be an array of strings`);
    }
    return v;
  }
  function parseTask(raw, index) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`dev-implement: artifact.tasks[${index}] must be an object`);
    }
    const t = raw;
    const where = `artifact.tasks[${index}]`;
    const id = requireString(t, "id", where);
    const title = requireString(t, "title", where);
    const intent = requireString(t, "intent", where);
    const contracts = requireString(t, "contracts", where);
    const testPlan = requireString(t, "testPlan", where);
    const doneCriteria = requireStringArray(t, "doneCriteria", where);
    const dependsOn = requireStringArray(t, "dependsOn", where);
    if (!Array.isArray(t["files"])) {
      throw new Error(`dev-implement: ${where}.files must be an array`);
    }
    const files = t["files"].map((f, j) => {
      if (f === null || typeof f !== "object" || Array.isArray(f)) {
        throw new Error(`dev-implement: ${where}.files[${j}] must be an object`);
      }
      const file = f;
      const path = requireString(file, "path", `${where}.files[${j}]`);
      const role = requireString(file, "role", `${where}.files[${j}]`);
      const status = file["status"];
      if (status !== "existing" && status !== "new") {
        throw new Error(`dev-implement: ${where}.files[${j}].status must be "existing" or "new"`);
      }
      return { path, status, role };
    });
    return { id, title, intent, files, contracts, testPlan, doneCriteria, dependsOn };
  }
  function validateGraph(tasks) {
    const ids = /* @__PURE__ */ new Set();
    for (const task of tasks) {
      if (ids.has(task.id)) {
        throw new Error(
          `dev-implement: duplicate task id "${task.id}" in artifact \u2014 ids must be unique (a hand-edit may have copied a task without renaming it)`
        );
      }
      ids.add(task.id);
    }
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep)) {
          throw new Error(
            `dev-implement: task "${task.id}" dependsOn references unknown task id "${dep}" \u2014 if you pruned that task, also remove it from dependsOn lists`
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
          throw new Error(`dev-implement: dependency cycle in artifact: ${path} \u2014 break the cycle and re-run`);
        }
        if (depState === void 0) {
          state.set(dep, "visiting");
          stack.push({ id: dep, nextDep: 0 });
        }
      }
    }
  }
  function parseInput(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        'dev-implement: input must be an object with "artifact" (the approved PlanArtifact from dev-plan), optional "mutation" ("sequential") and optional "maxIterationsPerTask" (number) \u2014 received: ' + (raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw)
      );
    }
    const obj = raw;
    if (obj["artifact"] === null || typeof obj["artifact"] !== "object" || Array.isArray(obj["artifact"]) || obj["artifact"] === void 0) {
      throw new Error(
        'dev-implement: "artifact" must be an object \u2014 pass the approved PlanArtifact produced by dev-plan'
      );
    }
    const a = obj["artifact"];
    const goal = requireString(a, "goal", "artifact");
    if (a["context"] === null || typeof a["context"] !== "object" || Array.isArray(a["context"])) {
      throw new Error("dev-implement: artifact.context must be an object");
    }
    const c = a["context"];
    const context = {
      projectDir: requireString(c, "projectDir", "artifact.context"),
      testCommand: requireString(c, "testCommand", "artifact.context"),
      // buildCommand may legitimately be '' (no build step) — type-check only.
      buildCommand: typeof c["buildCommand"] === "string" ? c["buildCommand"] : "",
      conventions: requireString(c, "conventions", "artifact.context")
    };
    if (!Array.isArray(a["tasks"]) || a["tasks"].length === 0) {
      throw new Error(
        "dev-implement: artifact.tasks must be a non-empty array \u2014 if every task was pruned during review, there is nothing to implement"
      );
    }
    const tasks = a["tasks"].map(parseTask);
    validateGraph(tasks);
    const risks = Array.isArray(a["risks"]) ? a["risks"].filter((r) => typeof r === "string") : [];
    const outOfScope = Array.isArray(a["outOfScope"]) ? a["outOfScope"].filter((r) => typeof r === "string") : [];
    if (obj["mutation"] === "worktree") {
      throw new Error(
        'dev-implement: mutation "worktree" is not yet implemented \u2014 it is reserved for v2 (parallel per-task worktrees + a merge step, git repo required). Use "sequential".'
      );
    }
    if (obj["mutation"] !== void 0 && obj["mutation"] !== "sequential") {
      throw new Error(
        'dev-implement: "mutation" must be "sequential" (default) or "worktree" (reserved for v2)'
      );
    }
    let maxIterationsPerTask = 4;
    if (obj["maxIterationsPerTask"] !== void 0) {
      if (typeof obj["maxIterationsPerTask"] !== "number" || obj["maxIterationsPerTask"] < 1) {
        throw new Error('dev-implement: "maxIterationsPerTask" must be a number >= 1');
      }
      maxIterationsPerTask = Math.floor(obj["maxIterationsPerTask"]);
    }
    return {
      artifact: { goal, context, tasks, risks, outOfScope },
      mutation: "sequential",
      maxIterationsPerTask
    };
  }
  function topologicalOrder(tasks) {
    const done = /* @__PURE__ */ new Set();
    const ordered = [];
    const remaining = [...tasks];
    while (remaining.length > 0) {
      const readyIndex = remaining.findIndex((t) => t.dependsOn.every((d) => done.has(d)));
      if (readyIndex === -1) break;
      const task = remaining.splice(readyIndex, 1)[0];
      done.add(task.id);
      ordered.push(task);
    }
    return ordered;
  }
  async function run(rt, input) {
    const warnings = [];
    const stats = {};
    const { artifact, maxIterationsPerTask } = input;
    const ctx = artifact.context;
    rt.phase("Implement");
    rt.phase("Check");
    const ordered = topologicalOrder(artifact.tasks);
    const statusById = /* @__PURE__ */ new Map();
    const reportTasks = [];
    for (const task of ordered) {
      const blockedBy = task.dependsOn.filter((d) => statusById.get(d) !== "succeeded");
      if (blockedBy.length > 0) {
        statusById.set(task.id, "skipped");
        reportTasks.push({
          id: task.id,
          title: task.title,
          status: "skipped",
          iterations: 0,
          evidence: "",
          note: `skipped \u2014 depends on non-succeeded task(s): ${blockedBy.join(", ")}`
        });
        continue;
      }
      const taskBlock = `Goal: ${artifact.goal}
Work from directory: ${ctx.projectDir}
Conventions: ${ctx.conventions}
Out of scope (do NOT touch): ${JSON.stringify(artifact.outOfScope)}
Task ${task.id}: ${task.title}
Intent: ${task.intent}
Files: ${JSON.stringify(task.files)}
Contracts: ${task.contracts}
Test plan: ${task.testPlan}
Done criteria: ${JSON.stringify(task.doneCriteria)}
`;
      const loopResult = await loopUntilDone(rt, {
        initial: { testsWritten: false, green: false, lastFailure: "", evidence: "" },
        maxIterations: maxIterationsPerTask,
        body: async (rtBody, state, iteration) => {
          const next = { ...state };
          if (!next.testsWritten) {
            const red = await rtBody.agent(
              `You are the TDD test-writer for one task. Write the failing tests first \u2014 do NOT implement any production code.
` + taskBlock + `Create/extend the test files per the test plan, run ${ctx.testCommand} to confirm the new tests FAIL for the right reason, and report.
Return { "written": true|false, "testFiles": ["<path>"], "note": "<what was written>" }`,
              {
                schema: RED_RESULT_SCHEMA,
                label: `dev-implement:red:${task.id}`,
                phase: "Implement"
              }
            );
            if (red === null) {
              warn(rtBody, warnings, `dev-implement: red (test-writer) agent died for task ${task.id} \u2014 retrying next iteration`);
              return { state: next, done: false };
            }
            if (!red.written) {
              warn(rtBody, warnings, `dev-implement: test-writer could not write tests for task ${task.id}: ${red.note}`);
              return { state: next, done: false };
            }
            next.testsWritten = true;
          }
          const green = await rtBody.agent(
            `You are the TDD implementer for one task. Make the failing tests pass.
` + taskBlock + `Previous check failure (fix THIS first): ${next.lastFailure === "" ? "(first attempt)" : next.lastFailure}
Implement per the contracts. Do NOT weaken, skip, or delete tests to get green. Run ${ctx.testCommand} yourself and iterate locally before reporting.
Return { "done": true|false, "filesTouched": ["<path>"], "note": "<what changed>" }`,
            {
              schema: GREEN_RESULT_SCHEMA,
              label: `dev-implement:green:${task.id}:${iteration}`,
              phase: "Implement"
            }
          );
          if (green === null) {
            warn(rtBody, warnings, `dev-implement: green (implementer) agent died for task ${task.id} (iteration ${iteration})`);
          }
          const check = await rtBody.agent(
            `You are the independent checker for one task. Independently verify by running the test command yourself \u2014 do NOT trust the implementer's self-report below.
` + taskBlock + `Implementer self-report (untrusted): ${green === null ? "(implementer died \u2014 check the tree anyway: a prior iteration may already pass)" : JSON.stringify(green)}
Run ${ctx.testCommand} from ${ctx.projectDir} and read the ACTUAL output. Then check each done criterion against the working tree.
Return { "green": true|false, "evidence": "<what the run actually showed>", "failureSummary": "<empty string if green, else the failures to fix>" }`,
            {
              schema: CHECK_RESULT_SCHEMA,
              label: `dev-implement:check:${task.id}:${iteration}`,
              phase: "Check"
            }
          );
          if (check === null) {
            warn(rtBody, warnings, `dev-implement: checker agent died for task ${task.id} (iteration ${iteration}) \u2014 treating as not green`);
            next.green = false;
            next.lastFailure = "checker agent died \u2014 no fresh evidence for this iteration";
            return { state: next, done: false };
          }
          next.green = check.green;
          next.evidence = check.evidence;
          next.lastFailure = check.failureSummary;
          return { state: next, done: check.green };
        }
      });
      for (const w of loopResult.warnings) warnings.push(w);
      stats[task.id] = loopResult.stats;
      const outcome = loopResult.value;
      if (outcome.state.green) {
        statusById.set(task.id, "succeeded");
        reportTasks.push({
          id: task.id,
          title: task.title,
          status: "succeeded",
          iterations: outcome.iterations,
          evidence: outcome.state.evidence
        });
      } else {
        statusById.set(task.id, "failed");
        reportTasks.push({
          id: task.id,
          title: task.title,
          status: "failed",
          iterations: outcome.iterations,
          evidence: outcome.state.evidence,
          note: outcome.state.lastFailure === "" ? `failed \u2014 loop stopped by ${outcome.stoppedBy} before any check ran` : `failed \u2014 last check: ${outcome.state.lastFailure}`
        });
      }
    }
    rt.phase("Report");
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    for (const t of reportTasks) {
      if (t.status === "succeeded") succeeded++;
      else if (t.status === "failed") failed++;
      else skipped++;
    }
    if (failed > 0 || skipped > 0) {
      warn(
        rt,
        warnings,
        `dev-implement: ${failed} task(s) failed, ${skipped} skipped \u2014 fix the root cause and relaunch with resumeFromRunId (agents of completed tasks replay from cache), or feed the failure notes back into a corrective dev-plan run`
      );
    }
    return {
      goal: artifact.goal,
      tasks: reportTasks,
      succeeded,
      failed,
      skipped,
      stats,
      warnings
    };
  }
  var dev_implement_workflow_default = defineWorkflow({
    meta: {
      name: "dev-implement",
      description: "Execution half of the dev-workflow family: re-validates the approved PlanArtifact from dev-plan (the human may have edited it), runs each task sequentially in dependency order through a bounded TDD loop (failing tests first, implement against the contracts, then an independent checker reads the real test output), and reports a deterministic succeeded/failed/skipped tally with per-task evidence.",
      whenToUse: "Use after a human has reviewed and approved the PlanArtifact from dev-plan. Pass { artifact } (plus optional mutation/maxIterationsPerTask) as the workflow args. Sequential mode works without git.",
      phases: [
        { title: "Implement", detail: "Per task in dependency order: write failing tests, implement (TDD loop)" },
        { title: "Check", detail: "Independent fresh-evidence checker runs the real test command per iteration" },
        { title: "Report", detail: "Deterministic succeeded/failed/skipped tally (in code, no agent)" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(dev_implement_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

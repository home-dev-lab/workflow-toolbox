export const meta = {
  "name": "dev-implement",
  "description": "Execution half of the dev-workflow family: re-validates the approved PlanArtifact from dev-plan (the human may have edited it), runs each task through a bounded TDD loop (failing tests first, implement against the contracts, then an independent checker reads the real test output), and reports a deterministic per-task tally with evidence. Two mutation modes: \"sequential\" (default — one task at a time in dependency order, no git required) and \"worktree\" (git required — independent tasks run in parallel waves, each in an isolated git worktree, then merge sequentially with an integration check after every merge; conflicts abort conservatively and failure worktrees are kept for forensics).",
  "whenToUse": "Use after a human has reviewed and approved the PlanArtifact from dev-plan. Pass { artifact } (plus optional mutation/maxIterationsPerTask, and for worktree mode optional worktreeSetupCommand/worktreeRoot/signCommits) as the workflow args. Sequential mode works without git; worktree mode requires a git repository and machine commits are unsigned unless signCommits is true. Task file paths must be RELATIVE to projectDir: absolute paths under an absolute projectDir are auto-relativized (with a warning); any other absolute path is rejected at parse time in both modes.",
  "phases": [
    {
      "title": "Setup",
      "detail": "Worktree mode: git check, per-wave worktree provisioning, setup command"
    },
    {
      "title": "Implement",
      "detail": "Per task: write failing tests, implement (TDD loop) — parallel within a wave in worktree mode"
    },
    {
      "title": "Check",
      "detail": "Independent fresh-evidence checker runs the real test command per iteration"
    },
    {
      "title": "Merge",
      "detail": "Worktree mode: sequential merges, integration check after EACH merge, revert on red"
    },
    {
      "title": "Report",
      "detail": "Deterministic tally incl. merge-failed/integration-failed (in code, no agent)"
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

  // ../packages/patterns/src/paths.ts
  function relativizeUnder(root, path) {
    const stripped = root.replace(/\/+$/, "");
    if (!stripped.startsWith("/")) return null;
    if (!path.startsWith(stripped + "/")) return null;
    const rel = path.slice(stripped.length + 1);
    return rel === "" ? null : rel;
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
    let agentsSpawned = 0;
    const countingRt = {
      agent: (...args) => {
        agentsSpawned++;
        return rt.agent(...args);
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
        const tick = await body(countingRt, state, iterationsDone + 1);
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
  var SETUP_RESULT_SCHEMA = {
    type: "object",
    properties: {
      isGitRepo: { type: "boolean" },
      headSha: { type: "string" },
      gitRoot: { type: "string" },
      note: { type: "string" }
    },
    required: ["isGitRepo", "headSha", "gitRoot", "note"],
    additionalProperties: false
  };
  var WT_CREATE_SCHEMA = {
    type: "object",
    properties: {
      created: { type: "array", items: { type: "string" } },
      failures: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, note: { type: "string" } },
          required: ["id", "note"],
          additionalProperties: false
        }
      },
      note: { type: "string" }
    },
    required: ["created", "failures", "note"],
    additionalProperties: false
  };
  var PREPARE_RESULT_SCHEMA = {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      note: { type: "string" }
    },
    required: ["ok", "note"],
    additionalProperties: false
  };
  var FINALIZE_RESULT_SCHEMA = {
    type: "object",
    properties: {
      committed: { type: "boolean" },
      sha: { type: "string" },
      note: { type: "string" }
    },
    required: ["committed", "sha", "note"],
    additionalProperties: false
  };
  var MERGE_RESULT_SCHEMA = {
    type: "object",
    properties: {
      merged: { type: "boolean" },
      conflict: { type: "boolean" },
      preMergeSha: { type: "string" },
      mergeSha: { type: "string" },
      note: { type: "string" }
    },
    required: ["merged", "conflict", "preMergeSha", "mergeSha", "note"],
    additionalProperties: false
  };
  var REVERT_RESULT_SCHEMA = {
    type: "object",
    properties: {
      reverted: { type: "boolean" },
      headSha: { type: "string" },
      note: { type: "string" }
    },
    required: ["reverted", "headSha", "note"],
    additionalProperties: false
  };
  var CLEANUP_RESULT_SCHEMA = {
    type: "object",
    properties: {
      removed: { type: "array", items: { type: "string" } },
      failures: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, note: { type: "string" } },
          required: ["id", "note"],
          additionalProperties: false
        }
      },
      note: { type: "string" }
    },
    required: ["removed", "failures", "note"],
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
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(
        `dev-implement: ${where}.id "${id}" must match [A-Za-z0-9._-]+ \u2014 ids become worktree paths and branch names`
      );
    }
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
  function normalizeTaskFiles(tasks, projectDir) {
    const warnings = [];
    const normalized = tasks.map((task) => {
      let changed = false;
      const files = task.files.map((file) => {
        if (!file.path.startsWith("/")) return file;
        const rel = relativizeUnder(projectDir, file.path);
        if (rel === null) {
          throw new Error(
            `dev-implement: task ${task.id} file path "${file.path}" is absolute and cannot be made relative to projectDir "${projectDir}" \u2014 task files must be relative to projectDir (worktree mode maps them into per-task worktrees; an absolute path would mutate that location verbatim). Edit the artifact.`
          );
        }
        changed = true;
        warnings.push(
          `dev-implement: task ${task.id} file path relativized: ${file.path} -> ${rel} \u2014 absolute paths are unsafe (worktree mode would mutate the main tree); prefer paths relative to projectDir in the artifact`
        );
        return { ...file, path: rel };
      });
      return changed ? { ...task, files } : task;
    });
    return { tasks: normalized, warnings };
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
    const parsedTasks = a["tasks"].map(parseTask);
    validateGraph(parsedTasks);
    const { tasks, warnings: pathWarnings } = normalizeTaskFiles(parsedTasks, context.projectDir);
    const risks = Array.isArray(a["risks"]) ? a["risks"].filter((r) => typeof r === "string") : [];
    const outOfScope = Array.isArray(a["outOfScope"]) ? a["outOfScope"].filter((r) => typeof r === "string") : [];
    if (obj["mutation"] !== void 0 && obj["mutation"] !== "sequential" && obj["mutation"] !== "worktree") {
      throw new Error(
        'dev-implement: "mutation" must be "sequential" (default, no git required) or "worktree" (parallel per-task worktrees + a merge step \u2014 git repo required)'
      );
    }
    const mutation = obj["mutation"] === "worktree" ? "worktree" : "sequential";
    for (const key of ["worktreeSetupCommand", "worktreeRoot", "signCommits"]) {
      if (mutation !== "worktree" && obj[key] !== void 0) {
        throw new Error(`dev-implement: "${key}" is only valid with mutation "worktree"`);
      }
    }
    let worktreeSetupCommand = null;
    if (obj["worktreeSetupCommand"] !== void 0 && obj["worktreeSetupCommand"] !== null) {
      if (typeof obj["worktreeSetupCommand"] !== "string" || obj["worktreeSetupCommand"].trim().length === 0) {
        throw new Error(
          'dev-implement: "worktreeSetupCommand" must be a non-empty VERBATIM shell command \u2014 it runs inside each fresh worktree before its TDD loop (fresh worktrees lack installed dependencies for most ecosystems, e.g. "pnpm install")'
        );
      }
      worktreeSetupCommand = obj["worktreeSetupCommand"];
    }
    let worktreeRoot = null;
    if (obj["worktreeRoot"] !== void 0 && obj["worktreeRoot"] !== null) {
      if (typeof obj["worktreeRoot"] !== "string" || obj["worktreeRoot"].trim().length === 0) {
        throw new Error(
          'dev-implement: "worktreeRoot" must be a non-empty directory path (omit for the sibling default <projectDir>-worktrees)'
        );
      }
      worktreeRoot = obj["worktreeRoot"];
    }
    let signCommits = false;
    if (obj["signCommits"] !== void 0) {
      if (typeof obj["signCommits"] !== "boolean") {
        throw new Error('dev-implement: "signCommits" must be a boolean (default false \u2014 machine commits unsigned)');
      }
      signCommits = obj["signCommits"];
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
      mutation,
      maxIterationsPerTask,
      worktreeSetupCommand,
      worktreeRoot,
      signCommits,
      pathWarnings
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
  function waveLevels(tasks) {
    const level = /* @__PURE__ */ new Map();
    const waves = [];
    for (const task of topologicalOrder(tasks)) {
      const l = task.dependsOn.length === 0 ? 0 : Math.max(...task.dependsOn.map((d) => level.get(d) ?? 0)) + 1;
      level.set(task.id, l);
      (waves[l] ??= []).push(task);
    }
    return waves;
  }
  function buildTaskBlock(artifact, task, workdir) {
    return `Goal: ${artifact.goal}
Work from directory: ${workdir}
Conventions: ${artifact.context.conventions}
Out of scope (do NOT touch): ${JSON.stringify(artifact.outOfScope)}
Task ${task.id}: ${task.title}
Intent: ${task.intent}
Files: ${JSON.stringify(task.files)}
Contracts: ${task.contracts}
Test plan: ${task.testPlan}
Done criteria: ${JSON.stringify(task.doneCriteria)}
`;
  }
  async function runTaskTddLoop(rt, artifact, task, workdir, maxIterationsPerTask, warnings, stats) {
    const ctx = artifact.context;
    const taskBlock = buildTaskBlock(artifact, task, workdir);
    const loopResult = await loopUntilDone(rt, {
      initial: { testsWritten: false, green: false, lastFailure: "", evidence: "" },
      maxIterations: maxIterationsPerTask,
      body: async (rtBody, state, iteration) => {
        const next = { ...state };
        if (!next.testsWritten) {
          const red = await rtBody.agent(
            `You are the TDD test-writer for one task. Write the failing tests first \u2014 do NOT implement any production code.
` + taskBlock + `Create/extend the test files per the test plan, run ${ctx.testCommand} to confirm the new tests FAIL for the right reason, and report.
If the test plan says there is nothing to write (a docs-only or no-test task), that is a SUCCESS, not a failure: return written: true with an empty testFiles list and say so in the note \u2014 the done criteria will still be verified by the checker.
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
Run ${ctx.testCommand} from ${workdir} and read the ACTUAL output. Then check each done criterion against the working tree.
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
    return {
      green: outcome.state.green,
      iterations: outcome.iterations,
      evidence: outcome.state.evidence,
      lastFailure: outcome.state.lastFailure,
      stoppedBy: outcome.stoppedBy
    };
  }
  function failureNote(outcome) {
    return outcome.lastFailure === "" ? `failed \u2014 loop stopped by ${outcome.stoppedBy} before any check ran` : `failed \u2014 last check: ${outcome.lastFailure}`;
  }
  function tally(reportTasks) {
    const t = { succeeded: 0, failed: 0, skipped: 0, mergeFailed: 0, integrationFailed: 0 };
    for (const task of reportTasks) {
      if (task.status === "succeeded") t.succeeded++;
      else if (task.status === "failed") t.failed++;
      else if (task.status === "merge-failed") t.mergeFailed++;
      else if (task.status === "integration-failed") t.integrationFailed++;
      else t.skipped++;
    }
    return t;
  }
  function skippedRecord(task, blockedBy) {
    return {
      id: task.id,
      title: task.title,
      status: "skipped",
      iterations: 0,
      evidence: "",
      note: `skipped \u2014 depends on non-succeeded task(s): ${blockedBy.join(", ")}`
    };
  }
  async function run(rt, input) {
    if (input.mutation === "worktree") return runWorktree(rt, input);
    const warnings = [];
    for (const w of input.pathWarnings) warn(rt, warnings, w);
    const stats = {};
    const { artifact, maxIterationsPerTask } = input;
    rt.phase("Implement");
    rt.phase("Check");
    const ordered = topologicalOrder(artifact.tasks);
    const statusById = /* @__PURE__ */ new Map();
    const reportTasks = [];
    for (const task of ordered) {
      const blockedBy = task.dependsOn.filter((d) => statusById.get(d) !== "succeeded");
      if (blockedBy.length > 0) {
        statusById.set(task.id, "skipped");
        reportTasks.push(skippedRecord(task, blockedBy));
        continue;
      }
      const outcome = await runTaskTddLoop(
        rt,
        artifact,
        task,
        artifact.context.projectDir,
        maxIterationsPerTask,
        warnings,
        stats
      );
      if (outcome.green) {
        statusById.set(task.id, "succeeded");
        reportTasks.push({
          id: task.id,
          title: task.title,
          status: "succeeded",
          iterations: outcome.iterations,
          evidence: outcome.evidence
        });
      } else {
        statusById.set(task.id, "failed");
        reportTasks.push({
          id: task.id,
          title: task.title,
          status: "failed",
          iterations: outcome.iterations,
          evidence: outcome.evidence,
          note: failureNote(outcome)
        });
      }
    }
    rt.phase("Report");
    const tallies = tally(reportTasks);
    if (tallies.failed > 0 || tallies.skipped > 0) {
      warn(
        rt,
        warnings,
        `dev-implement: ${tallies.failed} task(s) failed, ${tallies.skipped} skipped \u2014 fix the root cause and relaunch with resumeFromRunId (agents of completed tasks replay from cache), or feed the failure notes back into a corrective dev-plan run`
      );
    }
    return {
      goal: artifact.goal,
      tasks: reportTasks,
      ...tallies,
      stats,
      warnings
    };
  }
  async function runWorktree(rt, input) {
    const warnings = [];
    for (const w of input.pathWarnings) warn(rt, warnings, w);
    const stats = {};
    const { artifact, maxIterationsPerTask, worktreeSetupCommand, worktreeRoot, signCommits } = input;
    const ctx = artifact.context;
    const wtBranch = (id) => `wt-task/${id}`;
    const signFlag = signCommits ? "" : "-c commit.gpgsign=false ";
    rt.phase("Setup");
    const setup = await rt.agent(
      `You are the environment setup agent for a worktree-mode dev-implement run. First verify this is a git repository: from ${ctx.projectDir} run \`git rev-parse --is-inside-work-tree\`, then capture the current HEAD with \`git rev-parse HEAD\` and the repository root with \`git rev-parse --show-toplevel\`.
Return { "isGitRepo": true|false, "headSha": "<sha or empty>", "gitRoot": "<absolute path or empty>", "note": "<what you saw>" }`,
      { schema: SETUP_RESULT_SCHEMA, label: "dev-implement:setup", phase: "Setup" }
    );
    if (setup === null || !setup.isGitRepo) {
      warn(
        rt,
        warnings,
        `dev-implement: worktree mode requires a git repository at ${ctx.projectDir}` + (setup === null ? " (setup agent died)" : ` \u2014 ${setup.note}`) + `; every task skipped. Use mutation "sequential" for non-git projects.`
      );
      rt.phase("Report");
      const reportTasks2 = artifact.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: "skipped",
        iterations: 0,
        evidence: "",
        note: "skipped \u2014 worktree mode requires a git repository"
      }));
      return { goal: artifact.goal, tasks: reportTasks2, ...tally(reportTasks2), stats, warnings };
    }
    const gitRoot = setup.gitRoot.trim() === "" ? ctx.projectDir : setup.gitRoot;
    const projectSub = ctx.projectDir === gitRoot ? "" : ctx.projectDir.startsWith(gitRoot + "/") ? ctx.projectDir.slice(gitRoot.length) : "";
    const wtRoot = worktreeRoot ?? `${gitRoot}-worktrees`;
    const wtPath = (id) => `${wtRoot}/${id}`;
    const taskWorkdir = (id) => `${wtPath(id)}${projectSub}`;
    const statusById = /* @__PURE__ */ new Map();
    const reportTasks = [];
    const merged = [];
    const waves = waveLevels(artifact.tasks);
    for (let w = 0; w < waves.length; w++) {
      const wave = waves[w];
      const eligible = [];
      for (const task of wave) {
        const blockedBy = task.dependsOn.filter((d) => statusById.get(d) !== "succeeded");
        if (blockedBy.length > 0) {
          statusById.set(task.id, "skipped");
          reportTasks.push(skippedRecord(task, blockedBy));
        } else {
          eligible.push(task);
        }
      }
      if (eligible.length === 0) continue;
      const create = await rt.agent(
        `You are the worktree provisioning agent \u2014 create the isolated git worktrees for this wave, running the commands ONE AT A TIME from ${ctx.projectDir} (concurrent worktree adds race on git locks):
` + eligible.map((t) => `git worktree add ${wtPath(t.id)} -b ${wtBranch(t.id)}`).join("\n") + `
If a path already exists, do NOT force or remove it \u2014 report that task in "failures" (a stale worktree from a previous run is the operator's call to delete).
Return { "created": ["<taskId>"], "failures": [{"id": "<taskId>", "note": "<why>"}], "note": "<summary>" }`,
        { schema: WT_CREATE_SCHEMA, label: `dev-implement:worktrees:wave${w}`, phase: "Setup" }
      );
      if (create === null) {
        warn(rt, warnings, `dev-implement: worktree provisioning agent died for wave ${w} \u2014 the whole wave fails`);
      }
      const createdSet = new Set(create?.created ?? []);
      const createFailures = new Map((create?.failures ?? []).map((f) => [f.id, f.note]));
      const ready = [];
      for (const task of eligible) {
        if (createdSet.has(task.id)) {
          ready.push(task);
        } else {
          statusById.set(task.id, "failed");
          reportTasks.push({
            id: task.id,
            title: task.title,
            status: "failed",
            iterations: 0,
            evidence: "",
            note: `failed \u2014 worktree creation: ${createFailures.get(task.id) ?? (create === null ? "provisioning agent died" : "not reported as created")}`
          });
        }
      }
      const fileOwner = /* @__PURE__ */ new Map();
      for (const task of ready) {
        for (const file of task.files) {
          const owner = fileOwner.get(file.path);
          if (owner !== void 0 && owner !== task.id) {
            warn(
              rt,
              warnings,
              `dev-implement: tasks ${owner} and ${task.id} in the same wave both declare ${file.path} \u2014 worktrees isolate the edits but a merge conflict is likely; consider a dependsOn edge`
            );
          } else {
            fileOwner.set(file.path, task.id);
          }
        }
      }
      const chainResults = await rt.parallel(
        ready.map((task) => async () => {
          if (worktreeSetupCommand !== null) {
            const prep = await rt.agent(
              `You are the worktree preparation agent \u2014 prepare the task worktree for ${task.id}: run this VERBATIM setup command with ${taskWorkdir(task.id)} as the working directory (fresh worktrees lack installed dependencies; this makes the test command runnable):
${worktreeSetupCommand}
Return { "ok": true|false, "note": "<what happened>" }`,
              { schema: PREPARE_RESULT_SCHEMA, label: `dev-implement:prepare:${task.id}`, phase: "Setup" }
            );
            if (prep === null || !prep.ok) {
              return { kind: "prepare-failed", note: prep === null ? "preparation agent died" : prep.note };
            }
          }
          const outcome = await runTaskTddLoop(
            rt,
            artifact,
            task,
            taskWorkdir(task.id),
            maxIterationsPerTask,
            warnings,
            stats
          );
          if (!outcome.green) return { kind: "tdd-failed", outcome };
          const fin = await rt.agent(
            `You are the task-branch committer \u2014 commit the task changes on its task branch: with ${wtPath(task.id)} as the working directory run \`git add -A\`, then commit with \`git ${signFlag}commit\` and capture the sha (\`git rev-parse HEAD\`).
The commit message is the LITERAL line between the markers below \u2014 quote/escape it yourself when invoking git (titles may contain quotes or backticks; never let them reach the shell unquoted):
<<<MESSAGE
${wtBranch(task.id)}: ${task.title}
MESSAGE>>>
Return { "committed": true|false, "sha": "<sha or empty>", "note": "<what happened>" }`,
            { schema: FINALIZE_RESULT_SCHEMA, label: `dev-implement:finalize:${task.id}`, phase: "Implement" }
          );
          if (fin === null || !fin.committed) {
            return { kind: "finalize-failed", outcome, note: fin === null ? "finalize agent died" : fin.note };
          }
          return { kind: "green", outcome, sha: fin.sha };
        })
      );
      const toMerge = [];
      ready.forEach((task, i) => {
        const result = chainResults[i] ?? null;
        const kept = { worktreePath: wtPath(task.id), branch: wtBranch(task.id) };
        if (result === null) {
          statusById.set(task.id, "failed");
          reportTasks.push({
            id: task.id,
            title: task.title,
            status: "failed",
            iterations: 0,
            evidence: "",
            note: "failed \u2014 task chain crashed (an agent threw)",
            ...kept
          });
          warn(rt, warnings, `dev-implement: task chain crashed for ${task.id} \u2014 worktree kept at ${wtPath(task.id)}`);
        } else if (result.kind === "prepare-failed") {
          statusById.set(task.id, "failed");
          reportTasks.push({
            id: task.id,
            title: task.title,
            status: "failed",
            iterations: 0,
            evidence: "",
            note: `failed \u2014 worktree setup command: ${result.note}`,
            ...kept
          });
        } else if (result.kind === "tdd-failed") {
          statusById.set(task.id, "failed");
          reportTasks.push({
            id: task.id,
            title: task.title,
            status: "failed",
            iterations: result.outcome.iterations,
            evidence: result.outcome.evidence,
            note: failureNote(result.outcome),
            ...kept
          });
        } else if (result.kind === "finalize-failed") {
          statusById.set(task.id, "failed");
          reportTasks.push({
            id: task.id,
            title: task.title,
            status: "failed",
            iterations: result.outcome.iterations,
            evidence: result.outcome.evidence,
            note: `failed \u2014 task-branch commit: ${result.note}`,
            ...kept
          });
        } else {
          toMerge.push({ task, outcome: result.outcome });
        }
      });
      rt.phase("Merge");
      for (const { task, outcome } of toMerge) {
        const kept = { worktreePath: wtPath(task.id), branch: wtBranch(task.id) };
        const merge = await rt.agent(
          `You are the merge agent \u2014 from ${ctx.projectDir} (the MAIN tree), merge the task branch ${wtBranch(task.id)} into the current branch: FIRST capture the pre-merge HEAD (\`git rev-parse HEAD\`), then run \`git ${signFlag}merge --no-ff ${wtBranch(task.id)}\`.
On CONFLICT: run \`git merge --abort\` and report conflict: true \u2014 NEVER resolve conflicts yourself. Evidence required: the pre-merge sha and the resulting sha (or '' if aborted).
Return { "merged": true|false, "conflict": true|false, "preMergeSha": "<sha>", "mergeSha": "<sha or empty>", "note": "<what git actually said>" }`,
          { schema: MERGE_RESULT_SCHEMA, label: `dev-implement:merge:${task.id}`, phase: "Merge" }
        );
        if (merge === null || merge.conflict || !merge.merged) {
          statusById.set(task.id, "merge-failed");
          reportTasks.push({
            id: task.id,
            title: task.title,
            status: "merge-failed",
            iterations: outcome.iterations,
            evidence: outcome.evidence,
            note: `merge-failed \u2014 ${merge === null ? "merge agent died (branch not merged)" : merge.note}`,
            ...kept
          });
          continue;
        }
        const integ = await rt.agent(
          `You are the independent integration checker \u2014 verify the integrated main tree: run ${ctx.testCommand} from ${ctx.projectDir} and read the ACTUAL output (the per-task checker saw an isolated worktree; you are checking that the MERGED whole still passes).
Return { "green": true|false, "evidence": "<what the run actually showed>", "failureSummary": "<empty string if green, else the failures>" }`,
          { schema: CHECK_RESULT_SCHEMA, label: `dev-implement:integration:${task.id}`, phase: "Merge" }
        );
        if (integ === null || !integ.green) {
          if (integ === null) {
            warn(rt, warnings, `dev-implement: integration checker died for ${task.id} \u2014 reverting conservatively without evidence`);
          }
          const revert = await rt.agent(
            `You are the merge revert agent \u2014 revert the failed merge: from ${ctx.projectDir} run \`git reset --hard ${merge.preMergeSha}\` and confirm with \`git rev-parse HEAD\`.
Return { "reverted": true|false, "headSha": "<sha>", "note": "<what happened>" }`,
            { schema: REVERT_RESULT_SCHEMA, label: `dev-implement:revert:${task.id}`, phase: "Merge" }
          );
          if (revert === null || !revert.reverted) {
            warn(
              rt,
              warnings,
              `dev-implement: revert ${revert === null ? "agent died" : "failed"} for ${task.id} \u2014 the MAIN tree may still hold the bad merge; manual recovery: git reset --hard ${merge.preMergeSha}`
            );
          }
          statusById.set(task.id, "integration-failed");
          reportTasks.push({
            id: task.id,
            title: task.title,
            status: "integration-failed",
            iterations: outcome.iterations,
            evidence: integ === null ? "" : integ.evidence,
            note: `integration-failed \u2014 ${integ === null ? "integration checker died (conservative revert)" : integ.failureSummary}`,
            ...kept
          });
          continue;
        }
        statusById.set(task.id, "succeeded");
        reportTasks.push({
          id: task.id,
          title: task.title,
          status: "succeeded",
          iterations: outcome.iterations,
          evidence: integ.evidence
        });
        merged.push({ id: task.id, path: wtPath(task.id), branch: wtBranch(task.id) });
      }
    }
    if (merged.length > 0) {
      const cleanup = await rt.agent(
        `You are the cleanup agent \u2014 remove the merged worktrees and their task branches. From ${ctx.projectDir}, for EACH entry run \`git worktree remove <path>\` FIRST and \`git branch -d <branch>\` SECOND (a branch checked out in a live worktree cannot be deleted):
` + merged.map((m) => `${m.id}: ${m.path} (${m.branch})`).join("\n") + `
Do NOT touch any other worktree or branch.
Return { "removed": ["<taskId>"], "failures": [{"id": "<taskId>", "note": "<why>"}], "note": "<summary>" }`,
        { schema: CLEANUP_RESULT_SCHEMA, label: "dev-implement:cleanup", phase: "Merge" }
      );
      if (cleanup === null) {
        warn(rt, warnings, `dev-implement: cleanup agent died \u2014 merged worktrees left on disk under ${wtRoot} (manual: git worktree remove)`);
      } else if (cleanup.failures.length > 0) {
        warn(rt, warnings, `dev-implement: cleanup incomplete for ${cleanup.failures.map((f) => f.id).join(", ")} \u2014 ${cleanup.note}`);
      }
    }
    rt.phase("Report");
    const tallies = tally(reportTasks);
    const keptWorktrees = reportTasks.filter((t) => t.worktreePath !== void 0);
    if (tallies.failed + tallies.mergeFailed + tallies.integrationFailed + tallies.skipped > 0) {
      warn(
        rt,
        warnings,
        `dev-implement: ${tallies.failed} task(s) failed, ${tallies.mergeFailed} merge-failed, ${tallies.integrationFailed} integration-failed, ${tallies.skipped} skipped \u2014 the MAIN tree only contains the ${tallies.succeeded} merged task(s)` + (keptWorktrees.length > 0 ? `; kept worktree(s) for forensics: ${keptWorktrees.map((t) => `${t.id} at ${t.worktreePath ?? ""}`).join(", ")}` : "") + `. Fix the root cause and re-run (worktree creation refuses stale paths \u2014 remove kept worktrees first), or feed the failure notes back into a corrective dev-plan run.`
      );
    }
    return {
      goal: artifact.goal,
      tasks: reportTasks,
      ...tallies,
      stats,
      warnings
    };
  }
  var dev_implement_workflow_default = defineWorkflow({
    meta: {
      name: "dev-implement",
      description: 'Execution half of the dev-workflow family: re-validates the approved PlanArtifact from dev-plan (the human may have edited it), runs each task through a bounded TDD loop (failing tests first, implement against the contracts, then an independent checker reads the real test output), and reports a deterministic per-task tally with evidence. Two mutation modes: "sequential" (default \u2014 one task at a time in dependency order, no git required) and "worktree" (git required \u2014 independent tasks run in parallel waves, each in an isolated git worktree, then merge sequentially with an integration check after every merge; conflicts abort conservatively and failure worktrees are kept for forensics).',
      whenToUse: "Use after a human has reviewed and approved the PlanArtifact from dev-plan. Pass { artifact } (plus optional mutation/maxIterationsPerTask, and for worktree mode optional worktreeSetupCommand/worktreeRoot/signCommits) as the workflow args. Sequential mode works without git; worktree mode requires a git repository and machine commits are unsigned unless signCommits is true. Task file paths must be RELATIVE to projectDir: absolute paths under an absolute projectDir are auto-relativized (with a warning); any other absolute path is rejected at parse time in both modes.",
      phases: [
        { title: "Setup", detail: "Worktree mode: git check, per-wave worktree provisioning, setup command" },
        { title: "Implement", detail: "Per task: write failing tests, implement (TDD loop) \u2014 parallel within a wave in worktree mode" },
        { title: "Check", detail: "Independent fresh-evidence checker runs the real test command per iteration" },
        { title: "Merge", detail: "Worktree mode: sequential merges, integration check after EACH merge, revert on red" },
        { title: "Report", detail: "Deterministic tally incl. merge-failed/integration-failed (in code, no agent)" }
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

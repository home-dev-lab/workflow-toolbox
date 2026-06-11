export const meta = {
  "name": "dev-full",
  "description": "Full mode of the dev-workflow family: chains dev-plan, dev-implement and dev-review-fix in ONE run via workflow() composition over their committed artifacts, converting the human gates into code gates (refuted-ratio abort, degraded-context abort, continue iff at least one task succeeded, in-code change-set handoff). Every abort RETURNS a structured report preserving the completed children's output.",
  "whenToUse": "Use for end-to-end autonomous development ONLY when the operator accepts the whole-chain trust boundary (no human gate from goal to tree mutations). For human-gated steps, run the split workflows instead. Args: {goal, projectDir, scriptPaths: {plan, implement, reviewFix}} plus optional areas/maxRefutedRatio/maxIterationsPerTask/maxFixIterations/dimensions/diffCommand.",
  "phases": [
    {
      "title": "Plan",
      "detail": "dev-plan child; gate A: shape, degraded context, refuted-task ratio"
    },
    {
      "title": "Implement",
      "detail": "dev-implement child; gate B: continue iff >= 1 task succeeded"
    },
    {
      "title": "Review & Fix",
      "detail": "dev-review-fix child on the derived change set (diffCommand wins)"
    },
    {
      "title": "Report",
      "detail": "Deterministic outcome + per-child sections + prefixed warnings (in code)"
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

  // dev-full.workflow.ts
  var dev_full_workflow_exports = {};
  __export(dev_full_workflow_exports, {
    default: () => dev_full_workflow_default
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

  // ../packages/patterns/src/generate-and-filter.ts
  var REJECTED = Symbol("generate-and-filter:REJECTED");

  // dev-full.workflow.ts
  function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function isStringArray(v) {
    return Array.isArray(v) && v.every((x) => typeof x === "string");
  }
  function stringsOrEmpty(v) {
    return isStringArray(v) ? v : [];
  }
  function narrowPlanResult(value) {
    if (!isRecord(value)) {
      return { ok: false, reason: 'plan child returned an unexpected shape (not an object) \u2014 cannot read "artifact"' };
    }
    const artifact = value["artifact"];
    if (!isRecord(artifact)) {
      return { ok: false, reason: 'plan child returned no "artifact" object \u2014 cannot hand off to dev-implement' };
    }
    if (typeof artifact["goal"] !== "string") {
      return { ok: false, reason: 'plan child artifact has no string "goal"' };
    }
    const context = artifact["context"];
    if (!isRecord(context)) {
      return { ok: false, reason: 'plan child artifact has no "context" object' };
    }
    for (const key of ["projectDir", "testCommand", "buildCommand", "conventions"]) {
      if (typeof context[key] !== "string") {
        return { ok: false, reason: `plan child artifact context has no string "${key}"` };
      }
    }
    const tasks = artifact["tasks"];
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { ok: false, reason: 'plan child artifact has no non-empty "tasks" array' };
    }
    for (const task of tasks) {
      if (!isRecord(task) || typeof task["id"] !== "string" || typeof task["title"] !== "string") {
        return { ok: false, reason: 'plan child artifact has a task without string "id"/"title"' };
      }
      const files = task["files"];
      if (!Array.isArray(files) || files.some((f) => !isRecord(f) || typeof f["path"] !== "string")) {
        return { ok: false, reason: `plan child artifact task "${String(task["id"])}" has a malformed "files" list` };
      }
    }
    const rejected = Array.isArray(value["rejected"]) ? value["rejected"] : [];
    return {
      ok: true,
      value: {
        artifact,
        rejected,
        stats: value["stats"] ?? null,
        warnings: stringsOrEmpty(value["warnings"])
      }
    };
  }
  function narrowImplementResult(value) {
    if (!isRecord(value)) {
      return { ok: false, reason: 'implement child returned an unexpected shape (not an object) \u2014 cannot read "succeeded"' };
    }
    for (const key of ["succeeded", "failed", "skipped"]) {
      if (typeof value[key] !== "number") {
        return { ok: false, reason: `implement child returned no numeric "${key}" tally` };
      }
    }
    const tasks = value["tasks"];
    if (!Array.isArray(tasks)) {
      return { ok: false, reason: 'implement child returned no "tasks" array' };
    }
    for (const task of tasks) {
      if (!isRecord(task) || typeof task["id"] !== "string" || typeof task["title"] !== "string" || typeof task["status"] !== "string") {
        return { ok: false, reason: 'implement child report has a task without string "id"/"title"/"status"' };
      }
    }
    return {
      ok: true,
      value: {
        tasks,
        succeeded: value["succeeded"],
        failed: value["failed"],
        skipped: value["skipped"],
        stats: value["stats"] ?? null,
        warnings: stringsOrEmpty(value["warnings"])
      }
    };
  }
  function narrowReviewResult(value) {
    if (!isRecord(value)) {
      return { ok: false, reason: "review child returned an unexpected shape (not an object)" };
    }
    return {
      ok: true,
      value: { value, stats: value["stats"] ?? null, warnings: stringsOrEmpty(value["warnings"]) }
    };
  }
  function parseInput(raw) {
    if (!isRecord(raw)) {
      throw new Error(
        'dev-full: input must be an object with "goal" (string), "projectDir" (string) and "scriptPaths" ({plan, implement, reviewFix} absolute artifact paths) \u2014 received: ' + (raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw)
      );
    }
    if (typeof raw["goal"] !== "string" || raw["goal"].trim().length === 0) {
      throw new Error(
        'dev-full: "goal" must be a non-empty string \u2014 the feature or fix to develop end-to-end. Include corrections from prior runs here (drift mitigation = re-run with an amended goal).'
      );
    }
    const goal = raw["goal"];
    if (typeof raw["projectDir"] !== "string" || raw["projectDir"].trim().length === 0) {
      throw new Error('dev-full: "projectDir" must be a non-empty string \u2014 the root every child command runs from');
    }
    const projectDir = raw["projectDir"];
    let areas;
    if (raw["areas"] === void 0) {
      areas = ["."];
    } else {
      if (!isStringArray(raw["areas"]) || raw["areas"].length === 0 || raw["areas"].some((a) => a.trim() === "")) {
        throw new Error(
          'dev-full: "areas" must be a non-empty array of non-empty strings (or omitted to default to ["."])'
        );
      }
      areas = raw["areas"];
    }
    const sp = raw["scriptPaths"];
    if (!isRecord(sp)) {
      throw new Error(
        'dev-full: "scriptPaths" must be an object {plan, implement, reviewFix} \u2014 absolute paths to the three committed child artifacts (e.g. "<repo>/toolkit/workflows/dev-plan.js")'
      );
    }
    for (const key of ["plan", "implement", "reviewFix"]) {
      if (typeof sp[key] !== "string" || sp[key].trim().length === 0) {
        throw new Error(`dev-full: "scriptPaths.${key}" must be a non-empty string \u2014 absolute path to the committed artifact`);
      }
    }
    const scriptPaths = {
      plan: sp["plan"],
      implement: sp["implement"],
      reviewFix: sp["reviewFix"]
    };
    let maxRefutedRatio = 0.5;
    if (raw["maxRefutedRatio"] !== void 0) {
      if (typeof raw["maxRefutedRatio"] !== "number" || raw["maxRefutedRatio"] < 0 || raw["maxRefutedRatio"] > 1) {
        throw new Error('dev-full: "maxRefutedRatio" must be a number in [0, 1] (default 0.5)');
      }
      maxRefutedRatio = raw["maxRefutedRatio"];
    }
    let maxIterationsPerTask = null;
    if (raw["maxIterationsPerTask"] !== void 0) {
      if (typeof raw["maxIterationsPerTask"] !== "number" || raw["maxIterationsPerTask"] < 1) {
        throw new Error('dev-full: "maxIterationsPerTask" must be a number >= 1 (omit to use the dev-implement default)');
      }
      maxIterationsPerTask = Math.floor(raw["maxIterationsPerTask"]);
    }
    let maxFixIterations = null;
    if (raw["maxFixIterations"] !== void 0) {
      if (typeof raw["maxFixIterations"] !== "number" || raw["maxFixIterations"] < 1) {
        throw new Error('dev-full: "maxFixIterations" must be a number >= 1 (omit to use the dev-review-fix default)');
      }
      maxFixIterations = Math.floor(raw["maxFixIterations"]);
    }
    let dimensions = null;
    if (raw["dimensions"] !== void 0) {
      if (!isStringArray(raw["dimensions"]) || raw["dimensions"].length === 0 || raw["dimensions"].some((d) => d.trim() === "")) {
        throw new Error(
          'dev-full: "dimensions" must be a non-empty array of non-empty strings (omit to use the dev-review-fix default)'
        );
      }
      dimensions = raw["dimensions"];
    }
    let diffCommand = null;
    if (raw["diffCommand"] !== void 0 && raw["diffCommand"] !== null) {
      if (typeof raw["diffCommand"] !== "string" || raw["diffCommand"].trim().length === 0) {
        throw new Error(
          'dev-full: "diffCommand" must be a non-empty VERBATIM shell command (or omitted \u2014 no-git projects fall back to the planned-files derivation)'
        );
      }
      diffCommand = raw["diffCommand"];
    }
    return {
      goal,
      areas,
      projectDir,
      scriptPaths,
      maxRefutedRatio,
      maxIterationsPerTask,
      maxFixIterations,
      dimensions,
      diffCommand
    };
  }
  async function callChild(rt, scriptPath, args) {
    if (rt.budget.total !== null && rt.budget.remaining() === 0) {
      return { ok: false, reason: `budget exhausted before the child at ${scriptPath} could start` };
    }
    try {
      return { ok: true, value: await rt.workflow({ scriptPath }, args) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  async function run(rt, input) {
    const warnings = [];
    let planSection = null;
    let implementResult = null;
    let reviewValue = null;
    const stats = {
      plan: null,
      implement: null,
      review: null
    };
    function finish(outcome, reason) {
      if (reason !== null) rt.log(`dev-full: ${outcome} \u2014 ${reason}`);
      return { outcome, reason, plan: planSection, implement: implementResult, review: reviewValue, stats, warnings };
    }
    rt.phase("Plan");
    rt.log(`dev-full: planning "${input.goal}"`);
    const planCall = await callChild(rt, input.scriptPaths.plan, {
      goal: input.goal,
      areas: input.areas,
      projectDir: input.projectDir
    });
    if (!planCall.ok) return finish("aborted-at-plan", planCall.reason);
    const planNarrow = narrowPlanResult(planCall.value);
    if (!planNarrow.ok) return finish("aborted-at-plan", planNarrow.reason);
    const plan = planNarrow.value;
    planSection = { taskCount: plan.artifact.tasks.length, rejected: plan.rejected, artifact: plan.artifact };
    stats.plan = plan.stats;
    for (const w of plan.warnings) warnings.push(`plan: ${w}`);
    for (const key of ["testCommand", "conventions"]) {
      if (plan.artifact.context[key].trim() === "") {
        return finish(
          "aborted-at-plan",
          `artifact.context.${key} is empty \u2014 the dev-plan Discover phase degraded (see its warnings); dev-implement and dev-review-fix would reject this artifact on entry. Fix discovery (or edit the artifact and fall back to the split workflows).`
        );
      }
    }
    const rejectedCount = plan.rejected.length;
    const ratio = rejectedCount / (rejectedCount + plan.artifact.tasks.length);
    const roundedRatio = Math.round(ratio * 100) / 100;
    if (ratio > input.maxRefutedRatio) {
      return finish(
        "aborted-at-plan",
        `refuted-task ratio ${roundedRatio} exceeds maxRefutedRatio ${input.maxRefutedRatio} (${rejectedCount} rejected vs ${plan.artifact.tasks.length} kept) \u2014 the critique distrusts this plan. Arbitrate from plan.rejected (each entry carries the refuting reason), then re-run with an amended goal.`
      );
    }
    rt.log(
      `dev-full: gate A passed \u2014 ${plan.artifact.tasks.length} tasks kept, ${rejectedCount} rejected (ratio ${roundedRatio} <= ${input.maxRefutedRatio})`
    );
    rt.phase("Implement");
    const implementArgs = { artifact: plan.artifact };
    if (input.maxIterationsPerTask !== null) implementArgs["maxIterationsPerTask"] = input.maxIterationsPerTask;
    const implementCall = await callChild(rt, input.scriptPaths.implement, implementArgs);
    if (!implementCall.ok) return finish("aborted-at-implement", implementCall.reason);
    const implementNarrow = narrowImplementResult(implementCall.value);
    if (!implementNarrow.ok) return finish("aborted-at-implement", implementNarrow.reason);
    const implement = implementNarrow.value;
    implementResult = implement;
    stats.implement = implement.stats;
    for (const w of implement.warnings) warnings.push(`implement: ${w}`);
    if (implement.succeeded === 0) {
      return finish(
        "aborted-at-implement",
        `no task succeeded (0 of ${implement.tasks.length}) \u2014 nothing to review. Feed the per-task failure notes back into a corrective dev-plan run.`
      );
    }
    rt.log(
      `dev-full: gate B passed \u2014 ${implement.succeeded} succeeded, ${implement.failed} failed, ${implement.skipped} skipped`
    );
    const ranIds = new Set(
      implement.tasks.filter((t) => t.status === "succeeded" || t.status === "failed").map((t) => t.id)
    );
    const root = input.projectDir.replace(/\/+$/, "");
    const relativize = (p) => root.startsWith("/") && p.startsWith(root + "/") && p.length > root.length + 1 ? p.slice(root.length + 1) : p;
    const seenPaths = /* @__PURE__ */ new Set();
    const derivedFiles = [];
    for (const task of plan.artifact.tasks) {
      if (!ranIds.has(task.id)) continue;
      for (const file of task.files) {
        const path = relativize(file.path);
        if (!seenPaths.has(path)) {
          seenPaths.add(path);
          derivedFiles.push(path);
        }
      }
    }
    let changedFiles = null;
    if (input.diffCommand === null) {
      if (derivedFiles.length === 0) {
        return finish(
          "aborted-at-review",
          'no changed files could be derived from the plan artifact (the tasks that ran declare no files) \u2014 pass "diffCommand" (git projects) so dev-review-fix can read the real change set.'
        );
      }
      changedFiles = derivedFiles;
      warn(
        rt,
        warnings,
        'changedFiles derived from planned task files \u2014 files created beyond the plan are not reviewed; pass "diffCommand" on git projects for the real diff.'
      );
    }
    const statusLines = implement.tasks.map((t) => `${t.id} (${t.title}): ${t.status}`);
    const changeSummary = `Implemented by dev-implement (per-task outcomes):
${statusLines.join("\n")}` + (changedFiles !== null ? "\n\nNote: the changed-files list approximates the change set from the PLANNED files of succeeded and failed tasks; files created beyond the plan are not covered." : "");
    const reviewArgs = {
      projectDir: plan.artifact.context.projectDir,
      testCommand: plan.artifact.context.testCommand,
      buildCommand: plan.artifact.context.buildCommand,
      conventions: plan.artifact.context.conventions,
      goal: input.goal,
      changeSummary,
      diffCommand: input.diffCommand,
      changedFiles
    };
    if (input.dimensions !== null) reviewArgs["dimensions"] = input.dimensions;
    if (input.maxFixIterations !== null) reviewArgs["maxFixIterations"] = input.maxFixIterations;
    rt.phase("Review & Fix");
    const reviewCall = await callChild(rt, input.scriptPaths.reviewFix, reviewArgs);
    if (!reviewCall.ok) return finish("aborted-at-review", reviewCall.reason);
    const reviewNarrow = narrowReviewResult(reviewCall.value);
    if (!reviewNarrow.ok) return finish("aborted-at-review", reviewNarrow.reason);
    const review = reviewNarrow.value;
    reviewValue = review.value;
    stats.review = review.stats;
    for (const w of review.warnings) warnings.push(`review: ${w}`);
    rt.phase("Report");
    rt.log(
      `dev-full: completed \u2014 plan ${plan.artifact.tasks.length} tasks, implement ${implement.succeeded}/${implement.tasks.length} succeeded, review suiteGreen=${String(review.value["suiteGreen"] ?? "unknown")}`
    );
    return finish("completed", null);
  }
  var dev_full_workflow_default = defineWorkflow({
    meta: {
      name: "dev-full",
      description: "Full mode of the dev-workflow family: chains dev-plan, dev-implement and dev-review-fix in ONE run via workflow() composition over their committed artifacts, converting the human gates into code gates (refuted-ratio abort, degraded-context abort, continue iff at least one task succeeded, in-code change-set handoff). Every abort RETURNS a structured report preserving the completed children's output.",
      whenToUse: "Use for end-to-end autonomous development ONLY when the operator accepts the whole-chain trust boundary (no human gate from goal to tree mutations). For human-gated steps, run the split workflows instead. Args: {goal, projectDir, scriptPaths: {plan, implement, reviewFix}} plus optional areas/maxRefutedRatio/maxIterationsPerTask/maxFixIterations/dimensions/diffCommand.",
      phases: [
        { title: "Plan", detail: "dev-plan child; gate A: shape, degraded context, refuted-task ratio" },
        { title: "Implement", detail: "dev-implement child; gate B: continue iff >= 1 task succeeded" },
        { title: "Review & Fix", detail: "dev-review-fix child on the derived change set (diffCommand wins)" },
        { title: "Report", detail: "Deterministic outcome + per-child sections + prefixed warnings (in code)" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(dev_full_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

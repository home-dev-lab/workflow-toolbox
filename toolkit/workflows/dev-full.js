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
  function withPromptTags(rt, wrapperOpts) {
    let currentPhase;
    const agent = (prompt, opts) => {
      const fields = { label: opts?.label, phase: opts?.phase ?? currentPhase };
      const tag = buildPromptTag(fields);
      let tagged = tag !== null && !prompt.startsWith(tag) ? `${tag}

${prompt}` : prompt;
      if (tag !== null) {
        const section = wrapperOpts?.observedBrief?.(fields) ?? null;
        if (section !== null && !tagged.includes(section)) {
          tagged = `${tagged}

${section}`;
        }
      }
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

  // ../packages/runtime/src/observed-role-brief.ts
  var SALT_SUFFIX_RE = / #(\d+|[A-Za-z0-9_.-]{1,32})$/;
  var NUMERIC_SEGMENT_RE = /^\d+$/;
  function labelRole(label) {
    const stripped = label.replace(SALT_SUFFIX_RE, "");
    return stripped.split(":").filter((seg) => seg.length > 0 && !NUMERIC_SEGMENT_RE.test(seg));
  }
  function selectorRoles(selector) {
    return selector.roles ?? [];
  }
  function selectorPhases(selector) {
    return selector.phases ?? [];
  }
  function matchesSelector(tag, selector) {
    const roles = selectorRoles(selector);
    const phases = selectorPhases(selector);
    const roleMatch = roles.length === 0 || tag.label !== void 0 && roles.some((role) => labelRole(tag.label).includes(role));
    const phaseMatch = phases.length === 0 || tag.phase !== void 0 && phases.includes(tag.phase);
    return roleMatch && phaseMatch;
  }
  function matchedRoleId(tag, selector) {
    if (tag.label === void 0) return void 0;
    const candidates = labelRole(tag.label);
    if (candidates.length === 0) return void 0;
    const roles = selectorRoles(selector);
    if (roles.length > 0) {
      return roles.find((role) => candidates.includes(role));
    }
    const phases = selectorPhases(selector);
    return phases.length > 0 ? candidates[0] : void 0;
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function stringEntries(value) {
    if (!Array.isArray(value)) return void 0;
    return value.filter((item) => typeof item === "string");
  }
  function extractSelector(watch) {
    const selector = {};
    if (Object.hasOwn(watch, "roles")) {
      const roles = stringEntries(watch["roles"]);
      if (roles !== void 0) selector.roles = roles;
    }
    if (Object.hasOwn(watch, "phases")) {
      const phases = stringEntries(watch["phases"]);
      if (phases !== void 0) selector.phases = phases;
    }
    return selector;
  }
  function extractObservedSelectors(args) {
    if (!isRecord(args) || !Object.hasOwn(args, "observers") || !Array.isArray(args["observers"])) {
      return [];
    }
    const selectors = [];
    for (const entry of args["observers"]) {
      if (!isRecord(entry) || !Object.hasOwn(entry, "definition")) continue;
      const definition = entry["definition"];
      if (!isRecord(definition)) continue;
      if (!Object.hasOwn(definition, "actions") || !Array.isArray(definition["actions"]) || !definition["actions"].includes("wt-comm")) {
        continue;
      }
      if (!Object.hasOwn(definition, "emits") || !Array.isArray(definition["emits"]) || definition["emits"].length === 0) {
        continue;
      }
      if (!Object.hasOwn(definition, "watch") || !isRecord(definition["watch"])) {
        continue;
      }
      const selector = extractSelector(definition["watch"]);
      if ((selector.roles?.length ?? 0) === 0 && (selector.phases?.length ?? 0) === 0) continue;
      selectors.push(selector);
    }
    return selectors;
  }
  function buildObservedRoleSection(roleId) {
    return `---
OBSERVED ROLE BRIEF (auto-injected: an observer watches this run)
An attached observer may leave you typed \`observer.hint\` messages. Follow the
observed-role consumer brief of the wt-comm teaching pack: the file
\`teaching/wt-comm-observer-consumer.md\` inside the installed
\`@workflow-toolbox/comm\` package (read that file \u2014 it defines the conduct
rules, how to list unread hints, and the read-settlement marker; reference it,
never copy it). Your parameters:
- ROLE_ID: "${roleId}" (hints are addressed to this role name)
- WT_COMM_DIR and RUN_ID: read the JSON file named by the environment variable
  WT_COMM_PARAMS. One-liner:
  export WT_COMM_DIR=$(sed -n 's/.*"commDir" *: *"\\([^"]*\\)".*/\\1/p' "$WT_COMM_PARAMS") ROLE_ID="${roleId}"
  (the \`runId\` key in the same file is your RUN_ID.)
If WT_COMM_PARAMS is unset or the params file does not exist yet, the delivery
channel is inactive at this boundary: proceed unobserved and re-check at a
later natural boundary. Consult hints at NATURAL BOUNDARIES only; a missing or
unreadable channel never fails your task.`;
  }
  function observedBriefFor(selectors) {
    if (selectors.length === 0) return () => null;
    return (fields) => {
      for (const selector of selectors) {
        if (!matchesSelector(fields, selector)) continue;
        const roleId = matchedRoleId(fields, selector);
        if (roleId !== void 0) return buildObservedRoleSection(roleId);
      }
      return null;
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
        const selectors = extractObservedSelectors(normalized);
        const input = def.parseInput !== void 0 ? def.parseInput(normalized) : normalized;
        return def.run(
          withPromptTags(
            rt,
            selectors.length > 0 ? { observedBrief: observedBriefFor(selectors) } : void 0
          ),
          input
        );
      }
    };
  }
  var EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  var EFFORT_ROLE_VALUES = ["low", "medium", "high", "xhigh", "max", "auto"];
  var PER_AGENT_KEYS = ["model", "effort", "agentType", "isolation", "stallMs"];
  function isRecord2(v) {
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
    if (!isRecord2(raw)) throw new Error(`parseConfig: perAgent must be an object, got ${raw === null ? "null" : typeof raw}`);
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
    if (!isRecord2(raw)) throw new Error(`parseConfig: ${where} must be an object, got ${raw === null ? "null" : typeof raw}`);
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = asNonEmptyString(v, `${where}.${k}`);
    return out;
  }
  function parseEffortMap(raw) {
    if (!isRecord2(raw)) throw new Error(`parseConfig: effort must be an object, got ${raw === null ? "null" : typeof raw}`);
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
    if (!isRecord2(raw)) throw new Error(`parseConfig: ${where} must be an object, got ${raw === null ? "null" : typeof raw}`);
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
    if (!isRecord2(raw)) {
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
  function warn(rt, warnings, message) {
    warnings.push(message);
    rt.log(message);
  }
  function emitDigest(rt, d) {
    rt.log(formatDigest(d));
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

  // ../packages/patterns/src/provenance-gate.ts
  var SCANNER_RECENCY_MS = 30 * 60 * 1e3;

  // dev-full.workflow.ts
  function isRecord3(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function isStringArray(v) {
    return Array.isArray(v) && v.every((x) => typeof x === "string");
  }
  function stringsOrEmpty(v) {
    return isStringArray(v) ? v : [];
  }
  function narrowPlanResult(value) {
    if (!isRecord3(value)) {
      return { ok: false, reason: 'plan child returned an unexpected shape (not an object) \u2014 cannot read "artifact"' };
    }
    const artifact = value["artifact"];
    if (!isRecord3(artifact)) {
      return { ok: false, reason: 'plan child returned no "artifact" object \u2014 cannot hand off to dev-implement' };
    }
    if (typeof artifact["goal"] !== "string") {
      return { ok: false, reason: 'plan child artifact has no string "goal"' };
    }
    const context = artifact["context"];
    if (!isRecord3(context)) {
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
      if (!isRecord3(task) || typeof task["id"] !== "string" || typeof task["title"] !== "string") {
        return { ok: false, reason: 'plan child artifact has a task without string "id"/"title"' };
      }
      const files = task["files"];
      if (!Array.isArray(files) || files.some((f) => !isRecord3(f) || typeof f["path"] !== "string")) {
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
    if (!isRecord3(value)) {
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
      if (!isRecord3(task) || typeof task["id"] !== "string" || typeof task["title"] !== "string" || typeof task["status"] !== "string") {
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
    if (!isRecord3(value)) {
      return { ok: false, reason: "review child returned an unexpected shape (not an object)" };
    }
    return {
      ok: true,
      value: { value, stats: value["stats"] ?? null, warnings: stringsOrEmpty(value["warnings"]) }
    };
  }
  function parseInput(raw) {
    if (!isRecord3(raw)) {
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
    if (!isRecord3(sp)) {
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
    let implementerModel = null;
    if (raw["implementerModel"] !== void 0 && raw["implementerModel"] !== null) {
      if (typeof raw["implementerModel"] !== "string" || raw["implementerModel"].trim().length === 0) {
        throw new Error(
          'dev-full: "implementerModel" must be a non-empty model alias (e.g. "sonnet", "opus", "haiku", "inherit") \u2014 omit to use the dev-implement default ("sonnet")'
        );
      }
      implementerModel = raw["implementerModel"];
    }
    let implementerType = null;
    if (raw["implementerType"] !== void 0 && raw["implementerType"] !== null) {
      if (typeof raw["implementerType"] !== "string" || raw["implementerType"].trim().length === 0) {
        throw new Error(
          'dev-full: "implementerType" must be a non-empty subagent-type string (e.g. "magic-claude:ts-tdd-guide") \u2014 omit to use the dev-implement default (standard subagent)'
        );
      }
      implementerType = raw["implementerType"];
    }
    let fixerModel = null;
    if (raw["fixerModel"] !== void 0 && raw["fixerModel"] !== null) {
      if (typeof raw["fixerModel"] !== "string" || raw["fixerModel"].trim().length === 0) {
        throw new Error(
          'dev-full: "fixerModel" must be a non-empty model alias (e.g. "sonnet", "opus", "haiku", "inherit") \u2014 omit to use the dev-review-fix default ("sonnet")'
        );
      }
      fixerModel = raw["fixerModel"];
    }
    let fixerType = null;
    if (raw["fixerType"] !== void 0 && raw["fixerType"] !== null) {
      if (typeof raw["fixerType"] !== "string" || raw["fixerType"].trim().length === 0) {
        throw new Error(
          'dev-full: "fixerType" must be a non-empty subagent-type string (e.g. "magic-claude:ts-build-resolver") \u2014 omit to use the dev-review-fix default (standard subagent)'
        );
      }
      fixerType = raw["fixerType"];
    }
    let reviewerType = null;
    if (raw["reviewerType"] !== void 0 && raw["reviewerType"] !== null) {
      if (typeof raw["reviewerType"] !== "string" || raw["reviewerType"].trim().length === 0) {
        throw new Error(
          'dev-full: "reviewerType" must be a non-empty subagent-type string (e.g. "magic-claude:ts-reviewer") \u2014 omit to use the dev-review-fix default (standard subagent)'
        );
      }
      reviewerType = raw["reviewerType"];
    }
    let verifierType = null;
    if (raw["verifierType"] !== void 0 && raw["verifierType"] !== null) {
      if (typeof raw["verifierType"] !== "string" || raw["verifierType"].trim().length === 0) {
        throw new Error(
          'dev-full: "verifierType" must be a non-empty subagent-type string (e.g. "codex:codex-rescue") \u2014 omit to use the dev-plan default (standard same-model Critique verifier)'
        );
      }
      verifierType = raw["verifierType"];
    }
    const effort = parseConfig(raw).effort ?? null;
    return {
      goal,
      areas,
      projectDir,
      scriptPaths,
      maxRefutedRatio,
      maxIterationsPerTask,
      maxFixIterations,
      dimensions,
      diffCommand,
      implementerModel,
      implementerType,
      fixerModel,
      fixerType,
      reviewerType,
      verifierType,
      effort
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
      projectDir: input.projectDir,
      ...input.verifierType !== null ? { verifierType: input.verifierType } : {},
      ...input.effort !== null ? { effort: input.effort } : {}
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
    if (input.implementerModel !== null) implementArgs["implementerModel"] = input.implementerModel;
    if (input.implementerType !== null) implementArgs["implementerType"] = input.implementerType;
    if (input.effort !== null) implementArgs["effort"] = input.effort;
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
    const relativize = (p) => relativizeUnder(input.projectDir, p) ?? p;
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
    if (input.fixerModel !== null) reviewArgs["fixerModel"] = input.fixerModel;
    if (input.fixerType !== null) reviewArgs["fixerType"] = input.fixerType;
    if (input.reviewerType !== null) reviewArgs["reviewerType"] = input.reviewerType;
    if (input.verifierType !== null) reviewArgs["verifierType"] = input.verifierType;
    if (input.effort !== null) reviewArgs["effort"] = input.effort;
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
    const reportSummary = `dev-full: completed \u2014 plan ${plan.artifact.tasks.length} tasks, implement ${implement.succeeded}/${implement.tasks.length} succeeded, review suiteGreen=${String(review.value["suiteGreen"] ?? "unknown")}`;
    rt.log(reportSummary);
    emitDigest(rt, {
      stage: "dev-full:report",
      phase: "Report",
      output: reportSummary,
      counts: { planTasks: plan.artifact.tasks.length, implementSucceeded: implement.succeeded, implementTotal: implement.tasks.length }
    });
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

export const meta = {
  "name": "all-patterns-workflow",
  "description": "All nine patterns in one run: three levels of in-run nesting (root → nested → deep), each level exercising different patterns, with loopUntilDone drawn both inner and outer, an auto-approvable in-code gate, and every agent honoring args.perAgent.model (defaults to haiku). The single-artifact sibling of the demo-showcase-v2 orchestrator pipeline. A render/cost fixture, not a real workflow.",
  "whenToUse": "Launch to render every pattern shape across three nesting levels in ONE workflow run (a rendering/single-view fixture) — never for real work; the result is meaningless by design. For the real gated, nested pipeline-of-pipelines showcase use demo-showcase-v2.pipeline instead. Pin args.perAgent={model:\"haiku\"} for a trivially cheap capture run.",
  "phases": [
    {
      "title": "Route",
      "detail": "L1 root — classifyAndAct: one router then one handler"
    },
    {
      "title": "Gate",
      "detail": "L1 root — auto-approvable human gate at the phase boundary"
    },
    {
      "title": "Fan",
      "detail": "L2 nested — fanOutAndSynthesize (scatter-gather) of angle workers"
    },
    {
      "title": "Compete",
      "detail": "L2 nested — tournament: attempts, judges, synthesis funnel"
    },
    {
      "title": "Generate",
      "detail": "L3 deep — generateAndFilter: candidate taglines, filtered"
    },
    {
      "title": "Chunk",
      "detail": "L3 deep — chunkedAnalysis: map-reduce a feedback log into clusters"
    },
    {
      "title": "Verify",
      "detail": "L3 deep — adversarialVerification: refute-first verifier fan"
    },
    {
      "title": "Refine-Inner",
      "detail": "L3 deep — loopUntilDone INNER: intra-phase polish loop"
    },
    {
      "title": "Plan",
      "detail": "L2 nested — planAndExecute: planner then dynamic workers"
    },
    {
      "title": "Refine-Outer",
      "detail": "L1 root — loopUntilDone OUTER: root-level polish loop"
    },
    {
      "title": "Triage",
      "detail": "L1 root — scoreAndRank: cheap per-dimension scoring + cutoff"
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

  // all-patterns-workflow.workflow.ts
  var all_patterns_workflow_workflow_exports = {};
  __export(all_patterns_workflow_workflow_exports, {
    default: () => all_patterns_workflow_workflow_default
  });

  // ../packages/runtime/src/constants.ts
  var BEST_MODEL = "opus";

  // ../packages/runtime/src/digest.ts
  var DIGEST_PREFIX = "[wt:digest]";
  var LOOP_STAGE = "loopUntilDone";
  var LOOP_ITER_MARKER = " \u27F2";
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

  // ../packages/patterns/src/structured-salvage.ts
  function describeNode(node) {
    const parts = [];
    if (node.enum !== void 0) {
      parts.push(`one of: ${node.enum.map((v) => JSON.stringify(v)).join(" | ")}`);
    } else if (node.type === "object" && node.properties !== void 0) {
      const req = new Set(node.required ?? []);
      const inner = Object.entries(node.properties).map(([name, child]) => {
        const desc = describeNode(child);
        return `"${name}" (${req.has(name) ? "REQUIRED" : "optional"})${desc === "" ? "" : `: ${desc}`}`;
      }).join("; ");
      parts.push(`object with properties: ${inner}`);
    } else if (node.type !== void 0) {
      parts.push(node.type);
    }
    if (node.minLength !== void 0 && node.maxLength !== void 0) {
      parts.push(`${node.minLength}-${node.maxLength} chars`);
    } else if (node.maxLength !== void 0) {
      parts.push(`at most ${node.maxLength} chars`);
    } else if (node.minLength !== void 0) {
      parts.push(`at least ${node.minLength} chars`);
    }
    if (node.maxItems !== void 0) parts.push(`at most ${node.maxItems} items`);
    if (node.minItems !== void 0) parts.push(`at least ${node.minItems} items`);
    if (node.type === "array" && node.items !== void 0) {
      parts.push(`each item: ${describeNode(node.items)}`);
    }
    return parts.join(", ");
  }
  function describeSchemaConstraints(schema) {
    const root = schema;
    if (root.type !== "object" || root.properties === void 0) {
      const line = describeNode(root);
      return line === "" ? "" : `The answer must be: ${line}.`;
    }
    const required = new Set(root.required ?? []);
    const lines = Object.entries(root.properties).map(([name, node]) => {
      const desc = describeNode(node);
      return `- "${name}" (${required.has(name) ? "REQUIRED" : "optional"})${desc === "" ? "" : `: ${desc}`}`;
    });
    const extras = root.additionalProperties === false ? "\nNo other properties are allowed." : "";
    return `The JSON object must have exactly these properties:
${lines.join("\n")}${extras}`;
  }
  function tryParseObject(text) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
    }
    return void 0;
  }
  function extractJsonObject(text) {
    const trimmed = text.trim();
    const direct = tryParseObject(trimmed);
    if (direct !== void 0) return direct;
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fence?.[1] !== void 0) {
      const fenced = tryParseObject(fence[1].trim());
      if (fenced !== void 0) return fenced;
    }
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) {
      return tryParseObject(trimmed.slice(first, last + 1));
    }
    return void 0;
  }
  function typeOf(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }
  function validateNode(value, node, path, out) {
    if (node.enum !== void 0) {
      if (!node.enum.some((v) => v === value)) {
        out.push({
          path,
          message: `${JSON.stringify(value)} is not one of ${node.enum.map((v) => JSON.stringify(v)).join(" | ")}`
        });
      }
      return;
    }
    const t = node.type;
    if (t === void 0) return;
    const actual = typeOf(value);
    if (t === "integer" ? !(actual === "number" && Number.isInteger(value)) : actual !== t) {
      out.push({ path, message: `expected ${t}, got ${actual}` });
      return;
    }
    if (t === "string") {
      const s = value;
      if (node.maxLength !== void 0 && s.length > node.maxLength) {
        out.push({ path, message: `${s.length} chars exceeds maxLength ${node.maxLength}` });
      }
      if (node.minLength !== void 0 && s.length < node.minLength) {
        out.push({ path, message: `${s.length} chars under minLength ${node.minLength}` });
      }
      return;
    }
    if (t === "array") {
      const arr = value;
      if (node.maxItems !== void 0 && arr.length > node.maxItems) {
        out.push({ path, message: `${arr.length} items exceeds maxItems ${node.maxItems}` });
      }
      if (node.minItems !== void 0 && arr.length < node.minItems) {
        out.push({ path, message: `${arr.length} items under minItems ${node.minItems}` });
      }
      if (node.items !== void 0) {
        arr.forEach((item, i) => validateNode(item, node.items, `${path}[${i}]`, out));
      }
      return;
    }
    if (t === "object") {
      const obj = value;
      for (const req of node.required ?? []) {
        if (!(req in obj)) out.push({ path: `${path}.${req}`, message: "required property missing" });
      }
      const props = node.properties ?? {};
      for (const [key, child] of Object.entries(props)) {
        if (key in obj) validateNode(obj[key], child, `${path}.${key}`, out);
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) {
            out.push({ path: `${path}.${key}`, message: "unexpected property (additionalProperties: false)" });
          }
        }
      }
    }
  }
  function validateAgainstSchema(value, schema) {
    const out = [];
    validateNode(value, schema, "$", out);
    return out;
  }
  function repairNode(value, node, path, repairs) {
    if (node.type === "string" && typeof value === "string") {
      if (node.maxLength !== void 0 && value.length > node.maxLength) {
        repairs.push(`${path}: truncated from ${value.length} to maxLength ${node.maxLength} chars`);
        return value.slice(0, node.maxLength);
      }
      return value;
    }
    if (node.type === "array" && Array.isArray(value)) {
      let arr = value;
      if (node.maxItems !== void 0 && arr.length > node.maxItems) {
        repairs.push(`${path}: sliced from ${arr.length} to maxItems ${node.maxItems} items`);
        arr = arr.slice(0, node.maxItems);
      }
      return node.items !== void 0 ? arr.map((item, i) => repairNode(item, node.items, `${path}[${i}]`, repairs)) : arr;
    }
    if (node.type === "object" && typeOf(value) === "object") {
      const obj = value;
      const props = node.properties ?? {};
      const result = {};
      for (const [key, v] of Object.entries(obj)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          repairs.push(`${path}.${key}: dropped prototype-polluting key`);
          continue;
        }
        if (key in props) {
          result[key] = repairNode(v, props[key], `${path}.${key}`, repairs);
        } else if (node.additionalProperties === false) {
          repairs.push(`${path}.${key}: dropped unexpected property`);
        } else {
          result[key] = v;
        }
      }
      return result;
    }
    return value;
  }
  function repairToSchema(value, schema) {
    const repairs = [];
    const repaired = repairNode(value, schema, "$", repairs);
    return { value: repaired, repairs };
  }
  function salvagePrompt(prompt, schema) {
    const constraints = describeSchemaConstraints(schema);
    return `${prompt}

STRUCTURED-OUTPUT SALVAGE: a previous schema-enforced attempt at this exact task failed validation repeatedly. Answer with ONLY one JSON object \u2014 no prose, no code fences, no explanation before or after.` + (constraints === "" ? "" : `
${constraints}`) + `
Never satisfy a constraint with placeholder values ("test", "a"); shorten real content instead of faking it.`;
  }
  function isNoStructuredOutputError(err) {
    return err instanceof Error && err.message.includes("without calling StructuredOutput");
  }
  async function agentWithSchemaSalvage(rt, prompt, opts) {
    const schema = opts.schema;
    if (schema === void 0) {
      const plain = await rt.agent(prompt, opts);
      return { value: plain, warnings: [], spawns: 1, salvageAttempted: false, salvaged: false };
    }
    let native;
    try {
      native = await rt.agent(prompt, opts);
    } catch (err) {
      if (isNoStructuredOutputError(err)) {
        native = null;
      } else {
        throw err;
      }
    }
    if (native !== null) return { value: native, warnings: [], spawns: 1, salvageAttempted: false, salvaged: false };
    const where = opts.label ?? "agent";
    const salvageOpts = {
      ...opts,
      ...opts.label !== void 0 ? { label: `${opts.label}:salvage` } : {}
    };
    delete salvageOpts.schema;
    const raw = await rt.agent(salvagePrompt(prompt, schema), salvageOpts);
    if (raw === null) {
      return {
        value: null,
        warnings: [`${where}: structured-output salvage respawn also returned null`],
        spawns: 2,
        salvageAttempted: true,
        salvaged: false
      };
    }
    const candidate = typeof raw === "string" ? extractJsonObject(raw) : raw;
    if (candidate === void 0) {
      const head = typeof raw === "string" ? raw.trim().slice(0, 120) : String(raw);
      return {
        value: null,
        warnings: [`${where}: salvage output is not a JSON object (starts: ${JSON.stringify(head)})`],
        spawns: 2,
        salvageAttempted: true,
        salvaged: false
      };
    }
    const preViolations = validateAgainstSchema(candidate, schema);
    if (preViolations.length === 0) {
      return {
        value: candidate,
        warnings: [`${where}: value salvaged after structured-output exhaustion (schema-less respawn)`],
        spawns: 2,
        salvageAttempted: true,
        salvaged: true
      };
    }
    const { value: repaired, repairs } = repairToSchema(candidate, schema);
    const postViolations = validateAgainstSchema(repaired, schema);
    if (postViolations.length === 0) {
      return {
        value: repaired,
        warnings: [
          `${where}: value salvaged after structured-output exhaustion, with deterministic repairs \u2014 ${repairs.join("; ")}`
        ],
        spawns: 2,
        salvageAttempted: true,
        salvaged: true
      };
    }
    return {
      value: null,
      warnings: [
        `${where}: salvage failed schema validation \u2014 ` + postViolations.map((v) => `${v.path}: ${v.message}`).join("; ") + (repairs.length > 0 ? ` (repairs attempted: ${repairs.join("; ")})` : "")
      ],
      spawns: 2,
      salvageAttempted: true,
      salvaged: false
    };
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

  // ../packages/patterns/src/stage-instance.ts
  var registry = /* @__PURE__ */ new WeakMap();
  var STAGE_KEY_PATTERN = /^(?!\d+$)[A-Za-z0-9_.-]{1,32}$/;
  function claimStageInstance(rt, pattern, stageKey) {
    if (stageKey !== void 0) {
      if (STAGE_KEY_PATTERN.test(stageKey)) {
        return { salt: ` #${stageKey}` };
      }
      const fallback = claimAuto(rt, pattern);
      const reason = /^\d+$/.test(stageKey) ? "purely-numeric keys are reserved for the auto instance counter's own ' #<n>' format (a numeric stageKey would be indistinguishable from an auto-salted invocation)" : `must match ${STAGE_KEY_PATTERN.source}`;
      return {
        salt: fallback.salt,
        warning: `${pattern}: stageKey ${JSON.stringify(stageKey)} is invalid (${reason}) \u2014 falling back to the auto instance counter`
      };
    }
    return claimAuto(rt, pattern);
  }
  function claimAuto(rt, pattern) {
    let byPattern = registry.get(rt);
    if (byPattern === void 0) {
      byPattern = /* @__PURE__ */ new Map();
      registry.set(rt, byPattern);
    }
    const n = (byPattern.get(pattern) ?? 0) + 1;
    byPattern.set(pattern, n);
    return { salt: n === 1 ? "" : ` #${n}` };
  }
  function stageBuilder(stage, salt) {
    return (suffix) => suffix !== void 0 ? `${stage}:${suffix}${salt}` : `${stage}${salt}`;
  }

  // ../packages/patterns/src/classify-and-act.ts
  var STAGE = "classifyAndAct";
  async function classifyAndAct(rt, options) {
    const { items, categories, classifyPrompt, actions, classifyModel, classifyEffort, classifyType, phase, maxItems, stageKey, cacheWarm } = options;
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
    const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE, stageKey);
    if (stageKeyWarning !== void 0) warn(rt, warnings, stageKeyWarning);
    const stg = stageBuilder(STAGE, salt);
    const pendingWarnings = [];
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
      const stage = stg(`classify:${index}`);
      const classifyOpts = {
        schema: controlSchema,
        label: stage,
        ...phase !== void 0 ? { phase } : {},
        ...classifyModel !== void 0 ? { model: classifyModel } : {},
        ...classifyEffort !== void 0 ? { effort: classifyEffort } : {},
        ...classifyType !== void 0 ? { agentType: classifyType } : {}
      };
      const classifyOut = await agentWithSchemaSalvage(rt, classifyPrompt(item), classifyOpts);
      agentsSpawned += classifyOut.spawns;
      for (const message of classifyOut.warnings) pendingWarnings.push({ itemIndex: index, stageOrder: 0, message });
      if (classifyOut.salvageAttempted) {
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0.5,
          record: makeRecord(`${stage}:salvage`, classifyOut.salvaged, {
            ...classifyModel !== void 0 ? { model: classifyModel } : {},
            ...classifyEffort !== void 0 ? { effort: classifyEffort } : {}
          })
        });
      }
      const classified = classifyOut.value;
      if (classified === null) {
        classifyFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0,
          record: makeRecord(stage, false, {
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
          record: makeRecord(stage, false, {
            ...classifyModel !== void 0 ? { model: classifyModel } : {},
            ...classifyEffort !== void 0 ? { effort: classifyEffort } : {}
          })
        });
        throw new Error(`classify returned unknown category "${classified.category}"`);
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(stage, true, {
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
      const stage = stg(`act:${category}:${index}`);
      const actOpts = {
        label: stage,
        ...phase !== void 0 ? { phase } : {},
        ...spec.schema !== void 0 ? { schema: spec.schema } : {},
        ...spec.model !== void 0 ? { model: spec.model } : {},
        ...spec.effort !== void 0 ? { effort: spec.effort } : {},
        ...spec.agentType !== void 0 ? { agentType: spec.agentType } : {}
      };
      const actOut = await agentWithSchemaSalvage(rt, spec.prompt(item), actOpts);
      agentsSpawned += actOut.spawns;
      for (const message of actOut.warnings) pendingWarnings.push({ itemIndex: index, stageOrder: 1, message });
      if (actOut.salvageAttempted) {
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 1.5,
          record: makeRecord(`${stage}:salvage`, actOut.salvaged, {
            ...spec.model !== void 0 ? { model: spec.model } : {},
            ...spec.effort !== void 0 ? { effort: spec.effort } : {}
          })
        });
      }
      const result = actOut.value;
      if (result === null) {
        actionFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 1,
          record: makeRecord(stage, false, {
            ...spec.model !== void 0 ? { model: spec.model } : {},
            ...spec.effort !== void 0 ? { effort: spec.effort } : {}
          })
        });
        throw new Error("act returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(stage, true, {
          ...spec.model !== void 0 ? { model: spec.model } : {},
          ...spec.effort !== void 0 ? { effort: spec.effort } : {}
        })
      });
      return { item, category, result };
    };
    const rawResults = await pipelineWithCacheWarm(
      rt,
      kept,
      [classifyStage, actStage],
      cacheWarm ?? true
    );
    const value = rawResults.filter(
      (r) => r !== null
    );
    pendingWarnings.sort(
      (a, b) => a.itemIndex !== b.itemIndex ? a.itemIndex - b.itemIndex : a.stageOrder - b.stageOrder
    );
    for (const entry of pendingWarnings) warn(rt, warnings, `${STAGE}: ${entry.message}`);
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
      ...phase !== void 0 ? { phase } : {},
      taken: allCategories.filter((c) => chosen.has(c)),
      notTaken: allCategories.filter((c) => !chosen.has(c)),
      counts: { in: items.length, out: value.length }
    });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/generate-and-filter.ts
  var STAGE2 = "generateAndFilter";
  var REJECTED = /* @__PURE__ */ Symbol("generate-and-filter:REJECTED");
  async function generateAndFilter(rt, options) {
    const { count, generatePrompt, generateSchema, generateModel, generateEffort, generateType, filterPrompt, filterModel, filterEffort, filterType, phase, stageKey, cacheWarm } = options;
    if (count < 1) {
      throw new Error(
        `generateAndFilter: count must be >= 1, got ${count} \u2014 set count to a positive integer`
      );
    }
    assertAgentTypeOption(STAGE2, "generateType", generateType);
    assertAgentTypeOption(STAGE2, "filterType", filterType);
    let agentsSpawned = 0;
    let generateFailures = 0;
    let filterFailures = 0;
    const warnings = [];
    const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE2, stageKey);
    if (stageKeyWarning !== void 0) warn(rt, warnings, stageKeyWarning);
    const stg = stageBuilder(STAGE2, salt);
    const pendingTrail = [];
    const pendingWarnings = [];
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
      const stage = stg(`generate:${index}`);
      const genOpts = {
        label: stage,
        ...phase !== void 0 ? { phase } : {},
        ...generateSchema !== void 0 ? { schema: generateSchema } : {},
        ...generateModel !== void 0 ? { model: generateModel } : {},
        ...generateEffort !== void 0 ? { effort: generateEffort } : {},
        ...generateType !== void 0 ? { agentType: generateType } : {}
      };
      const genOut = await agentWithSchemaSalvage(rt, generatePrompt(index), genOpts);
      agentsSpawned += genOut.spawns;
      for (const message of genOut.warnings) pendingWarnings.push({ itemIndex: index, stageOrder: 0, message });
      if (genOut.salvageAttempted) {
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0.5,
          record: makeRecord(`${stage}:salvage`, genOut.salvaged, {
            ...generateModel !== void 0 ? { model: generateModel } : {},
            ...generateEffort !== void 0 ? { effort: generateEffort } : {}
          })
        });
      }
      const candidate = genOut.value;
      if (candidate === null) {
        generateFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0,
          record: makeRecord(stage, false, {
            ...generateModel !== void 0 ? { model: generateModel } : {},
            ...generateEffort !== void 0 ? { effort: generateEffort } : {}
          })
        });
        throw new Error("generate returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(stage, true, {
          ...generateModel !== void 0 ? { model: generateModel } : {},
          ...generateEffort !== void 0 ? { effort: generateEffort } : {}
        })
      });
      return candidate;
    };
    const filterStage = async (prev, _originalItem, index) => {
      const candidate = prev;
      const stage = stg(`filter:${index}`);
      const filterOpts = {
        schema: filterSchema,
        label: stage,
        ...phase !== void 0 ? { phase } : {},
        ...filterModel !== void 0 ? { model: filterModel } : {},
        ...filterEffort !== void 0 ? { effort: filterEffort } : {},
        ...filterType !== void 0 ? { agentType: filterType } : {}
      };
      const filterOut = await agentWithSchemaSalvage(
        rt,
        filterPrompt(candidate),
        filterOpts
      );
      agentsSpawned += filterOut.spawns;
      for (const message of filterOut.warnings) pendingWarnings.push({ itemIndex: index, stageOrder: 1, message });
      if (filterOut.salvageAttempted) {
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 1.5,
          record: makeRecord(`${stage}:salvage`, filterOut.salvaged, {
            ...filterModel !== void 0 ? { model: filterModel } : {},
            ...filterEffort !== void 0 ? { effort: filterEffort } : {}
          })
        });
      }
      const verdict = filterOut.value;
      if (verdict === null) {
        filterFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 1,
          record: makeRecord(stage, false, {
            ...filterModel !== void 0 ? { model: filterModel } : {},
            ...filterEffort !== void 0 ? { effort: filterEffort } : {}
          })
        });
        throw new Error("filter returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(stage, true, {
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
    pendingWarnings.sort(
      (a, b) => a.itemIndex !== b.itemIndex ? a.itemIndex - b.itemIndex : a.stageOrder - b.stageOrder
    );
    for (const entry of pendingWarnings) warn(rt, warnings, `${STAGE2}: ${entry.message}`);
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
      stage: STAGE2,
      ...phase !== void 0 ? { phase } : {},
      counts: {
        requested: count,
        kept: value.length,
        rejected: Math.max(0, rejected),
        failed: generateFailures + filterFailures
      }
    });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/fan-out-and-synthesize.ts
  var STAGE3 = "fanOutAndSynthesize";
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
      stageKey,
      cacheWarm
    } = options;
    if (tasks.length === 0) {
      throw new Error(
        "fanOutAndSynthesize: tasks must not be empty \u2014 nothing to fan out"
      );
    }
    assertAgentTypeOption(STAGE3, "taskType", taskType);
    assertAgentTypeOption(STAGE3, "synthesisType", synthesisType);
    const { kept, truncated } = applyCap(tasks, maxItems);
    let agentsSpawned = 0;
    const warnings = [];
    const trail = [];
    const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE3, stageKey);
    if (stageKeyWarning !== void 0) warn(rt, warnings, stageKeyWarning);
    const stg = stageBuilder(STAGE3, salt);
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `fanOutAndSynthesize: ${truncated} of ${tasks.length} tasks truncated by maxItems=${maxItems ?? "?"}`
      );
    }
    const keptArray = kept;
    const taskStages = keptArray.map((_, i) => stg(`task:${i}`));
    const taskThunks = keptArray.map((task, i) => async () => {
      const taskOpts = {
        label: taskStages[i],
        ...phase !== void 0 ? { phase } : {},
        ...taskSchema !== void 0 ? { schema: taskSchema } : {},
        ...taskModel !== void 0 ? { model: taskModel } : {},
        ...taskEffort !== void 0 ? { effort: taskEffort } : {},
        ...taskType !== void 0 ? { agentType: taskType } : {}
      };
      return agentWithSchemaSalvage(rt, taskPrompt(task, i), taskOpts);
    });
    const taskResults = await parallelWithCacheWarm(rt, taskThunks, cacheWarm ?? true);
    const parts = [];
    let dropped = 0;
    for (let i = 0; i < taskResults.length; i++) {
      const out = taskResults[i];
      const r = out?.value ?? null;
      const taskStage = taskStages[i];
      agentsSpawned += out?.spawns ?? 1;
      trail.push(makeRecord(taskStage, r !== null, {
        ...taskModel !== void 0 ? { model: taskModel } : {},
        ...taskEffort !== void 0 ? { effort: taskEffort } : {}
      }));
      if (out !== null && out.salvageAttempted) {
        trail.push(makeRecord(`${taskStage}:salvage`, out.salvaged, {
          ...taskModel !== void 0 ? { model: taskModel } : {},
          ...taskEffort !== void 0 ? { effort: taskEffort } : {}
        }));
      }
      for (const message of out?.warnings ?? []) warn(rt, warnings, `${STAGE3}: ${message}`);
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
      const synthesizeStage = stg("synthesize");
      const synthOpts = {
        label: synthesizeStage,
        ...phase !== void 0 ? { phase } : {},
        ...synthesisSchema !== void 0 ? { schema: synthesisSchema } : {},
        ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
        ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {},
        ...synthesisType !== void 0 ? { agentType: synthesisType } : {}
      };
      const synthOut = await agentWithSchemaSalvage(rt, synthesisPrompt(parts), synthOpts);
      agentsSpawned += synthOut.spawns;
      const synthesis = synthOut.value;
      trail.push(makeRecord(synthesizeStage, synthesis !== null, {
        ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
        ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {}
      }));
      if (synthOut.salvageAttempted) {
        trail.push(makeRecord(`${synthesizeStage}:salvage`, synthOut.salvaged, {
          ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
          ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {}
        }));
      }
      for (const message of synthOut.warnings) warn(rt, warnings, `${STAGE3}: ${message}`);
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
      stage: STAGE3,
      ...phase !== void 0 ? { phase } : {},
      output: value === null ? "synthesis: none" : `synthesis from ${parts.length}/${tasks.length} tasks`,
      counts: { tasks: tasks.length, completed: parts.length }
    });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/provenance-gate.ts
  var EXTERNAL_CLI_SIGNATURES = [
    {
      id: "opencode",
      typeRe: /opencode/i,
      commandRe: /(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?opencode(?:\.exe|\.cmd)?\s+run\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?opencode(?:\.exe|\.cmd)?["']\s+run\b|[A-Za-z_]*BIN=[^\n]*opencode[\s\S]*?"?\$\{?[A-Za-z_]*BIN\}?"?\s+run\b/im
    },
    {
      id: "codex",
      typeRe: /codex/i,
      commandRe: /codex-companion\.mjs["']?\s+task\b|(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?codex(?:\.exe)?\s+exec\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?codex(?:\.exe)?["']\s+exec\b/im
    }
  ];
  var PROVENANCE_CHECK_SUFFIX = "provenance-check";
  var SCANNER_COMMAND_SCAN_MAX = 2e4;
  var SCANNER_RECENCY_MS = 30 * 60 * 1e3;
  function deriveProvenanceNonce(labels, claimSeed = "") {
    let h = 2166136261;
    const seed = `${labels.join(" ")}${claimSeed}`;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `wtprov-${(h >>> 0).toString(16).padStart(8, "0")}`;
  }
  function externalGateExpectation(verifierType) {
    if (verifierType === void 0) return null;
    for (const sig of EXTERNAL_CLI_SIGNATURES) if (sig.typeRe.test(verifierType)) return sig;
    return null;
  }
  function buildProvenanceScannerSource(expectation, nonce, labels) {
    const reSource = JSON.stringify(expectation.commandRe.source);
    const reFlags = JSON.stringify(expectation.commandRe.flags);
    const nonceLit = JSON.stringify(nonce);
    const labelsLit = JSON.stringify(labels);
    return [
      `'use strict';`,
      `const fs=require('fs'),path=require('path'),os=require('os');`,
      `const NONCE=${nonceLit},LABELS=${labelsLit};`,
      `const RE=new RegExp(${reSource},${reFlags});`,
      `const SCAN_MAX=${SCANNER_COMMAND_SCAN_MAX},RECENCY=${SCANNER_RECENCY_MS},now=Date.now();`,
      // Candidate config roots: the running session's CLAUDE_CONFIG_DIR plus the standard pair.
      `const roots=[process.env.CLAUDE_CONFIG_DIR,path.join(os.homedir(),'.claude'),path.join(os.homedir(),'.claude-work')].filter(Boolean);`,
      `function ls(d){try{return fs.readdirSync(d)}catch(e){return[]}}`,
      // Enumerate recent agent-*.jsonl under */projects/*/*/subagents/workflows/*/.
      `function transcripts(){const out=[];for(const r of roots){const pj=path.join(r,'projects');for(const slug of ls(pj)){const sd=path.join(pj,slug);for(const sess of ls(sd)){const wf=path.join(sd,sess,'subagents','workflows');for(const run of ls(wf)){const rd=path.join(wf,run);for(const f of ls(rd)){if(f.indexOf('agent-')!==0||!f.endsWith('.jsonl'))continue;const fp=path.join(rd,f);let st;try{st=fs.statSync(fp)}catch(e){continue}if(now-st.mtimeMs>RECENCY)continue;out.push(fp)}}}}}return out}`,
      `function read(fp){try{return fs.readFileSync(fp,'utf8')}catch(e){return''}}`,
      // Anchor: run dir = dirname of the NEWEST transcript containing NONCE. Newest favors THIS
      // run's live checker over any stale prior run that shared the (deterministic) nonce.
      `const cands=transcripts();let runDir=null,best=-1;for(const fp of cands){if(read(fp).indexOf(NONCE)===-1)continue;let st;try{st=fs.statSync(fp)}catch(e){continue}if(st.mtimeMs>best){best=st.mtimeMs;runDir=path.dirname(fp)}}`,
      `if(runDir===null){process.stdout.write(JSON.stringify({anchored:false,results:[]}));return}`,
      // wt-meta label marker as it appears escaped inside the jsonl: label=\"<label>\".
      `function labelMarker(l){return 'label=\\\\"'+l+'\\\\"'}`,
      // Count real external-CLI invocations in one transcript's Bash tool_use commands.
      `function cliCalls(text){let n=0;for(const raw of text.split('\\n')){const t=raw.trim();if(!t)continue;let o;try{o=JSON.parse(t)}catch(e){continue}const m=o&&o.message;if(!m||typeof m!=='object')continue;const c=m.content;if(!Array.isArray(c))continue;for(const b of c){if(!b||b.type!=='tool_use'||b.name!=='Bash')continue;const cmd=b.input&&b.input.command;if(typeof cmd!=='string')continue;const scan=cmd.length>SCAN_MAX?cmd.slice(0,SCAN_MAX):cmd;if(RE.test(scan))n++}}return n}`,
      `const files=ls(runDir).filter(f=>f.indexOf('agent-')===0&&f.endsWith('.jsonl')).map(f=>path.join(runDir,f));`,
      `const cache=new Map();function txt(fp){if(!cache.has(fp))cache.set(fp,read(fp));return cache.get(fp)}`,
      `const results=LABELS.map(function(label){const marker=labelMarker(label);let seen=false,found=false;for(const fp of files){const tx=txt(fp);if(tx.indexOf(marker)===-1)continue;found=true;if(cliCalls(tx)>0){seen=true}break}return{label:label,cliSeen:found?seen:null}});`,
      `process.stdout.write(JSON.stringify({anchored:true,results:results}));`
    ].join("\n");
  }
  function buildProvenanceCheckerPrompt(expectation, nonce, labels) {
    const scanner = buildProvenanceScannerSource(expectation, nonce, labels);
    const command = `SCAN="$(mktemp --suffix=.cjs)"; cat > "$SCAN" <<'WT_PROVENANCE_EOF'
${scanner}
WT_PROVENANCE_EOF
node "$SCAN"; RC=$?; rm -f "$SCAN"; exit $RC`;
    return `PROVENANCE_ANCHOR: ${nonce}

You are a mechanical provenance checker. Do exactly this, nothing else:

1. Run this EXACT Bash command (it writes a temporary script, runs it, and removes it):

\`\`\`bash
` + command + `
\`\`\`

2. The command prints ONE line of JSON of the shape {"anchored":true,"results":[{"label":"\u2026","cliSeen":true|false|null}]}.
Return that JSON line VERBATIM as your entire reply \u2014 no prose, no code fence, no edits. If the command prints nothing or errors, reply with exactly {"anchored":false,"results":[]}.

Do NOT analyze the ${expectation.id} verdicts yourself. Do NOT read or reason about the claims. Your only job is to run the command and relay its JSON output.`;
  }
  function parseProvenanceReply(reply, labels) {
    const map = /* @__PURE__ */ new Map();
    const perLabel = extractLabelSeen(reply);
    for (const label of labels) {
      const seen = perLabel.get(label);
      map.set(label, seen === true ? "seen" : seen === false ? "absent" : "undetermined");
    }
    return map;
  }
  function extractLabelSeen(reply) {
    const out = /* @__PURE__ */ new Map();
    if (typeof reply !== "string") return out;
    const obj = firstJsonObject(reply);
    if (obj === null) return out;
    const anchored = obj.anchored;
    const results = obj.results;
    if (!Array.isArray(results)) return out;
    if (anchored === false && results.length > 0) return out;
    for (const row of results) {
      if (row === null || typeof row !== "object") continue;
      const label = row.label;
      const cliSeen = row.cliSeen;
      if (typeof label === "string" && typeof cliSeen === "boolean") out.set(label, cliSeen);
    }
    return out;
  }
  function firstJsonObject(text) {
    const start = text.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = text.slice(start, i + 1);
          try {
            return JSON.parse(slice);
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
  async function runProvenanceChecker(rt, expectation, labels, opts) {
    const prompt = buildProvenanceCheckerPrompt(expectation, opts.nonce, labels);
    let reply = null;
    try {
      const raw = await rt.agent(prompt, {
        label: opts.label,
        ...opts.phase !== void 0 ? { phase: opts.phase } : {},
        ...opts.model !== void 0 ? { model: opts.model } : {},
        ...opts.effort !== void 0 ? { effort: opts.effort } : {}
      });
      reply = typeof raw === "string" ? raw : null;
    } catch {
      reply = null;
    }
    const map = parseProvenanceReply(reply, labels);
    const replyOk = reply !== null && [...map.values()].some((p) => p !== "undetermined");
    return { map, replyOk };
  }

  // ../packages/patterns/src/adversarial-verification.ts
  var STAGE4 = "adversarialVerification";
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
      minValidVotes: minValidVotesOpt,
      model,
      effort,
      phase,
      maxVerifyClaims,
      verifierType,
      cacheWarm,
      stageKey
    } = options;
    const refuteThreshold = refuteThresholdOpt ?? 2;
    const minValidVotes = minValidVotesOpt ?? 2;
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
    if (!Number.isInteger(minValidVotes) || minValidVotes < 1) {
      throw new Error(
        `adversarialVerification: minValidVotes must be an integer >= 1, got ${String(minValidVotesOpt)}`
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
    const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE4, stageKey);
    if (stageKeyWarning !== void 0) warn(rt, warnings, stageKeyWarning);
    const stg = stageBuilder(STAGE4, salt);
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
    if (cacheWarm ?? true) {
      agentsSpawned++;
      trail.push(await runCacheWarmup(rt, warnings, stg("warm"), STAGE4, {
        ...phase !== void 0 ? { phase } : {},
        model: effectiveModel,
        ...effort !== void 0 ? { effort } : {},
        ...verifierType !== void 0 ? { agentType: verifierType } : {}
      }));
    }
    const trailByClaim = [];
    const retryTrailByClaim = [];
    const warningsByClaim = [];
    const perClaim = await Promise.all(
      keptClaims.map(async (claim, claimIndex) => {
        const claimVotes = perClaimVotes[claimIndex] ?? votesOpt;
        const voteStages = Array.from(
          { length: claimVotes },
          (_, voteIndex) => stg(`verify:${claimIndex}:${voteIndex}`)
        );
        const voteThunks = Array.from({ length: claimVotes }, (_, voteIndex) => {
          return async () => {
            const lens = lenses !== void 0 ? lenses[voteIndex] : void 0;
            const prompt = buildVerifierPrompt(claim, lens);
            const opts = {
              schema: VERIFIER_SCHEMA,
              label: voteStages[voteIndex],
              ...phase !== void 0 ? { phase } : {},
              model: effectiveModel,
              ...effort !== void 0 ? { effort } : {},
              ...verifierType !== void 0 ? { agentType: verifierType } : {}
            };
            return agentWithSchemaSalvage(rt, prompt, opts);
          };
        });
        const rawVotes = await rt.parallel(voteThunks);
        const voteOuts = rawVotes.map(
          (v) => v
        );
        const votes = voteOuts.map((o) => o?.value ?? null);
        return {
          claim,
          claimVotes,
          voteOuts,
          votes,
          voteStages,
          // A salvaged vote's credited value came from the `:salvage` respawn transcript —
          // point the provenance checker THERE (card #1824029483854726303 fix round).
          effectiveStages: voteStages.map(
            (s, vi) => voteOuts[vi]?.salvaged === true ? `${s}:salvage` : s
          ),
          provenanceDisqualified: new Array(votes.length).fill(false),
          retryStages: new Array(votes.length).fill(void 0),
          retryEffectiveStages: new Array(votes.length).fill(void 0),
          retryOuts: new Array(votes.length).fill(null),
          retryVotes: new Array(votes.length).fill(null),
          retryDisqualified: new Array(votes.length).fill(false)
        };
      })
    );
    const gateExpectation = externalGateExpectation(verifierType);
    let checkerRecord = null;
    if (gateExpectation !== null) {
      const allLabels = perClaim.flatMap((pc) => pc.effectiveStages);
      if (allLabels.length > 0) {
        agentsSpawned++;
        const checkLabel = stg(PROVENANCE_CHECK_SUFFIX);
        const { map: provMap, replyOk } = await runProvenanceChecker(rt, gateExpectation, allLabels, {
          label: checkLabel,
          ...phase !== void 0 ? { phase } : {},
          model: "haiku",
          effort: "low",
          // Fold rendered claim content into the nonce so two runs with the same vote SHAPE
          // but different claims get different anchors (cross-family review 2026-07-21).
          nonce: deriveProvenanceNonce(allLabels, perClaim.map((pc) => renderClaim(pc.claim)).join(" "))
        });
        checkerRecord = makeRecord(checkLabel, replyOk, { model: "haiku", effort: "low" });
        let disqualifiedCount = 0;
        let undeterminedCount = 0;
        for (const pc of perClaim) {
          for (let voteIndex = 0; voteIndex < pc.votes.length; voteIndex++) {
            if (pc.votes[voteIndex] === null) continue;
            const provenance = provMap.get(pc.effectiveStages[voteIndex]) ?? "undetermined";
            if (provenance === "seen") continue;
            pc.votes[voteIndex] = null;
            pc.provenanceDisqualified[voteIndex] = true;
            if (provenance === "absent") disqualifiedCount++;
            else undeterminedCount++;
          }
        }
        if (disqualifiedCount > 0) {
          warn(
            rt,
            warnings,
            `adversarialVerification: ${disqualifiedCount} external verifier votes DISQUALIFIED \u2014 no ${gateExpectation.id} CLI invocation found in the vote transcript (possible self-answer); treated as null`
          );
        }
        if (undeterminedCount > 0) {
          warn(
            rt,
            warnings,
            `adversarialVerification: ${undeterminedCount} external verifier votes had UNDETERMINED provenance (the checker ${replyOk ? "did not resolve them" : "failed"}); fail-closed, treated as null`
          );
        }
      }
    }
    let retryCheckerRecord = null;
    if (gateExpectation !== null) {
      const retryTargets = [];
      for (const pc of perClaim) {
        for (let voteIndex = 0; voteIndex < pc.votes.length; voteIndex++) {
          if (pc.provenanceDisqualified[voteIndex]) retryTargets.push({ pc, voteIndex });
        }
      }
      if (retryTargets.length > 0) {
        const retryThunks = retryTargets.map(({ pc, voteIndex }) => {
          const stage = `${pc.voteStages[voteIndex]}:retry`;
          pc.retryStages[voteIndex] = stage;
          return async () => {
            const lens = lenses !== void 0 ? lenses[voteIndex] : void 0;
            const prompt = buildVerifierPrompt(pc.claim, lens);
            const opts = {
              schema: VERIFIER_SCHEMA,
              label: stage,
              ...phase !== void 0 ? { phase } : {},
              model: effectiveModel,
              ...effort !== void 0 ? { effort } : {},
              ...verifierType !== void 0 ? { agentType: verifierType } : {}
            };
            return agentWithSchemaSalvage(rt, prompt, opts);
          };
        });
        const retryRaw = await rt.parallel(retryThunks);
        retryTargets.forEach((t, i) => {
          const out = retryRaw[i] ?? null;
          t.pc.retryOuts[t.voteIndex] = out;
          const retryStage = t.pc.retryStages[t.voteIndex];
          t.pc.retryEffectiveStages[t.voteIndex] = out?.salvaged === true ? `${retryStage}:salvage` : retryStage;
        });
        const retryLabels = retryTargets.map((t) => t.pc.retryEffectiveStages[t.voteIndex]);
        agentsSpawned++;
        const retryCheckLabel = stg(`${PROVENANCE_CHECK_SUFFIX}:retry`);
        const { map: retryProvMap, replyOk: retryReplyOk } = await runProvenanceChecker(
          rt,
          gateExpectation,
          retryLabels,
          {
            label: retryCheckLabel,
            ...phase !== void 0 ? { phase } : {},
            model: "haiku",
            effort: "low",
            nonce: deriveProvenanceNonce(retryLabels, perClaim.map((pc) => renderClaim(pc.claim)).join(" "))
          }
        );
        retryCheckerRecord = makeRecord(retryCheckLabel, retryReplyOk, { model: "haiku", effort: "low" });
        let recoveredCount = 0;
        let unrecoveredCount = 0;
        for (const { pc, voteIndex } of retryTargets) {
          const retryVote = pc.retryOuts[voteIndex]?.value ?? null;
          const provenance = retryProvMap.get(pc.retryEffectiveStages[voteIndex]) ?? "undetermined";
          if (retryVote !== null && provenance === "seen") {
            pc.retryVotes[voteIndex] = retryVote;
            recoveredCount++;
          } else {
            if (retryVote !== null) pc.retryDisqualified[voteIndex] = true;
            unrecoveredCount++;
          }
        }
        if (recoveredCount > 0) {
          warn(
            rt,
            warnings,
            `adversarialVerification: ${recoveredCount} gate-nullified verifier votes RECOVERED after one retry (a real ${gateExpectation.id} CLI invocation found on the re-spawn)`
          );
        }
        if (unrecoveredCount > 0) {
          warn(
            rt,
            warnings,
            `adversarialVerification: ${unrecoveredCount} gate-nullified verifier votes remained unrecovered after one retry`
          );
        }
      }
    }
    let flooredCount = 0;
    const verifiedKept = perClaim.map((pc, claimIndex) => {
      const claimRecords = [];
      const claimRetryRecords = [];
      const claimWarnings = [];
      for (let voteIndex = 0; voteIndex < pc.votes.length; voteIndex++) {
        const out = pc.voteOuts[voteIndex] ?? null;
        const vote = pc.votes[voteIndex] ?? null;
        const stage = pc.voteStages[voteIndex];
        agentsSpawned += out?.spawns ?? 1;
        claimRecords.push(makeRecord(
          stage,
          vote !== null,
          {
            model: effectiveModel,
            ...effort !== void 0 ? { effort } : {},
            // A surviving vote records its verdict; a gate-nullified vote records the
            // control reason (so the trail distinguishes a self-answer disqualification
            // from a plain agent failure); a plain failure records neither. The ORIGINAL
            // record ALWAYS reflects the first-pass outcome — a Phase B2 recovery does NOT
            // rewrite it (the recovered vote is a separate `:retry` record below), so the
            // disqualification stays auditable.
            ...vote !== null ? { decision: vote.verdict } : pc.provenanceDisqualified[voteIndex] ? { decision: "disqualified-no-provenance" } : {}
          }
        ));
        if (out !== null && out.salvageAttempted) {
          claimRecords.push(makeRecord(
            `${stage}:salvage`,
            out.salvaged,
            {
              model: effectiveModel,
              ...effort !== void 0 ? { effort } : {}
            }
          ));
        }
        for (const message of out?.warnings ?? []) claimWarnings.push(`${STAGE4}: ${message}`);
        const retryStage = pc.retryStages[voteIndex];
        if (retryStage !== void 0) {
          const retryOut = pc.retryOuts[voteIndex] ?? null;
          const recovered = pc.retryVotes[voteIndex] ?? null;
          agentsSpawned += retryOut?.spawns ?? 1;
          claimRetryRecords.push(makeRecord(
            retryStage,
            recovered !== null,
            {
              model: effectiveModel,
              ...effort !== void 0 ? { effort } : {},
              ...recovered !== null ? { decision: "retried-after-disqualification" } : pc.retryDisqualified[voteIndex] ? { decision: "disqualified-no-provenance" } : {}
            }
          ));
          if (retryOut !== null && retryOut.salvageAttempted) {
            claimRetryRecords.push(makeRecord(
              `${retryStage}:salvage`,
              retryOut.salvaged,
              {
                model: effectiveModel,
                ...effort !== void 0 ? { effort } : {}
              }
            ));
          }
          for (const message of retryOut?.warnings ?? []) claimWarnings.push(`${STAGE4}: ${message}`);
        }
      }
      trailByClaim[claimIndex] = claimRecords;
      retryTrailByClaim[claimIndex] = claimRetryRecords;
      warningsByClaim[claimIndex] = claimWarnings;
      const mergedVotes = pc.votes.map(
        (v, i) => v !== null ? v : pc.retryVotes[i] ?? null
      );
      const nonNull = mergedVotes.filter((v) => v !== null);
      const effectiveThreshold = Math.min(refuteThreshold, pc.claimVotes);
      const effectiveFloor = Math.min(minValidVotes, pc.claimVotes);
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
      if ((verdict === "confirmed" || verdict === "refuted") && nonNull.length < effectiveFloor) {
        verdict = "partially-confirmed";
        flooredCount++;
      }
      return { claim: pc.claim, verdict, votes: mergedVotes };
    });
    trail.push(...trailByClaim.flat());
    if (checkerRecord !== null) trail.push(checkerRecord);
    trail.push(...retryTrailByClaim.flat());
    if (retryCheckerRecord !== null) trail.push(retryCheckerRecord);
    for (const message of warningsByClaim.flat()) warn(rt, warnings, message);
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
    if (flooredCount > 0) {
      warn(
        rt,
        warnings,
        `adversarialVerification: ${flooredCount} claims demoted to partially-confirmed by the confidence floor (fewer than minValidVotes=${minValidVotes} surviving valid votes) \u2014 set minValidVotes:1 to disable`
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
    emitDigest(rt, { stage: STAGE4, ...phase !== void 0 ? { phase } : {}, counts });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/tournament.ts
  var STAGE5 = "tournament";
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
    assertAgentTypeOption(STAGE5, "attemptType", attemptType);
    assertAgentTypeOption(STAGE5, "judgeType", judgeType);
    assertAgentTypeOption(STAGE5, "synthesisType", synthesisType);
    let agentsSpawned = 0;
    let droppedAttempts = 0;
    let nullJudgeVoteCount = 0;
    const warnings = [];
    const trail = [];
    if (cacheWarm ?? true) {
      agentsSpawned++;
      trail.push(await runCacheWarmup(rt, warnings, `${STAGE5}:warm:attempt`, STAGE5, {
        ...phase !== void 0 ? { phase } : {},
        ...attemptModel !== void 0 ? { model: attemptModel } : {},
        ...attemptEffort !== void 0 ? { effort: attemptEffort } : {},
        ...attemptType !== void 0 ? { agentType: attemptType } : {}
      }));
    }
    const attemptThunks = angles.map((angle, i) => async () => {
      const opts = {
        label: `${STAGE5}:attempt:${i}`,
        ...phase !== void 0 ? { phase } : {},
        ...attemptSchema !== void 0 ? { schema: attemptSchema } : {},
        ...attemptModel !== void 0 ? { model: attemptModel } : {},
        ...attemptEffort !== void 0 ? { effort: attemptEffort } : {},
        ...attemptType !== void 0 ? { agentType: attemptType } : {}
      };
      return agentWithSchemaSalvage(rt, attemptPrompt(angle, i), opts);
    });
    const attemptResults = await rt.parallel(attemptThunks);
    const survivingAttempts = [];
    for (let i = 0; i < attemptResults.length; i++) {
      const out = attemptResults[i];
      const attempt = out?.value ?? null;
      agentsSpawned += out?.spawns ?? 1;
      trail.push(makeRecord(`${STAGE5}:attempt:${i}`, attempt !== null, {
        ...attemptModel !== void 0 ? { model: attemptModel } : {},
        ...attemptEffort !== void 0 ? { effort: attemptEffort } : {}
      }));
      if (out !== null && out.salvageAttempted) {
        trail.push(makeRecord(`${STAGE5}:attempt:${i}:salvage`, out.salvaged, {
          ...attemptModel !== void 0 ? { model: attemptModel } : {},
          ...attemptEffort !== void 0 ? { effort: attemptEffort } : {}
        }));
      }
      for (const message of out?.warnings ?? []) warn(rt, warnings, `${STAGE5}: ${message}`);
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
      emitDigest(rt, { stage: STAGE5, ...phase !== void 0 ? { phase } : {}, counts: { attempts: 0 } });
      return { value: null, stats: stats2, warnings, trail };
    }
    const ranked = [];
    let unjudgeableCount = 0;
    if (cacheWarm ?? true) {
      agentsSpawned++;
      trail.push(await runCacheWarmup(rt, warnings, `${STAGE5}:warm:judge`, STAGE5, {
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
              label: `${STAGE5}:judge:${originalIndex}:${judgeIndex}`,
              ...phase !== void 0 ? { phase } : {},
              ...judgeModel !== void 0 ? { model: judgeModel } : {},
              ...judgeEffort !== void 0 ? { effort: judgeEffort } : {},
              ...judgeType !== void 0 ? { agentType: judgeType } : {}
            };
            return agentWithSchemaSalvage(rt, judgePrompt(attempt), opts);
          };
        });
        return rt.parallel(judgeThunks);
      })
    );
    survivingAttempts.forEach(({ attempt, angle, originalIndex }, i) => {
      const judgeOuts = (panels[i] ?? []).map(
        (r) => r
      );
      const judgeResults = judgeOuts.map((o) => o?.value ?? null);
      for (let judgeIndex = 0; judgeIndex < judgeResults.length; judgeIndex++) {
        const out = judgeOuts[judgeIndex] ?? null;
        const judgeResult = judgeResults[judgeIndex] ?? null;
        agentsSpawned += out?.spawns ?? 1;
        trail.push(makeRecord(`${STAGE5}:judge:${originalIndex}:${judgeIndex}`, judgeResult !== null, {
          ...judgeModel !== void 0 ? { model: judgeModel } : {},
          ...judgeEffort !== void 0 ? { effort: judgeEffort } : {},
          ...judgeResult !== null ? { decision: `score=${judgeResult.score}` } : {}
        }));
        if (out !== null && out.salvageAttempted) {
          trail.push(makeRecord(`${STAGE5}:judge:${originalIndex}:${judgeIndex}:salvage`, out.salvaged, {
            ...judgeModel !== void 0 ? { model: judgeModel } : {},
            ...judgeEffort !== void 0 ? { effort: judgeEffort } : {}
          }));
        }
        for (const message of out?.warnings ?? []) warn(rt, warnings, `${STAGE5}: ${message}`);
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
      emitDigest(rt, { stage: STAGE5, ...phase !== void 0 ? { phase } : {}, counts: { attempts: 0 } });
      return { value: null, stats: stats2, warnings, trail };
    }
    ranked.sort((a, b) => b.score - a.score);
    const synthOpts = {
      label: `${STAGE5}:synthesize`,
      ...phase !== void 0 ? { phase } : {},
      ...synthesisSchema !== void 0 ? { schema: synthesisSchema } : {},
      ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
      ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {},
      ...synthesisType !== void 0 ? { agentType: synthesisType } : {}
    };
    const synthOut = await agentWithSchemaSalvage(rt, synthesisPrompt(ranked), synthOpts);
    agentsSpawned += synthOut.spawns;
    const synthesis = synthOut.value;
    const winnerOriginalIndex = ranked[0]?.originalIndex ?? 0;
    trail.push(makeRecord(`${STAGE5}:synthesize`, synthesis !== null, {
      ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
      ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {},
      decision: `winner=${winnerOriginalIndex}`
    }));
    if (synthOut.salvageAttempted) {
      trail.push(makeRecord(`${STAGE5}:synthesize:salvage`, synthOut.salvaged, {
        ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
        ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {}
      }));
    }
    for (const message of synthOut.warnings) warn(rt, warnings, `${STAGE5}: ${message}`);
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
      stage: STAGE5,
      ...phase !== void 0 ? { phase } : {},
      ...winner !== void 0 ? { taken: [`attempt:${winner.originalIndex}`] } : {},
      notTaken: ranked.slice(1).map((r) => `attempt:${r.originalIndex}`),
      counts: { attempts: ranked.length }
    });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/loop-until-done.ts
  var STAGE6 = LOOP_STAGE;
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
        const label = opts?.label != null ? `${opts.label}${LOOP_ITER_MARKER}${currentIteration}` : `${STAGE6}:iter:${currentIteration}`;
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
        trail.push(makeRecord(`${STAGE6}:tick:${tickIndex}`, tick.state !== null));
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
    emitDigest(rt, { stage: STAGE6, output: stoppedBy, counts: { iterations: iterationsDone } });
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

  // ../packages/patterns/src/plan-and-execute.ts
  var STAGE7 = "planAndExecute";
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
      maxSubtasks,
      stageKey,
      cacheWarm
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
    assertAgentTypeOption(STAGE7, "planType", planType);
    assertAgentTypeOption(STAGE7, "workerType", workerType);
    assertAgentTypeOption(STAGE7, "synthesisType", synthesisType);
    let agentsSpawned = 0;
    const warnings = [];
    const trail = [];
    const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE7, stageKey);
    if (stageKeyWarning !== void 0) warn(rt, warnings, stageKeyWarning);
    const stg = stageBuilder(STAGE7, salt);
    const planStage = stg("plan");
    const planOpts = {
      schema: PLAN_SCHEMA,
      label: planStage,
      ...phase !== void 0 ? { phase } : {},
      ...planModel !== void 0 ? { model: planModel } : {},
      ...planEffort !== void 0 ? { effort: planEffort } : {},
      ...planType !== void 0 ? { agentType: planType } : {}
    };
    const planOut = await agentWithSchemaSalvage(rt, planPrompt, planOpts);
    agentsSpawned += planOut.spawns;
    for (const message of planOut.warnings) warn(rt, warnings, `${STAGE7}: ${message}`);
    const plan = planOut.value;
    const pushPlanSalvageRecord = () => {
      if (planOut.salvageAttempted) {
        trail.push(makeRecord(`${planStage}:salvage`, planOut.salvaged, {
          ...planModel !== void 0 ? { model: planModel } : {},
          ...planEffort !== void 0 ? { effort: planEffort } : {}
        }));
      }
    };
    if (plan === null) {
      warn(rt, warnings, "planAndExecute: planner returned null \u2014 nothing executed");
      trail.push(makeRecord(planStage, false, {
        ...planModel !== void 0 ? { model: planModel } : {},
        ...planEffort !== void 0 ? { effort: planEffort } : {}
      }));
      pushPlanSalvageRecord();
      const stats2 = {
        itemsIn: 0,
        itemsOut: 0,
        agentsSpawned,
        dropped: 0,
        truncated: 0
      };
      emitDigest(rt, { stage: STAGE7, ...phase !== void 0 ? { phase } : {}, output: "synthesis: none", counts: { planned: 0, executed: 0, dropped: 0, truncated: 0 } });
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
    trail.push(makeRecord(planStage, true, {
      ...planModel !== void 0 ? { model: planModel } : {},
      ...planEffort !== void 0 ? { effort: planEffort } : {},
      decision: `subtasks=${keptSubtasks.length}`
    }));
    pushPlanSalvageRecord();
    const keptArray = keptSubtasks;
    const workStages = keptArray.map((_, i) => stg(`work:${i}`));
    const workerThunks = keptArray.map((subtask, i) => async () => {
      const opts = {
        label: workStages[i],
        ...phase !== void 0 ? { phase } : {},
        ...workerSchema !== void 0 ? { schema: workerSchema } : {},
        ...workerModel !== void 0 ? { model: workerModel } : {},
        ...workerEffort !== void 0 ? { effort: workerEffort } : {},
        ...workerType !== void 0 ? { agentType: workerType } : {}
      };
      return agentWithSchemaSalvage(rt, workerPrompt(subtask, i), opts);
    });
    const rawWorkerResults = await parallelWithCacheWarm(rt, workerThunks, cacheWarm ?? true);
    const successfulResults = [];
    let droppedWorkers = 0;
    for (let i = 0; i < rawWorkerResults.length; i++) {
      const out = rawWorkerResults[i];
      const r = out?.value ?? null;
      const workStage = workStages[i];
      agentsSpawned += out?.spawns ?? 1;
      trail.push(makeRecord(workStage, r !== null, {
        ...workerModel !== void 0 ? { model: workerModel } : {},
        ...workerEffort !== void 0 ? { effort: workerEffort } : {}
      }));
      if (out !== null && out.salvageAttempted) {
        trail.push(makeRecord(`${workStage}:salvage`, out.salvaged, {
          ...workerModel !== void 0 ? { model: workerModel } : {},
          ...workerEffort !== void 0 ? { effort: workerEffort } : {}
        }));
      }
      for (const message of out?.warnings ?? []) warn(rt, warnings, `${STAGE7}: ${message}`);
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
      emitDigest(rt, { stage: STAGE7, ...phase !== void 0 ? { phase } : {}, output: "synthesis: none", counts: { planned: plannedCount, executed: 0, dropped: droppedWorkers, truncated } });
      return { value: null, stats: stats2, warnings, workerResults: [], trail };
    }
    const synthesizeStage = stg("synthesize");
    const synthOpts = {
      label: synthesizeStage,
      ...phase !== void 0 ? { phase } : {},
      ...synthesisSchema !== void 0 ? { schema: synthesisSchema } : {},
      ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
      ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {},
      ...synthesisType !== void 0 ? { agentType: synthesisType } : {}
    };
    const synthOut = await agentWithSchemaSalvage(rt, synthesisPrompt(successfulResults), synthOpts);
    agentsSpawned += synthOut.spawns;
    const synthesis = synthOut.value;
    trail.push(makeRecord(synthesizeStage, synthesis !== null, {
      ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
      ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {}
    }));
    if (synthOut.salvageAttempted) {
      trail.push(makeRecord(`${synthesizeStage}:salvage`, synthOut.salvaged, {
        ...synthesisModel !== void 0 ? { model: synthesisModel } : {},
        ...synthesisEffort !== void 0 ? { effort: synthesisEffort } : {}
      }));
    }
    for (const message of synthOut.warnings) warn(rt, warnings, `${STAGE7}: ${message}`);
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
      stage: STAGE7,
      ...phase !== void 0 ? { phase } : {},
      output: value === null ? "synthesis: none" : "synthesis: ok",
      counts: { planned: plannedCount, executed: successfulResults.length, dropped: droppedWorkers, truncated }
    });
    return { value, stats, warnings, workerResults: successfulResults, trail };
  }

  // ../packages/patterns/src/score-and-rank.ts
  var STAGE8 = "scoreAndRank";
  var scoreSchema = {
    type: "object",
    properties: {
      score: { type: "number" },
      reason: { type: "string" }
    },
    required: ["score", "reason"],
    additionalProperties: false
  };
  async function scoreAndRank(rt, options) {
    const { items, dimensions, scoreModel, scoreEffort, scoreType, cutoff, maxItems, phase, stageKey, cacheWarm } = options;
    const combine = options.combine ?? ((scores) => scores.reduce((a, b) => a * b, 1));
    if (items.length < 1) {
      throw new Error(`scoreAndRank: items must be a non-empty array \u2014 got length ${items.length}`);
    }
    if (dimensions.length < 1) {
      throw new Error("scoreAndRank: dimensions must be a non-empty array \u2014 pass at least one ScoreDimension");
    }
    const ct = cutoff;
    if (ct.type === "threshold") {
      if (!Number.isFinite(ct.min)) {
        throw new Error(`scoreAndRank: threshold cutoff needs a finite min, got ${String(ct.min)}`);
      }
    } else if (ct.type === "topK") {
      const k = ct.k;
      if (typeof k !== "number" || !Number.isInteger(k) || k < 1) {
        throw new Error(`scoreAndRank: topK cutoff needs an integer k >= 1, got ${String(k)}`);
      }
    } else {
      throw new Error("scoreAndRank: cutoff must be { type: 'threshold', min } or { type: 'topK', k }");
    }
    assertAgentTypeOption(STAGE8, "scoreType", scoreType);
    let agentsSpawned = 0;
    let dropped = 0;
    const warnings = [];
    const { kept: keptItems, truncated } = applyCap(items, maxItems);
    const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE8, stageKey);
    if (stageKeyWarning !== void 0) warn(rt, warnings, stageKeyWarning);
    const stg = stageBuilder(STAGE8, salt);
    const pendingTrail = [];
    const pendingWarnings = [];
    const tasks = [];
    for (let i = 0; i < keptItems.length; i++) {
      for (let d = 0; d < dimensions.length; d++) {
        tasks.push({ itemIndex: i, dimIndex: d });
      }
    }
    const thunks = tasks.map((t) => async () => {
      const dim = dimensions[t.dimIndex];
      const item = keptItems[t.itemIndex];
      if (dim === void 0 || item === void 0) return null;
      const model = dim.model ?? scoreModel;
      const effort = dim.effort ?? scoreEffort;
      const label = stg(`score:${t.itemIndex}:${dim.name}`);
      const opts = {
        schema: scoreSchema,
        label,
        ...phase !== void 0 ? { phase } : {},
        ...model !== void 0 ? { model } : {},
        ...effort !== void 0 ? { effort } : {},
        ...scoreType !== void 0 ? { agentType: scoreType } : {}
      };
      const order = t.itemIndex * dimensions.length + t.dimIndex;
      const scoreOut = await agentWithSchemaSalvage(rt, dim.prompt(item), opts);
      agentsSpawned += scoreOut.spawns;
      for (const message of scoreOut.warnings) pendingWarnings.push({ order, message });
      if (scoreOut.salvageAttempted) {
        pendingTrail.push({
          order: order + 0.5,
          record: makeRecord(`${label}:salvage`, scoreOut.salvaged, {
            ...model !== void 0 ? { model } : {},
            ...effort !== void 0 ? { effort } : {}
          })
        });
      }
      const verdict = scoreOut.value;
      if (verdict === null) {
        pendingTrail.push({
          order,
          record: makeRecord(label, false, {
            ...model !== void 0 ? { model } : {},
            ...effort !== void 0 ? { effort } : {}
          })
        });
        return null;
      }
      pendingTrail.push({
        order,
        record: makeRecord(label, true, {
          ...model !== void 0 ? { model } : {},
          ...effort !== void 0 ? { effort } : {},
          decision: `score=${verdict.score}`
        })
      });
      return { itemIndex: t.itemIndex, dimIndex: t.dimIndex, score: verdict.score };
    });
    const rawCells = await parallelWithCacheWarm(rt, thunks, cacheWarm ?? true);
    const dimScores = keptItems.map(() => dimensions.map(() => null));
    for (const cell of rawCells) {
      if (cell === null) continue;
      const row = dimScores[cell.itemIndex];
      if (row !== void 0) row[cell.dimIndex] = cell.score;
    }
    const scoredItems = [];
    for (let i = 0; i < keptItems.length; i++) {
      const item = keptItems[i];
      const row = dimScores[i];
      if (item === void 0 || row === void 0) continue;
      if (row.some((s) => s === null)) {
        dropped++;
        continue;
      }
      const scores = row.filter((s) => s !== null);
      const combined = combine(scores);
      if (!scores.every((s) => Number.isFinite(s)) || !Number.isFinite(combined)) {
        dropped++;
        continue;
      }
      scoredItems.push({ item, scores: [...scores], score: combined });
    }
    pendingWarnings.sort((a, b) => a.order - b.order);
    for (const entry of pendingWarnings) warn(rt, warnings, `${STAGE8}: ${entry.message}`);
    if (dropped > 0) {
      warn(
        rt,
        warnings,
        `${STAGE8}: ${dropped} of ${keptItems.length} items dropped (a dimension score was null or non-finite \u2014 fail-closed, item un-rankable)`
      );
    }
    const ranked = scoredItems.map((si, idx) => ({ si, idx })).sort((a, b) => b.si.score - a.si.score || a.idx - b.idx).map((x) => x.si);
    const survivors = cutoff.type === "threshold" ? ranked.filter((s) => s.score >= cutoff.min) : ranked.slice(0, cutoff.k);
    const rejectedByCutoff = ranked.length - survivors.length;
    if (rejectedByCutoff > 0) {
      rt.log(`${STAGE8}: ${rejectedByCutoff} of ${ranked.length} ranked items cut by the ${cutoff.type} cutoff`);
    }
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `${STAGE8}: ${truncated} of ${items.length} items not scored (maxItems cap)`
      );
    }
    const stats = {
      itemsIn: items.length,
      itemsOut: survivors.length,
      agentsSpawned,
      dropped,
      truncated
    };
    pendingTrail.sort((a, b) => a.order - b.order);
    const trail = pendingTrail.map((e) => e.record);
    emitDigest(rt, {
      stage: STAGE8,
      ...phase !== void 0 ? { phase } : {},
      counts: {
        requested: items.length,
        kept: survivors.length,
        cut: rejectedByCutoff,
        dropped,
        truncated
      }
    });
    return { value: survivors, stats, warnings, trail };
  }

  // ../packages/patterns/src/chunked-analysis.ts
  var STAGE9 = "chunkedAnalysis";
  function chunkText(input, options) {
    const { maxChars, overlapChars = 0 } = options;
    if (!Number.isInteger(maxChars) || maxChars < 1) {
      throw new Error(
        `chunkText: maxChars must be an integer >= 1, got ${String(maxChars)}`
      );
    }
    if (!Number.isInteger(overlapChars) || overlapChars < 0) {
      throw new Error(
        `chunkText: overlapChars must be an integer >= 0, got ${String(overlapChars)}`
      );
    }
    if (overlapChars >= maxChars) {
      throw new Error(
        `chunkText: overlapChars (${overlapChars}) must be < maxChars (${maxChars}) \u2014 an overlap >= the chunk size makes no forward progress`
      );
    }
    const pieces = typeof input === "string" ? [input] : input;
    const out = [];
    for (const piece of pieces) {
      chunkOnePiece(piece, maxChars, overlapChars, out);
    }
    return out;
  }
  function chunkOnePiece(text, maxChars, overlapChars, out) {
    if (text.length === 0) return;
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxChars, text.length);
      if (end < text.length) {
        const nl = text.lastIndexOf("\n", end - 1);
        if (nl > start) end = nl + 1;
      }
      out.push(text.slice(start, end));
      if (end >= text.length) break;
      let next = end - overlapChars;
      if (next <= start) next = end;
      start = next;
    }
  }
  async function chunkedAnalysis(rt, options) {
    const {
      input,
      maxChars,
      overlapChars,
      analyzePrompt,
      analyzeSchema,
      analyzeModel,
      analyzeEffort,
      analyzeType,
      synthesizePrompt,
      synthesizeSchema,
      synthesizeModel,
      synthesizeEffort,
      synthesizeType,
      phase,
      maxChunks,
      stageKey,
      cacheWarm
    } = options;
    assertAgentTypeOption(STAGE9, "analyzeType", analyzeType);
    assertAgentTypeOption(STAGE9, "synthesizeType", synthesizeType);
    if (maxChunks !== void 0 && maxChunks < 1) {
      throw new Error(`chunkedAnalysis: maxChunks must be >= 1, got ${maxChunks}`);
    }
    const chunks = chunkText(input, {
      maxChars,
      ...overlapChars !== void 0 ? { overlapChars } : {}
    });
    if (chunks.length === 0) {
      throw new Error(
        "chunkedAnalysis: input produced no chunks (empty input) \u2014 provide non-empty content to analyze"
      );
    }
    let agentsSpawned = 0;
    const warnings = [];
    const trail = [];
    const { kept: keptChunks, truncated } = applyCap(chunks, maxChunks);
    const total = keptChunks.length;
    const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE9, stageKey);
    if (stageKeyWarning !== void 0) warn(rt, warnings, stageKeyWarning);
    const stg = stageBuilder(STAGE9, salt);
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `chunkedAnalysis: ${truncated} of ${chunks.length} chunks truncated by maxChunks=${maxChunks ?? "?"}`
      );
    }
    const keptArray = keptChunks;
    const chunkStages = keptArray.map((_, i) => stg(`chunk:${i}`));
    const analyzeThunks = keptArray.map((chunk, i) => async () => {
      const opts = {
        label: chunkStages[i],
        ...phase !== void 0 ? { phase } : {},
        ...analyzeSchema !== void 0 ? { schema: analyzeSchema } : {},
        ...analyzeModel !== void 0 ? { model: analyzeModel } : {},
        ...analyzeEffort !== void 0 ? { effort: analyzeEffort } : {},
        ...analyzeType !== void 0 ? { agentType: analyzeType } : {}
      };
      return agentWithSchemaSalvage(rt, analyzePrompt(chunk, i, total), opts);
    });
    const analyzeResults = await parallelWithCacheWarm(rt, analyzeThunks, cacheWarm ?? true);
    const chunkResults = [];
    let dropped = 0;
    for (let i = 0; i < analyzeResults.length; i++) {
      const out = analyzeResults[i];
      const r = out?.value ?? null;
      const chunkStage = chunkStages[i];
      agentsSpawned += out?.spawns ?? 1;
      trail.push(makeRecord(chunkStage, r !== null, {
        ...analyzeModel !== void 0 ? { model: analyzeModel } : {},
        ...analyzeEffort !== void 0 ? { effort: analyzeEffort } : {}
      }));
      if (out !== null && out.salvageAttempted) {
        trail.push(makeRecord(`${chunkStage}:salvage`, out.salvaged, {
          ...analyzeModel !== void 0 ? { model: analyzeModel } : {},
          ...analyzeEffort !== void 0 ? { effort: analyzeEffort } : {}
        }));
      }
      for (const message of out?.warnings ?? []) warn(rt, warnings, `${STAGE9}: ${message}`);
      if (r !== null) {
        chunkResults.push(r);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      warn(
        rt,
        warnings,
        `chunkedAnalysis: ${dropped} of ${keptArray.length} chunk analyzers returned null`
      );
    }
    let value = null;
    if (chunkResults.length === 0) {
      warn(rt, warnings, "chunkedAnalysis: every chunk analysis was null; synthesis skipped");
    } else {
      const synthesizeStage = stg("synthesize");
      const synthOpts = {
        label: synthesizeStage,
        ...phase !== void 0 ? { phase } : {},
        ...synthesizeSchema !== void 0 ? { schema: synthesizeSchema } : {},
        ...synthesizeModel !== void 0 ? { model: synthesizeModel } : {},
        ...synthesizeEffort !== void 0 ? { effort: synthesizeEffort } : {},
        ...synthesizeType !== void 0 ? { agentType: synthesizeType } : {}
      };
      const synthOut = await agentWithSchemaSalvage(rt, synthesizePrompt(chunkResults), synthOpts);
      agentsSpawned += synthOut.spawns;
      const synthesis = synthOut.value;
      trail.push(makeRecord(synthesizeStage, synthesis !== null, {
        ...synthesizeModel !== void 0 ? { model: synthesizeModel } : {},
        ...synthesizeEffort !== void 0 ? { effort: synthesizeEffort } : {}
      }));
      if (synthOut.salvageAttempted) {
        trail.push(makeRecord(`${synthesizeStage}:salvage`, synthOut.salvaged, {
          ...synthesizeModel !== void 0 ? { model: synthesizeModel } : {},
          ...synthesizeEffort !== void 0 ? { effort: synthesizeEffort } : {}
        }));
      }
      for (const message of synthOut.warnings) warn(rt, warnings, `${STAGE9}: ${message}`);
      if (synthesis === null) {
        warn(rt, warnings, "chunkedAnalysis: synthesis agent returned null");
      } else {
        value = synthesis;
      }
    }
    const stats = {
      itemsIn: chunks.length,
      itemsOut: chunkResults.length,
      agentsSpawned,
      dropped,
      truncated
    };
    emitDigest(rt, {
      stage: STAGE9,
      ...phase !== void 0 ? { phase } : {},
      output: value === null ? "synthesis: none" : `synthesis from ${chunkResults.length}/${chunks.length} chunks`,
      counts: { chunks: chunks.length, analyzed: chunkResults.length, dropped, truncated }
    });
    return { value, stats, warnings, trail, chunkResults };
  }

  // all-patterns-workflow.workflow.ts
  var GUARD = " IMPORTANT: render demo \u2014 reply with a short line of TEXT ONLY. Do NOT use any tools, and do NOT create, modify, or delete any files.";
  var GATE_SCHEMA = {
    type: "object",
    properties: {
      approve: { type: "boolean" },
      reason: { type: "string", maxLength: 160 }
    },
    required: ["approve", "reason"],
    additionalProperties: false
  };
  function parseInput(raw) {
    const obj = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const perAgent = parseConfig(obj).perAgent ?? null;
    return { perAgent };
  }
  async function runDeepPipeline(rt, resolvedModel) {
    rt.phase("Generate");
    const gen = await generateAndFilter(rt, {
      count: 2,
      generatePrompt: (i) => `Render demo. Write playful mascot tagline candidate #${i} (one short line).${GUARD}`,
      filterPrompt: (c) => `Render demo. Keep this tagline? Answer yes or no: "${c}".${GUARD}`,
      phase: "Generate"
    });
    rt.phase("Chunk");
    const chunk = await chunkedAnalysis(rt, {
      input: "LOVE the colors\nfont too small\nLOVE the mascot\nfont too small\nmascot is scary",
      maxChars: 24,
      analyzePrompt: (c, i, total) => `Render demo. Chunk ${i + 1}/${total}. Summarize the feedback themes in one short line:
${c}${GUARD}`,
      synthesizePrompt: (parts) => `Render demo. Merge these ${parts.length} theme notes into one short "top clusters" line.${GUARD}`,
      phase: "Chunk"
    });
    rt.phase("Verify");
    const verify = await adversarialVerification(rt, {
      model: resolvedModel,
      effort: "low",
      claims: ["mascots boost recall", "small fonts help reading"],
      renderClaim: (claim) => `Render demo. Decide if this claim is true, refuting if uncertain: "${claim}".${GUARD}`,
      phase: "Verify"
    });
    rt.phase("Refine-Inner");
    const inner = await loopUntilDone(rt, {
      initial: { rounds: 0 },
      maxIterations: 2,
      body: async (rtBody, state, iteration) => {
        await rtBody.agent(`Render demo (inner polish), pass ${iteration}. Tighten the tagline into one snappier line.${GUARD}`, {
          label: `refine-inner:pass:${iteration}`
        });
        return { state: { rounds: state.rounds + 1 }, done: iteration >= 1 };
      }
    });
    return {
      clusters: chunk.value,
      trail: collectTrail(gen, chunk, verify, inner)
    };
  }
  async function runNestedPipeline(rt, resolvedModel) {
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
    const deep = await runDeepPipeline(rt, resolvedModel);
    rt.phase("Plan");
    const plan = await planAndExecute(rt, {
      planPrompt: `Render demo. Return a 3-item PLAN (do NOT implement) that splits "introduce the mascot" into 3 independent one-line steps.${GUARD}`,
      workerPrompt: (subtask, i) => `Render demo, step ${i}: ${subtask.description}. Reply in one short line.${GUARD}`,
      synthesisPrompt: (results) => `Render demo. Combine these ${results.length} step lines into one rollout summary.${GUARD}`,
      phase: "Plan"
    });
    return {
      tagline: compete.value,
      clusters: deep.clusters,
      trail: collectTrail(fan, compete, { trail: deep.trail }, plan)
    };
  }
  async function run(rt0, input) {
    const resolvedModel = input.perAgent?.model ?? "haiku";
    const rt = withAgentDefaults(rt0, { effort: "low", ...input.perAgent ?? {}, model: resolvedModel });
    rt.phase("Route");
    const route = await classifyAndAct(rt, {
      items: ["a new mascot"],
      categories: ["playful", "serious"],
      classifyPrompt: (item) => `Render demo. Classify the tone for "${item}": playful or serious. Return {"category":"..."}.${GUARD}`,
      actions: {
        playful: { prompt: (item) => `Render demo. "${item}" is playful \u2014 give a one-line upbeat brief.${GUARD}` },
        serious: { prompt: (item) => `Render demo. "${item}" is serious \u2014 give a one-line measured brief.${GUARD}` }
      },
      phase: "Route"
    });
    rt.phase("Gate");
    const gate = await rt.agent(
      `Render demo. Approve this mascot brief to proceed? Reply {"approve":true,"reason":"..."} (approve for the demo).${GUARD}`,
      { label: "gate:approve", phase: "Gate", schema: GATE_SCHEMA }
    );
    const approved = gate?.approve ?? true;
    rt.log(`demo-showcase-v2 gate: ${approved ? "approved" : "reject vote overridden (auto-approve)"} \u2014 proceeding`);
    const gateTrail = { trail: [makeRecord("gate:approve", gate !== null, {})] };
    const nested = await runNestedPipeline(rt, resolvedModel);
    rt.phase("Refine-Outer");
    const outer = await loopUntilDone(rt, {
      initial: { rounds: 0 },
      maxIterations: 2,
      body: async (rtBody, state, iteration) => {
        await rtBody.agent(`Render demo (outer polish), round ${iteration}. Refine the overall mascot brief into one crisp line.${GUARD}`, {
          label: `refine-outer:round:${iteration}`
        });
        return { state: { rounds: state.rounds + 1 }, done: iteration >= 1 };
      }
    });
    rt.phase("Triage");
    const triage = await scoreAndRank(rt, {
      items: ["social", "email", "billboard"],
      dimensions: [
        { name: "reach", prompt: (item) => `Render demo. Score the reach of "${item}" 1-5. Return {"score":N,"reason":"..."}.${GUARD}` }
      ],
      cutoff: { type: "topK", k: 2 },
      phase: "Triage"
    });
    return {
      marker: "ALL_PATTERNS_WORKFLOW_OK",
      route: route.value[0]?.category ?? null,
      approved,
      tagline: nested.tagline,
      clusters: nested.clusters,
      triage: triage.value.length,
      envelope: {
        trail: collectTrail(route, gateTrail, { trail: nested.trail }, outer, triage)
      }
    };
  }
  var all_patterns_workflow_workflow_default = defineWorkflow({
    meta: {
      name: "all-patterns-workflow",
      description: "All nine patterns in one run: three levels of in-run nesting (root \u2192 nested \u2192 deep), each level exercising different patterns, with loopUntilDone drawn both inner and outer, an auto-approvable in-code gate, and every agent honoring args.perAgent.model (defaults to haiku). The single-artifact sibling of the demo-showcase-v2 orchestrator pipeline. A render/cost fixture, not a real workflow.",
      whenToUse: 'Launch to render every pattern shape across three nesting levels in ONE workflow run (a rendering/single-view fixture) \u2014 never for real work; the result is meaningless by design. For the real gated, nested pipeline-of-pipelines showcase use demo-showcase-v2.pipeline instead. Pin args.perAgent={model:"haiku"} for a trivially cheap capture run.',
      phases: [
        { title: "Route", detail: "L1 root \u2014 classifyAndAct: one router then one handler" },
        { title: "Gate", detail: "L1 root \u2014 auto-approvable human gate at the phase boundary" },
        { title: "Fan", detail: "L2 nested \u2014 fanOutAndSynthesize (scatter-gather) of angle workers" },
        { title: "Compete", detail: "L2 nested \u2014 tournament: attempts, judges, synthesis funnel" },
        { title: "Generate", detail: "L3 deep \u2014 generateAndFilter: candidate taglines, filtered" },
        { title: "Chunk", detail: "L3 deep \u2014 chunkedAnalysis: map-reduce a feedback log into clusters" },
        { title: "Verify", detail: "L3 deep \u2014 adversarialVerification: refute-first verifier fan" },
        { title: "Refine-Inner", detail: "L3 deep \u2014 loopUntilDone INNER: intra-phase polish loop" },
        { title: "Plan", detail: "L2 nested \u2014 planAndExecute: planner then dynamic workers" },
        { title: "Refine-Outer", detail: "L1 root \u2014 loopUntilDone OUTER: root-level polish loop" },
        { title: "Triage", detail: "L1 root \u2014 scoreAndRank: cheap per-dimension scoring + cutoff" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(all_patterns_workflow_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

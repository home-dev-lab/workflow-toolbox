export const meta = {
  "name": "showcase-route-triage",
  "description": "demo-showcase-v2 pipeline L1 root stage: classifyAndAct (Route) + scoreAndRank (Triage). Its output is the artifact a human gate approves. Every agent honors args.perAgent, defaulting to haiku + low. A render fixture, not real work.",
  "whenToUse": "Runs as the first stage of the demo-showcase-v2 orchestrator pipeline (or standalone as a render fixture). Not a real task workflow — the result is meaningless by design.",
  "phases": [
    {
      "title": "Route",
      "detail": "classifyAndAct — one router then one handler"
    },
    {
      "title": "Triage",
      "detail": "scoreAndRank — cheap per-dimension scoring + cutoff"
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

  // showcase-route-triage.workflow.ts
  var showcase_route_triage_workflow_exports = {};
  __export(showcase_route_triage_workflow_exports, {
    default: () => showcase_route_triage_workflow_default
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

  // ../packages/patterns/src/provenance-gate.ts
  var SCANNER_RECENCY_MS = 30 * 60 * 1e3;

  // ../packages/patterns/src/cache-warm.ts
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

  // ../packages/patterns/src/score-and-rank.ts
  var STAGE2 = "scoreAndRank";
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
    assertAgentTypeOption(STAGE2, "scoreType", scoreType);
    let agentsSpawned = 0;
    let dropped = 0;
    const warnings = [];
    const { kept: keptItems, truncated } = applyCap(items, maxItems);
    const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE2, stageKey);
    if (stageKeyWarning !== void 0) warn(rt, warnings, stageKeyWarning);
    const stg = stageBuilder(STAGE2, salt);
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
    for (const entry of pendingWarnings) warn(rt, warnings, `${STAGE2}: ${entry.message}`);
    if (dropped > 0) {
      warn(
        rt,
        warnings,
        `${STAGE2}: ${dropped} of ${keptItems.length} items dropped (a dimension score was null or non-finite \u2014 fail-closed, item un-rankable)`
      );
    }
    const ranked = scoredItems.map((si, idx) => ({ si, idx })).sort((a, b) => b.si.score - a.si.score || a.idx - b.idx).map((x) => x.si);
    if (ranked.length >= 2) {
      const first = ranked[0];
      if (first !== void 0 && ranked.every((s) => s.score === first.score)) {
        warn(
          rt,
          warnings,
          `${STAGE2}: every one of the ${ranked.length} scored items received the IDENTICAL score (${first.score}) \u2014 the ranking is arbitrary and any cutoff below cuts on order, not merit. Either the items really are equivalent, or the scoring prompt is not discriminating.`
        );
      }
    }
    const survivors = cutoff.type === "threshold" ? ranked.filter((s) => s.score >= cutoff.min) : ranked.slice(0, cutoff.k);
    const rejectedByCutoff = ranked.length - survivors.length;
    if (rejectedByCutoff > 0) {
      rt.log(`${STAGE2}: ${rejectedByCutoff} of ${ranked.length} ranked items cut by the ${cutoff.type} cutoff`);
    }
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `${STAGE2}: ${truncated} of ${items.length} items not scored (maxItems cap)`
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
      stage: STAGE2,
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

  // showcase-route-triage.workflow.ts
  var GUARD = " IMPORTANT: render demo \u2014 reply with a short line of TEXT ONLY. Do NOT use any tools, and do NOT create, modify, or delete any files.";
  function parseInput(raw) {
    const obj = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return { perAgent: parseConfig(obj).perAgent ?? null };
  }
  async function run(rt0, input) {
    const model = input.perAgent?.model ?? "haiku";
    const rt = withAgentDefaults(rt0, { effort: "low", ...input.perAgent ?? {}, model });
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
      stage: "route-triage",
      route: route.value[0]?.category ?? null,
      triageKept: triage.value.length,
      envelope: { trail: collectTrail(route, triage) }
    };
  }
  var showcase_route_triage_workflow_default = defineWorkflow({
    meta: {
      name: "showcase-route-triage",
      description: "demo-showcase-v2 pipeline L1 root stage: classifyAndAct (Route) + scoreAndRank (Triage). Its output is the artifact a human gate approves. Every agent honors args.perAgent, defaulting to haiku + low. A render fixture, not real work.",
      whenToUse: "Runs as the first stage of the demo-showcase-v2 orchestrator pipeline (or standalone as a render fixture). Not a real task workflow \u2014 the result is meaningless by design.",
      phases: [
        { title: "Route", detail: "classifyAndAct \u2014 one router then one handler" },
        { title: "Triage", detail: "scoreAndRank \u2014 cheap per-dimension scoring + cutoff" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(showcase_route_triage_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

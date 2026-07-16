export const meta = {
  "name": "loop-demo",
  "description": "Render demo: loopUntilDone drawn two ways — an intra-phase loop and a cross-phase loop over a real generateAndFilter→scoreAndRank pipeline — for observe-ui loop-edge verification.",
  "whenToUse": "Use only to populate the observe-ui graph with both loopUntilDone shapes (a rendering fixture) — not a real task workflow.",
  "phases": [
    {
      "title": "Tighten",
      "detail": "loopUntilDone — INTRA-phase loop: body refines within one phase (gate→round1 arc inside the box)"
    },
    {
      "title": "Note",
      "detail": "a single plain agent — a non-loop seam separating the two loops"
    },
    {
      "title": "Generate",
      "detail": "cross-phase loop body, part 1: generateAndFilter (a real pattern, looped)"
    },
    {
      "title": "Rank",
      "detail": "cross-phase loop body, part 2: scoreAndRank — the loop spans Generate→Rank, back-edge outside the boxes"
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

  // loop-demo.workflow.ts
  var loop_demo_workflow_exports = {};
  __export(loop_demo_workflow_exports, {
    default: () => loop_demo_workflow_default
  });

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
  async function agentWithSchemaSalvage(rt, prompt, opts) {
    const schema = opts.schema;
    if (schema === void 0) {
      const plain = await rt.agent(prompt, opts);
      return { value: plain, warnings: [], spawns: 1, salvaged: false };
    }
    const native = await rt.agent(prompt, opts);
    if (native !== null) return { value: native, warnings: [], spawns: 1, salvaged: false };
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
        salvaged: false
      };
    }
    const preViolations = validateAgainstSchema(candidate, schema);
    if (preViolations.length === 0) {
      return {
        value: candidate,
        warnings: [`${where}: value salvaged after structured-output exhaustion (schema-less respawn)`],
        spawns: 2,
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
        salvaged: true
      };
    }
    return {
      value: null,
      warnings: [
        `${where}: salvage failed schema validation \u2014 ` + postViolations.map((v) => `${v.path}: ${v.message}`).join("; ") + (repairs.length > 0 ? ` (repairs attempted: ${repairs.join("; ")})` : "")
      ],
      spawns: 2,
      salvaged: false
    };
  }

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

  // ../packages/patterns/src/generate-and-filter.ts
  var STAGE = "generateAndFilter";
  var REJECTED = /* @__PURE__ */ Symbol("generate-and-filter:REJECTED");
  async function generateAndFilter(rt, options) {
    const { count, generatePrompt, generateSchema, generateModel, generateEffort, generateType, filterPrompt, filterModel, filterEffort, filterType, phase, cacheWarm } = options;
    if (count < 1) {
      throw new Error(
        `generateAndFilter: count must be >= 1, got ${count} \u2014 set count to a positive integer`
      );
    }
    assertAgentTypeOption(STAGE, "generateType", generateType);
    assertAgentTypeOption(STAGE, "filterType", filterType);
    let agentsSpawned = 0;
    let generateFailures = 0;
    let filterFailures = 0;
    const warnings = [];
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
      const genOpts = {
        label: `${STAGE}:generate:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...generateSchema !== void 0 ? { schema: generateSchema } : {},
        ...generateModel !== void 0 ? { model: generateModel } : {},
        ...generateEffort !== void 0 ? { effort: generateEffort } : {},
        ...generateType !== void 0 ? { agentType: generateType } : {}
      };
      const genOut = await agentWithSchemaSalvage(rt, generatePrompt(index), genOpts);
      agentsSpawned += genOut.spawns;
      for (const message of genOut.warnings) pendingWarnings.push({ itemIndex: index, stageOrder: 0, message });
      if (genOut.spawns === 2) {
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0.5,
          record: makeRecord(`${STAGE}:generate:${index}:salvage`, genOut.salvaged, {
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
          record: makeRecord(`${STAGE}:generate:${index}`, false, {
            ...generateModel !== void 0 ? { model: generateModel } : {},
            ...generateEffort !== void 0 ? { effort: generateEffort } : {}
          })
        });
        throw new Error("generate returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`${STAGE}:generate:${index}`, true, {
          ...generateModel !== void 0 ? { model: generateModel } : {},
          ...generateEffort !== void 0 ? { effort: generateEffort } : {}
        })
      });
      return candidate;
    };
    const filterStage = async (prev, _originalItem, index) => {
      const candidate = prev;
      const filterOpts = {
        schema: filterSchema,
        label: `${STAGE}:filter:${index}`,
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
      if (filterOut.spawns === 2) {
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 1.5,
          record: makeRecord(`${STAGE}:filter:${index}:salvage`, filterOut.salvaged, {
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
          record: makeRecord(`${STAGE}:filter:${index}`, false, {
            ...filterModel !== void 0 ? { model: filterModel } : {},
            ...filterEffort !== void 0 ? { effort: filterEffort } : {}
          })
        });
        throw new Error("filter returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(`${STAGE}:filter:${index}`, true, {
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
    for (const entry of pendingWarnings) warn(rt, warnings, `${STAGE}: ${entry.message}`);
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
      stage: STAGE,
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

  // ../packages/patterns/src/loop-until-done.ts
  var STAGE2 = LOOP_STAGE;
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
        const label = opts?.label != null ? `${opts.label}${LOOP_ITER_MARKER}${currentIteration}` : `${STAGE2}:iter:${currentIteration}`;
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
        trail.push(makeRecord(`${STAGE2}:tick:${tickIndex}`, tick.state !== null));
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
    emitDigest(rt, { stage: STAGE2, output: stoppedBy, counts: { iterations: iterationsDone } });
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

  // ../packages/patterns/src/score-and-rank.ts
  var STAGE3 = "scoreAndRank";
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
    const { items, dimensions, scoreModel, scoreEffort, scoreType, cutoff, maxItems, phase, cacheWarm } = options;
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
    assertAgentTypeOption(STAGE3, "scoreType", scoreType);
    let agentsSpawned = 0;
    let dropped = 0;
    const warnings = [];
    const { kept: keptItems, truncated } = applyCap(items, maxItems);
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
      const label = `${STAGE3}:score:${t.itemIndex}:${dim.name}`;
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
      if (scoreOut.spawns === 2) {
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
    for (const entry of pendingWarnings) warn(rt, warnings, `${STAGE3}: ${entry.message}`);
    if (dropped > 0) {
      warn(
        rt,
        warnings,
        `${STAGE3}: ${dropped} of ${keptItems.length} items dropped (a dimension score was null or non-finite \u2014 fail-closed, item un-rankable)`
      );
    }
    const ranked = scoredItems.map((si, idx) => ({ si, idx })).sort((a, b) => b.si.score - a.si.score || a.idx - b.idx).map((x) => x.si);
    const survivors = cutoff.type === "threshold" ? ranked.filter((s) => s.score >= cutoff.min) : ranked.slice(0, cutoff.k);
    const rejectedByCutoff = ranked.length - survivors.length;
    if (rejectedByCutoff > 0) {
      rt.log(`${STAGE3}: ${rejectedByCutoff} of ${ranked.length} ranked items cut by the ${cutoff.type} cutoff`);
    }
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `${STAGE3}: ${truncated} of ${items.length} items not scored (maxItems cap)`
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
      stage: STAGE3,
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

  // loop-demo.workflow.ts
  var loop_demo_workflow_default = defineWorkflow({
    meta: {
      name: "loop-demo",
      description: "Render demo: loopUntilDone drawn two ways \u2014 an intra-phase loop and a cross-phase loop over a real generateAndFilter\u2192scoreAndRank pipeline \u2014 for observe-ui loop-edge verification.",
      whenToUse: "Use only to populate the observe-ui graph with both loopUntilDone shapes (a rendering fixture) \u2014 not a real task workflow.",
      phases: [
        { title: "Tighten", detail: "loopUntilDone \u2014 INTRA-phase loop: body refines within one phase (gate\u2192round1 arc inside the box)" },
        { title: "Note", detail: "a single plain agent \u2014 a non-loop seam separating the two loops" },
        { title: "Generate", detail: "cross-phase loop body, part 1: generateAndFilter (a real pattern, looped)" },
        { title: "Rank", detail: "cross-phase loop body, part 2: scoreAndRank \u2014 the loop spans Generate\u2192Rank, back-edge outside the boxes" }
      ]
    },
    run: async (rt) => {
      rt.phase("Tighten");
      const intra = await loopUntilDone(rt, {
        initial: { rounds: 0 },
        maxIterations: 4,
        body: async (rtBody, state, iteration) => {
          await rtBody.agent(`Loop demo (intra), iteration ${iteration}. Reply with one short tightened line.`, { effort: "low" });
          return { state: { rounds: state.rounds + 1 }, done: iteration >= 3 };
        }
      });
      rt.phase("Note");
      await rt.agent("Loop demo. Reply with one short line noting the seam between the two loops.", { phase: "Note", effort: "low" });
      const cross = await loopUntilDone(rt, {
        initial: { ok: false },
        maxIterations: 3,
        body: async (rtBody, state, iteration) => {
          await generateAndFilter(rtBody, {
            count: 2,
            generateEffort: "low",
            filterEffort: "low",
            generatePrompt: (i) => `Loop demo (cross), round ${iteration}: generate candidate ${i} (one short line).`,
            filterPrompt: (c) => `Loop demo: keep this candidate? Answer yes or no: "${c}".`,
            phase: "Generate"
          });
          await scoreAndRank(rtBody, {
            items: ["candidate A", "candidate B"],
            scoreModel: "haiku",
            scoreEffort: "low",
            dimensions: [
              { name: "impact", prompt: (item) => `Loop demo: score the impact of "${item}" from 1 to 5. Return {"score":N,"reason":"..."}.` }
            ],
            cutoff: { type: "topK", k: 1 },
            phase: "Rank"
          });
          return { state: { ok: true }, done: iteration >= 2 };
        }
      });
      return { intra: intra.value, cross: cross.value, envelope: { trail: collectTrail(intra, cross) } };
    }
  });
  return __toCommonJS(loop_demo_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

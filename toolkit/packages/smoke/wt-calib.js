export const meta = {
  "name": "wt-calib",
  "description": "budgetFloor calibration probe: generateAndFilter(count, single tier) + budget.spent().",
  "phases": [
    {
      "title": "Calibrate"
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

  // wt-calib.workflow.ts
  var wt_calib_workflow_exports = {};
  __export(wt_calib_workflow_exports, {
    default: () => wt_calib_workflow_default
  });

  // ../build/src/define-workflow.ts
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

  // ../patterns/src/envelope.ts
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

  // ../patterns/src/generate-and-filter.ts
  var REJECTED = Symbol("generate-and-filter:REJECTED");
  async function generateAndFilter(rt, options) {
    const { count, generatePrompt, generateSchema, generateModel, filterPrompt, filterModel, phase } = options;
    if (count < 1) {
      throw new Error(
        `generateAndFilter: count must be >= 1, got ${count} \u2014 set count to a positive integer`
      );
    }
    let agentsSpawned = 0;
    let generateFailures = 0;
    let filterFailures = 0;
    const warnings = [];
    const pendingTrail = [];
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
        label: `generateAndFilter:generate:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...generateSchema !== void 0 ? { schema: generateSchema } : {},
        ...generateModel !== void 0 ? { model: generateModel } : {}
      };
      agentsSpawned++;
      const candidate = await rt.agent(generatePrompt(index), genOpts);
      if (candidate === null) {
        generateFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0,
          record: makeRecord(`generateAndFilter:generate:${index}`, false, generateModel !== void 0 ? { model: generateModel } : void 0)
        });
        throw new Error("generate returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`generateAndFilter:generate:${index}`, true, generateModel !== void 0 ? { model: generateModel } : void 0)
      });
      return candidate;
    };
    const filterStage = async (prev, _originalItem, index) => {
      const candidate = prev;
      const filterOpts = {
        schema: filterSchema,
        label: `generateAndFilter:filter:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...filterModel !== void 0 ? { model: filterModel } : {}
      };
      agentsSpawned++;
      const verdict = await rt.agent(
        filterPrompt(candidate),
        filterOpts
      );
      if (verdict === null) {
        filterFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 1,
          record: makeRecord(`generateAndFilter:filter:${index}`, false, filterModel !== void 0 ? { model: filterModel } : void 0)
        });
        throw new Error("filter returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(`generateAndFilter:filter:${index}`, true, {
          ...filterModel !== void 0 ? { model: filterModel } : {},
          decision: verdict.pass ? "pass" : "fail"
        })
      });
      if (!verdict.pass) {
        return REJECTED;
      }
      return candidate;
    };
    const indices = Array.from({ length: count }, (_, i) => i);
    const rawResults = await rt.pipeline(indices, generateStage, filterStage);
    const value = [];
    for (const r of rawResults) {
      if (r !== null && r !== REJECTED) {
        value.push(r);
      }
    }
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
    return { value, stats, warnings, trail };
  }

  // wt-calib.workflow.ts
  var TOKEN_SCHEMA = {
    type: "object",
    properties: { token: { type: "string" } },
    required: ["token"],
    additionalProperties: false
  };
  function parseCalibInput(raw) {
    const obj = raw !== null && typeof raw === "object" ? raw : null;
    const candidate = typeof raw === "number" ? raw : obj !== null && typeof obj["count"] === "number" ? obj["count"] : obj !== null && typeof obj["claims"] === "number" ? obj["claims"] : 2;
    const count = Number.isFinite(candidate) && candidate >= 1 ? Math.floor(candidate) : 2;
    return { count };
  }
  var wt_calib_workflow_default = defineWorkflow({
    meta: {
      name: "wt-calib",
      description: "budgetFloor calibration probe: generateAndFilter(count, single tier) + budget.spent().",
      phases: [{ title: "Calibrate" }]
    },
    parseInput: parseCalibInput,
    run: async (rt, input) => {
      const envelope = await generateAndFilter(rt, {
        count: input.count,
        phase: "Calibrate",
        generateModel: "haiku",
        filterModel: "haiku",
        generatePrompt: (index) => `Return exactly this JSON object and nothing else: {"token":"calib-${index}"}`,
        generateSchema: TOKEN_SCHEMA,
        filterPrompt: (candidate) => `Reply pass=true if this object has a non-empty "token" string, else pass=false. Object: ${JSON.stringify(candidate)}`
      });
      return { envelope, budgetSpent: rt.budget.spent(), count: input.count, model: "haiku" };
    }
  });
  return __toCommonJS(wt_calib_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

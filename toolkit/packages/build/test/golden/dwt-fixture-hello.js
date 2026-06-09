export const meta = {
  "name": "dwt-fixture-hello",
  "description": "Minimal fixture workflow for @dwt/build Batch B tests",
  "phases": [
    {
      "title": "Run"
    }
  ]
}
var __dwt = (() => {
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

  // hello.workflow.ts
  var hello_workflow_exports = {};
  __export(hello_workflow_exports, {
    default: () => hello_workflow_default
  });

  // ../../src/define-workflow.ts
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

  // hello.workflow.ts
  var hello_workflow_default = defineWorkflow({
    meta: {
      name: "dwt-fixture-hello",
      description: "Minimal fixture workflow for @dwt/build Batch B tests",
      phases: [{ title: "Run" }]
    },
    parseInput: (raw) => {
      if (typeof raw === "string") return raw;
      if (raw === void 0 || raw === null) return "world";
      return String(raw);
    },
    run: async (rt, input) => {
      rt.phase("Run");
      const r = await rt.agent("say hello to " + input, { label: "hello" });
      rt.log("agent said: " + String(r));
      return { greeting: r };
    }
  });
  return __toCommonJS(hello_workflow_exports);
})();

// --- dwt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __dwt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

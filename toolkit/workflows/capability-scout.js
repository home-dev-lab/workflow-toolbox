export const meta = {
  "name": "capability-scout",
  "description": "Reference example for the per-role capability registry: one code-intelligence agent whose provider is resolved at launch from a hand-written sidecar — runs unchanged whether the machine resolves a symbolic code-intelligence provider or degrades to grep/glob.",
  "whenToUse": "Study or e2e the capability sidecar/resolver path. Launch it with wt-observe launch capability-scout, WT_CAPABILITY_REGISTRY set (resolved) or unset (degraded). Not production work — the locate task is a fixture.",
  "phases": [
    {
      "title": "Scout",
      "detail": "one code-scout agent locates a symbol with whatever code-intelligence tooling launch resolved",
      "model": "haiku"
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

  // capability-scout.workflow.ts
  var capability_scout_workflow_exports = {};
  __export(capability_scout_workflow_exports, {
    default: () => capability_scout_workflow_default
  });

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

  // capability-scout.workflow.ts
  var capability_scout_workflow_default = defineWorkflow({
    meta: {
      name: "capability-scout",
      description: "Reference example for the per-role capability registry: one code-intelligence agent whose provider is resolved at launch from a hand-written sidecar \u2014 runs unchanged whether the machine resolves a symbolic code-intelligence provider or degrades to grep/glob.",
      whenToUse: "Study or e2e the capability sidecar/resolver path. Launch it with wt-observe launch capability-scout, WT_CAPABILITY_REGISTRY set (resolved) or unset (degraded). Not production work \u2014 the locate task is a fixture.",
      phases: [
        {
          title: "Scout",
          detail: "one code-scout agent locates a symbol with whatever code-intelligence tooling launch resolved",
          model: "haiku"
        }
      ]
    },
    run: async (rt) => {
      rt.phase("Scout");
      const scout = await rt.agent(
        [
          "This run demonstrates capability resolution for a code-intelligence role.",
          "Using ONLY the code-intelligence tooling named in your Capability resolution note,",
          "locate the definition of ANY ONE exported function, class, or type under the current",
          "working directory and report it on its own line as: LOCATED <relative-path>:<1-based-line>.",
          'Then, on a line starting "SKILLS=", report how many skills you currently have available',
          "as a bare integer. Finally, end your reply with exactly: SCOUT-DONE. Do not modify any files."
        ].join(" "),
        { agentType: "code-scout", label: "scout:locate", phase: "Scout", model: "haiku", effort: "low" }
      );
      return {
        marker: "CAPABILITY_SCOUT_OK",
        envelope: { trail: [makeRecord("scout:locate", scout !== null, { model: "haiku", effort: "low" })] },
        scout
      };
    }
  });
  return __toCommonJS(capability_scout_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

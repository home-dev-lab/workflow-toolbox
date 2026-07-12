export const meta = {
  "name": "showcase-deep",
  "description": "demo-showcase-v2 pipeline L3 deep stage: generateAndFilter + chunkedAnalysis + adversarialVerification + loopUntilDone (inner loop). Every agent honors args.perAgent, defaulting to haiku + low (passed explicitly to adversarialVerification). A render fixture, not real work.",
  "whenToUse": "Runs as the single stage of the deepest (L3) nested pipeline of demo-showcase-v2 (or standalone as a render fixture). Not a real task workflow.",
  "phases": [
    {
      "title": "Generate",
      "detail": "generateAndFilter — candidate taglines, filtered"
    },
    {
      "title": "Chunk",
      "detail": "chunkedAnalysis — map-reduce a feedback log into clusters"
    },
    {
      "title": "Verify",
      "detail": "adversarialVerification — refute-first verifier fan"
    },
    {
      "title": "Refine-Inner",
      "detail": "loopUntilDone INNER — intra-phase polish loop"
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

  // showcase-deep.workflow.ts
  var showcase_deep_workflow_exports = {};
  __export(showcase_deep_workflow_exports, {
    default: () => showcase_deep_workflow_default
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
  var EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  var EFFORT_ROLE_VALUES = ["low", "medium", "high", "xhigh", "max", "auto"];
  var PER_AGENT_KEYS = ["model", "effort", "agentType", "isolation", "stallMs"];
  function isRecord(v) {
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
    if (!isRecord(raw)) throw new Error(`parseConfig: perAgent must be an object, got ${raw === null ? "null" : typeof raw}`);
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
    if (!isRecord(raw)) throw new Error(`parseConfig: ${where} must be an object, got ${raw === null ? "null" : typeof raw}`);
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = asNonEmptyString(v, `${where}.${k}`);
    return out;
  }
  function parseEffortMap(raw) {
    if (!isRecord(raw)) throw new Error(`parseConfig: effort must be an object, got ${raw === null ? "null" : typeof raw}`);
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
    if (!isRecord(raw)) throw new Error(`parseConfig: ${where} must be an object, got ${raw === null ? "null" : typeof raw}`);
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
    if (!isRecord(raw)) {
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
      agentsSpawned++;
      const candidate = await rt.agent(generatePrompt(index), genOpts);
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

  // ../packages/patterns/src/adversarial-verification.ts
  var STAGE2 = "adversarialVerification";
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
      model,
      effort,
      phase,
      maxVerifyClaims,
      verifierType,
      cacheWarm
    } = options;
    const refuteThreshold = refuteThresholdOpt ?? 2;
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
      trail.push(await runCacheWarmup(rt, warnings, `${STAGE2}:warm`, STAGE2, {
        ...phase !== void 0 ? { phase } : {},
        model: effectiveModel,
        ...effort !== void 0 ? { effort } : {},
        ...verifierType !== void 0 ? { agentType: verifierType } : {}
      }));
    }
    const trailByClaim = [];
    const verifiedKept = await Promise.all(
      keptClaims.map(async (claim, claimIndex) => {
        const claimVotes = perClaimVotes[claimIndex] ?? votesOpt;
        const voteThunks = Array.from({ length: claimVotes }, (_, voteIndex) => {
          return async () => {
            const lens = lenses !== void 0 ? lenses[voteIndex] : void 0;
            const prompt = buildVerifierPrompt(claim, lens);
            const opts = {
              schema: VERIFIER_SCHEMA,
              label: `${STAGE2}:verify:${claimIndex}:${voteIndex}`,
              ...phase !== void 0 ? { phase } : {},
              model: effectiveModel,
              ...effort !== void 0 ? { effort } : {},
              ...verifierType !== void 0 ? { agentType: verifierType } : {}
            };
            agentsSpawned++;
            return rt.agent(prompt, opts);
          };
        });
        const rawVotes = await rt.parallel(voteThunks);
        const votes = rawVotes.map(
          (v) => v
        );
        const claimRecords = [];
        for (let voteIndex = 0; voteIndex < votes.length; voteIndex++) {
          const vote = votes[voteIndex] ?? null;
          claimRecords.push(makeRecord(
            `${STAGE2}:verify:${claimIndex}:${voteIndex}`,
            vote !== null,
            {
              model: effectiveModel,
              ...effort !== void 0 ? { effort } : {},
              ...vote !== null ? { decision: vote.verdict } : {}
            }
          ));
        }
        trailByClaim[claimIndex] = claimRecords;
        const nonNull = votes.filter((v) => v !== null);
        const effectiveThreshold = Math.min(refuteThreshold, claimVotes);
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
        return { claim, verdict, votes };
      })
    );
    trail.push(...trailByClaim.flat());
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
    emitDigest(rt, { stage: STAGE2, ...phase !== void 0 ? { phase } : {}, counts });
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/loop-until-done.ts
  var STAGE3 = LOOP_STAGE;
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
        const label = opts?.label != null ? `${opts.label}${LOOP_ITER_MARKER}${currentIteration}` : `${STAGE3}:iter:${currentIteration}`;
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
        trail.push(makeRecord(`${STAGE3}:tick:${tickIndex}`, tick.state !== null));
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
    emitDigest(rt, { stage: STAGE3, output: stoppedBy, counts: { iterations: iterationsDone } });
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

  // ../packages/patterns/src/chunked-analysis.ts
  var STAGE4 = "chunkedAnalysis";
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
      cacheWarm
    } = options;
    assertAgentTypeOption(STAGE4, "analyzeType", analyzeType);
    assertAgentTypeOption(STAGE4, "synthesizeType", synthesizeType);
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
    if (truncated > 0) {
      warn(
        rt,
        warnings,
        `chunkedAnalysis: ${truncated} of ${chunks.length} chunks truncated by maxChunks=${maxChunks ?? "?"}`
      );
    }
    const keptArray = keptChunks;
    const analyzeThunks = keptArray.map((chunk, i) => async () => {
      const opts = {
        label: `${STAGE4}:chunk:${i}`,
        ...phase !== void 0 ? { phase } : {},
        ...analyzeSchema !== void 0 ? { schema: analyzeSchema } : {},
        ...analyzeModel !== void 0 ? { model: analyzeModel } : {},
        ...analyzeEffort !== void 0 ? { effort: analyzeEffort } : {},
        ...analyzeType !== void 0 ? { agentType: analyzeType } : {}
      };
      agentsSpawned++;
      return rt.agent(analyzePrompt(chunk, i, total), opts);
    });
    const analyzeResults = await parallelWithCacheWarm(rt, analyzeThunks, cacheWarm ?? true);
    const chunkResults = [];
    let dropped = 0;
    for (let i = 0; i < analyzeResults.length; i++) {
      const r = analyzeResults[i];
      trail.push(makeRecord(`${STAGE4}:chunk:${i}`, r !== null, {
        ...analyzeModel !== void 0 ? { model: analyzeModel } : {},
        ...analyzeEffort !== void 0 ? { effort: analyzeEffort } : {}
      }));
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
      const synthOpts = {
        label: `${STAGE4}:synthesize`,
        ...phase !== void 0 ? { phase } : {},
        ...synthesizeSchema !== void 0 ? { schema: synthesizeSchema } : {},
        ...synthesizeModel !== void 0 ? { model: synthesizeModel } : {},
        ...synthesizeEffort !== void 0 ? { effort: synthesizeEffort } : {},
        ...synthesizeType !== void 0 ? { agentType: synthesizeType } : {}
      };
      agentsSpawned++;
      const synthesis = await rt.agent(synthesizePrompt(chunkResults), synthOpts);
      trail.push(makeRecord(`${STAGE4}:synthesize`, synthesis !== null, {
        ...synthesizeModel !== void 0 ? { model: synthesizeModel } : {},
        ...synthesizeEffort !== void 0 ? { effort: synthesizeEffort } : {}
      }));
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
      stage: STAGE4,
      ...phase !== void 0 ? { phase } : {},
      output: value === null ? "synthesis: none" : `synthesis from ${chunkResults.length}/${chunks.length} chunks`,
      counts: { chunks: chunks.length, analyzed: chunkResults.length, dropped, truncated }
    });
    return { value, stats, warnings, trail, chunkResults };
  }

  // showcase-deep.workflow.ts
  var GUARD = " IMPORTANT: render demo \u2014 reply with a short line of TEXT ONLY. Do NOT use any tools, and do NOT create, modify, or delete any files.";
  function parseInput(raw) {
    const obj = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return { perAgent: parseConfig(obj).perAgent ?? null };
  }
  async function run(rt0, input) {
    const model = input.perAgent?.model ?? "haiku";
    const rt = withAgentDefaults(rt0, { effort: "low", ...input.perAgent ?? {}, model });
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
      model,
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
      stage: "deep",
      clusters: chunk.value,
      envelope: { trail: collectTrail(gen, chunk, verify, inner) }
    };
  }
  var showcase_deep_workflow_default = defineWorkflow({
    meta: {
      name: "showcase-deep",
      description: "demo-showcase-v2 pipeline L3 deep stage: generateAndFilter + chunkedAnalysis + adversarialVerification + loopUntilDone (inner loop). Every agent honors args.perAgent, defaulting to haiku + low (passed explicitly to adversarialVerification). A render fixture, not real work.",
      whenToUse: "Runs as the single stage of the deepest (L3) nested pipeline of demo-showcase-v2 (or standalone as a render fixture). Not a real task workflow.",
      phases: [
        { title: "Generate", detail: "generateAndFilter \u2014 candidate taglines, filtered" },
        { title: "Chunk", detail: "chunkedAnalysis \u2014 map-reduce a feedback log into clusters" },
        { title: "Verify", detail: "adversarialVerification \u2014 refute-first verifier fan" },
        { title: "Refine-Inner", detail: "loopUntilDone INNER \u2014 intra-phase polish loop" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(showcase_deep_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

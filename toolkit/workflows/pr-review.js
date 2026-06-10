export const meta = {
  "name": "pr-review",
  "description": "Multi-lens code review of a change set: classifies the change, spawns specialized reviewers, adversarially verifies findings, and synthesizes a verdict.",
  "whenToUse": "Use when you need a structured, adversarially-verified code review of a git ref range or change description.",
  "phases": [
    {
      "title": "Route",
      "detail": "Classify the change and produce a targeted summary"
    },
    {
      "title": "Review",
      "detail": "Spawn specialized reviewer agents per lens"
    },
    {
      "title": "Verify",
      "detail": "Adversarially verify each finding (fresh-evidence check)"
    },
    {
      "title": "Synthesize",
      "detail": "Produce an overall verdict from verified findings"
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

  // pr-review.workflow.ts
  var pr_review_workflow_exports = {};
  __export(pr_review_workflow_exports, {
    default: () => pr_review_workflow_default
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

  // ../packages/patterns/src/classify-and-act.ts
  async function classifyAndAct(rt, options) {
    const { items, categories, classifyPrompt, actions, classifyModel, phase, maxItems } = options;
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
    const { kept, truncated } = applyCap(items, maxItems);
    let agentsSpawned = 0;
    let classifyFailures = 0;
    let actionFailures = 0;
    const warnings = [];
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
      const classifyOpts = {
        schema: controlSchema,
        label: `classifyAndAct:classify:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...classifyModel !== void 0 ? { model: classifyModel } : {}
      };
      agentsSpawned++;
      const classified = await rt.agent(classifyPrompt(item), classifyOpts);
      if (classified === null) {
        classifyFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0,
          record: makeRecord(`classifyAndAct:classify:${index}`, false, classifyModel !== void 0 ? { model: classifyModel } : void 0)
        });
        throw new Error("classify returned null");
      }
      if (!(classified.category in actions)) {
        classifyFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 0,
          record: makeRecord(`classifyAndAct:classify:${index}`, false, classifyModel !== void 0 ? { model: classifyModel } : void 0)
        });
        throw new Error(`classify returned unknown category "${classified.category}"`);
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`classifyAndAct:classify:${index}`, true, {
          ...classifyModel !== void 0 ? { model: classifyModel } : {},
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
      const actOpts = {
        label: `classifyAndAct:act:${category}:${index}`,
        ...phase !== void 0 ? { phase } : {},
        ...spec.schema !== void 0 ? { schema: spec.schema } : {},
        ...spec.model !== void 0 ? { model: spec.model } : {}
      };
      agentsSpawned++;
      const result = await rt.agent(spec.prompt(item), actOpts);
      if (result === null) {
        actionFailures++;
        pendingTrail.push({
          itemIndex: index,
          stageOrder: 1,
          record: makeRecord(`classifyAndAct:act:${category}:${index}`, false, spec.model !== void 0 ? { model: spec.model } : void 0)
        });
        throw new Error("act returned null");
      }
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(`classifyAndAct:act:${category}:${index}`, true, spec.model !== void 0 ? { model: spec.model } : void 0)
      });
      return { item, category, result };
    };
    const rawResults = await rt.pipeline(kept, classifyStage, actStage);
    const value = rawResults.filter(
      (r) => r !== null
    );
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
    return { value, stats, warnings, trail };
  }

  // ../packages/patterns/src/generate-and-filter.ts
  var REJECTED = Symbol("generate-and-filter:REJECTED");

  // ../packages/runtime/src/constants.ts
  var BEST_MODEL = "fable";

  // ../packages/patterns/src/adversarial-verification.ts
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
      model,
      phase,
      maxVerifyClaims
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
    if (refuteThreshold > votesOpt) {
      throw new Error(
        `adversarialVerification: refuteThreshold (${refuteThreshold}) must not be > votes (${votesOpt})`
      );
    }
    if (lenses !== void 0 && lenses.length !== votesOpt) {
      throw new Error(
        `adversarialVerification: lenses.length (${lenses.length}) must equal votes (${votesOpt}) \u2014 each lens corresponds to one vote`
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
    const trailByClaim = [];
    const verifiedKept = await Promise.all(
      keptClaims.map(async (claim, claimIndex) => {
        const voteThunks = Array.from({ length: votesOpt }, (_, voteIndex) => {
          return async () => {
            const lens = lenses !== void 0 ? lenses[voteIndex] : void 0;
            const prompt = buildVerifierPrompt(claim, lens);
            const opts = {
              schema: VERIFIER_SCHEMA,
              label: `adversarialVerification:verify:${claimIndex}:${voteIndex}`,
              ...phase !== void 0 ? { phase } : {},
              model: effectiveModel
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
            `adversarialVerification:verify:${claimIndex}:${voteIndex}`,
            vote !== null,
            {
              model: effectiveModel,
              ...vote !== null ? { decision: vote.verdict } : {}
            }
          ));
        }
        trailByClaim[claimIndex] = claimRecords;
        const nonNull = votes.filter((v) => v !== null);
        let verdict;
        if (nonNull.length === 0) {
          verdict = "unverifiable";
        } else if (nonNull.filter((v) => v.verdict === "refuted").length >= refuteThreshold) {
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
      if (nullsInClaim === votesOpt) {
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
    return { value, stats, warnings, trail };
  }

  // pr-review.workflow.ts
  var CHANGE_SUMMARY_SCHEMA = {
    type: "object",
    properties: {
      summary: { type: "string" },
      riskAreas: { type: "array", items: { type: "string" } }
    },
    required: ["summary", "riskAreas"],
    additionalProperties: false
  };
  var FINDINGS_SCHEMA = {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            file: { type: "string" },
            severity: { type: "string", enum: ["high", "medium", "low"] },
            detail: { type: "string" }
          },
          required: ["title", "file", "severity", "detail"],
          additionalProperties: false
        }
      }
    },
    required: ["findings"],
    additionalProperties: false
  };
  var SYNTHESIS_SCHEMA = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "request-changes"] },
      summary: { type: "string" }
    },
    required: ["verdict", "summary"],
    additionalProperties: false
  };
  var REVIEWER_LENSES = {
    bugfix: ["root-cause", "regression-risk", "test-coverage"],
    feature: ["correctness", "security", "api-design"],
    refactor: ["behavioral-equivalence", "test-coverage", "readability"],
    config: ["correctness", "security", "blast-radius"],
    docs: ["accuracy", "completeness", "clarity"]
  };
  var DEFAULT_LENSES = ["correctness", "security", "test-coverage"];
  function parseInput(raw) {
    if (typeof raw === "string") {
      if (raw.trim().length === 0) {
        throw new Error(
          'pr-review: target must be a non-empty string \u2014 provide a git ref range or change description (e.g. "HEAD~3..HEAD")'
        );
      }
      return { target: raw };
    }
    if (raw === null || typeof raw !== "object") {
      throw new Error(
        'pr-review: input must be an object with a "target" field, or a bare non-empty string \u2014 received: ' + typeof raw
      );
    }
    const obj = raw;
    if (!("target" in obj) || obj["target"] === void 0) {
      throw new Error(
        'pr-review: missing required field "target" \u2014 provide a git ref range or change description'
      );
    }
    if (typeof obj["target"] !== "string" || obj["target"].trim().length === 0) {
      throw new Error(
        'pr-review: "target" must be a non-empty string \u2014 provide a git ref range or change description (e.g. "HEAD~3..HEAD")'
      );
    }
    return { target: obj["target"] };
  }
  async function run(rt, input) {
    const warnings = [];
    let reviewersSpawned = 0;
    let dropped = 0;
    rt.phase("Route");
    const routeResult = await classifyAndAct(rt, {
      items: [input.target],
      categories: ["feature", "bugfix", "refactor", "config", "docs"],
      classifyPrompt: (target) => `Inspect this change and classify it into exactly one category: feature, bugfix, refactor, config, or docs.
Change target: ${target}
Return { "category": "<one of the five categories>" }`,
      actions: {
        feature: {
          schema: CHANGE_SUMMARY_SCHEMA,
          prompt: (target) => `You are reviewing a FEATURE change. Inspect the actual change (${target}) and produce a focused summary.
Return { "summary": "<what the feature does>", "riskAreas": ["<risk1>", ...] }`
        },
        bugfix: {
          schema: CHANGE_SUMMARY_SCHEMA,
          prompt: (target) => `You are reviewing a BUGFIX change. Inspect the actual change (${target}) \u2014 re-derive from first principles.
Return { "summary": "<what was broken and how it is fixed>", "riskAreas": ["<risk1>", ...] }`
        },
        refactor: {
          schema: CHANGE_SUMMARY_SCHEMA,
          prompt: (target) => `You are reviewing a REFACTOR change. Inspect the actual change (${target}).
Return { "summary": "<what was refactored and why>", "riskAreas": ["<risk1>", ...] }`
        },
        config: {
          schema: CHANGE_SUMMARY_SCHEMA,
          prompt: (target) => `You are reviewing a CONFIG change. Inspect the actual change (${target}).
Return { "summary": "<what config changed and its effect>", "riskAreas": ["<risk1>", ...] }`
        },
        docs: {
          schema: CHANGE_SUMMARY_SCHEMA,
          prompt: (target) => `You are reviewing a DOCS change. Inspect the actual change (${target}).
Return { "summary": "<what documentation was updated>", "riskAreas": ["<risk1>", ...] }`
        }
      },
      phase: "Route"
    });
    for (const w of routeResult.warnings) warnings.push(w);
    const routedItem = routeResult.value[0];
    if (routedItem === void 0) {
      throw new Error(
        "pr-review: classification failed \u2014 no category could be assigned to the change. Warnings: " + warnings.join("; ")
      );
    }
    const category = routedItem.category;
    const changeSummary = routedItem.result;
    const lenses = REVIEWER_LENSES[category] ?? DEFAULT_LENSES;
    const reviewStage = async (_prev, originalItem) => {
      const lens = originalItem;
      reviewersSpawned++;
      const result = await rt.agent(
        `You are a specialized code reviewer examining the "${lens}" aspect of this change.
Change target: ${input.target}
Change summary: ${changeSummary.summary}
Risk areas: ${changeSummary.riskAreas.join(", ")}
Read the ACTUAL change (you have repo access). Do NOT trust the summary above \u2014 re-derive findings from first principles.
Focus ONLY on the "${lens}" lens. Return your findings.
Each finding: { title, file, severity ('high'|'medium'|'low'), detail }`,
        {
          schema: FINDINGS_SCHEMA,
          label: `pr-review:reviewer:${lens}`,
          phase: "Review"
        }
      );
      return result;
    };
    const verifyStage = async (prev, originalItem) => {
      const lens = originalItem;
      const reviewOutput = prev;
      if (reviewOutput === null) {
        dropped++;
        return null;
      }
      const findings = reviewOutput.findings;
      if (findings.length === 0) {
        return [];
      }
      const verifyResult = await adversarialVerification(rt, {
        claims: findings,
        renderClaim: (finding) => `Reviewer (lens: ${lens}) reported: "${finding.title}" in ${finding.file}
Detail: ${finding.detail}
Severity: ${finding.severity}

IMPORTANT: Do NOT trust the reviewer summary above. Open the actual diff at ${input.target} and re-derive whether this finding is genuine from first principles.`,
        lenses: ["correctness", "security", "does-it-reproduce"],
        votes: 3,
        maxVerifyClaims: 5,
        phase: "Verify"
      });
      for (const w of verifyResult.warnings) warnings.push(w);
      return verifyResult.value;
    };
    const pipelineResults = await rt.pipeline(
      lenses,
      reviewStage,
      verifyStage
    );
    const allVerifiedFindings = [];
    for (const item of pipelineResults) {
      if (item === null) {
        continue;
      }
      const verifiedArray = item;
      for (const vc of verifiedArray) {
        allVerifiedFindings.push(vc);
      }
    }
    const findingsRaw = allVerifiedFindings.length;
    const findingsRefuted = allVerifiedFindings.filter((vc) => vc.verdict === "refuted").length;
    const findingsVerified = findingsRaw - findingsRefuted;
    const outputFindings = allVerifiedFindings.map((vc) => ({
      title: vc.claim.title,
      file: vc.claim.file,
      severity: vc.claim.severity,
      detail: vc.claim.detail,
      verdict: vc.verdict
    }));
    const synthesisFindings = allVerifiedFindings.filter((vc) => vc.verdict !== "refuted").map((vc) => ({
      title: vc.claim.title,
      file: vc.claim.file,
      severity: vc.claim.severity,
      detail: vc.claim.detail,
      verdict: vc.verdict
    }));
    rt.phase("Synthesize");
    const synthesisPrompt = `You are synthesizing a code review for the change: ${input.target}
Category: ${category}
Change summary: ${changeSummary.summary}

Verified findings (non-refuted):
${JSON.stringify(synthesisFindings, null, 2)}

Produce an overall verdict: "approve" if no high-severity confirmed findings remain, "request-changes" otherwise. Include a concise summary.
Return { "verdict": "approve"|"request-changes", "summary": "<concise summary>" }`;
    const synthesisAgent = await rt.agent(synthesisPrompt, {
      schema: SYNTHESIS_SCHEMA,
      label: "pr-review:synthesize",
      phase: "Synthesize"
    });
    if (synthesisAgent === null) {
      throw new Error(
        "pr-review: synthesis agent failed \u2014 unable to produce a verdict. Use resumeFromRunId to retry from the Synthesize phase (reviewed findings are cached)."
      );
    }
    return {
      category,
      verdict: synthesisAgent.verdict,
      summary: synthesisAgent.summary,
      findings: outputFindings,
      stats: {
        reviewersSpawned,
        findingsRaw,
        findingsVerified,
        findingsRefuted,
        dropped
      },
      warnings
    };
  }
  var pr_review_workflow_default = defineWorkflow({
    meta: {
      name: "pr-review",
      description: "Multi-lens code review of a change set: classifies the change, spawns specialized reviewers, adversarially verifies findings, and synthesizes a verdict.",
      whenToUse: "Use when you need a structured, adversarially-verified code review of a git ref range or change description.",
      phases: [
        { title: "Route", detail: "Classify the change and produce a targeted summary" },
        { title: "Review", detail: "Spawn specialized reviewer agents per lens" },
        { title: "Verify", detail: "Adversarially verify each finding (fresh-evidence check)" },
        { title: "Synthesize", detail: "Produce an overall verdict from verified findings" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(pr_review_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

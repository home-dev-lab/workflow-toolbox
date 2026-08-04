export const meta = {
  "name": "pr-review-reduced-dag",
  "description": "Reduced PR review as a DAG: deterministic classification from input, three independent review lenses, one shared verifier, deterministic synthesis.",
  "whenToUse": "Use when you want the reduced PR-review budgeted shape as a runnable DAG. Pass both target and category: this reduced form spends no agent on classification and no agent on synthesis.",
  "phases": [
    {
      "title": "Classify",
      "detail": "Deterministic category selection from workflow input"
    },
    {
      "title": "Review",
      "detail": "Three reduced lenses run in one DAG wave",
      "model": "haiku"
    },
    {
      "title": "Verify",
      "detail": "One shared verifier depends on all three review lenses",
      "model": "haiku"
    },
    {
      "title": "Synthesize",
      "detail": "Deterministic verdict and summary in script logic"
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

  // pr-review-reduced-dag.workflow.ts
  var pr_review_reduced_dag_workflow_exports = {};
  __export(pr_review_reduced_dag_workflow_exports, {
    default: () => pr_review_reduced_dag_workflow_default
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

  // ../packages/patterns/src/reduced-lenses.ts
  function reducedLenses(lenses, keep = 3) {
    if (keep < 0) {
      throw new Error(
        `reducedLenses: keep must not be negative (received ${keep}) \u2014 a negative slice bound silently drops from the end instead of keeping a prefix`
      );
    }
    return lenses.length <= keep ? lenses : lenses.slice(0, keep);
  }

  // ../packages/patterns/src/provenance-gate.ts
  var SCANNER_RECENCY_MS = 30 * 60 * 1e3;

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

  // ../packages/patterns/src/dag-execute.ts
  var STAGE = "dagExecute";
  async function dagExecute(rt, options) {
    const { nodes, run: run2, phase, stageKey } = options;
    if (nodes.length === 0) {
      throw new Error("dagExecute: nodes must not be empty \u2014 provide at least one DAG node");
    }
    const idToIndex = /* @__PURE__ */ new Map();
    for (const [index, node] of nodes.entries()) {
      if (idToIndex.has(node.id)) {
        throw new Error(
          `dagExecute: duplicate node id ${JSON.stringify(node.id)} at index ${index} \u2014 each id must appear exactly once`
        );
      }
      idToIndex.set(node.id, index);
    }
    for (const node of nodes) {
      for (const dependencyId of node.dependsOn) {
        if (!idToIndex.has(dependencyId)) {
          throw new Error(
            `dagExecute: node ${JSON.stringify(node.id)} depends on unknown id ${JSON.stringify(dependencyId)} \u2014 every dependsOn reference must name a node present in options.nodes`
          );
        }
      }
    }
    const waves = computeWaveLevels(nodes);
    const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE, stageKey);
    const warnings = [];
    if (stageKeyWarning !== void 0) warn(rt, warnings, stageKeyWarning);
    const stg = stageBuilder(STAGE, salt);
    const results = nodes.map((node) => ({
      node,
      status: "skipped",
      value: null
    }));
    const statusById = /* @__PURE__ */ new Map();
    const trail = [];
    let agentsSpawned = 0;
    for (const wave of waves) {
      const runnable = wave.filter(
        (node) => node.dependsOn.every((dependencyId) => statusById.get(dependencyId) === "succeeded")
      );
      for (const node of wave) {
        if (runnable.includes(node)) continue;
        const index = idToIndex.get(node.id);
        results[index] = { node, status: "skipped", value: null };
        statusById.set(node.id, "skipped");
        warn(
          rt,
          warnings,
          `dagExecute: skipped node ${JSON.stringify(node.id)} because at least one dependency did not succeed`
        );
      }
      const waveResults = await rt.parallel(runnable.map((node) => async () => run2(node, rt)));
      for (const [indexInWave, node] of runnable.entries()) {
        const value = waveResults[indexInWave] ?? null;
        const ok = value !== null;
        const nodeIndex = idToIndex.get(node.id);
        results[nodeIndex] = {
          node,
          status: ok ? "succeeded" : "failed",
          value
        };
        statusById.set(node.id, ok ? "succeeded" : "failed");
        trail.push(makeRecord(stg(`run:${nodeIndex}`), ok, { decision: node.id }));
        agentsSpawned++;
        if (!ok) {
          warn(rt, warnings, `dagExecute: node ${JSON.stringify(node.id)} failed (returned null or threw)`);
        }
      }
    }
    const succeeded = results.filter((result) => result.status === "succeeded").length;
    const dropped = results.filter((result) => result.status !== "succeeded").length;
    const stats = {
      itemsIn: nodes.length,
      itemsOut: succeeded,
      agentsSpawned,
      dropped,
      truncated: 0
    };
    emitDigest(rt, {
      stage: STAGE,
      ...phase !== void 0 ? { phase } : {},
      output: `waves=${waves.length}`,
      counts: { in: nodes.length, out: succeeded, dropped }
    });
    return { value: { results, waves: waves.length }, stats, warnings, trail };
  }
  function computeWaveLevels(nodes) {
    const ordered = topologicalOrder(nodes);
    const levelById = /* @__PURE__ */ new Map();
    const waves = [];
    for (const node of ordered) {
      const level = node.dependsOn.length === 0 ? 0 : Math.max(...node.dependsOn.map((dependencyId) => levelById.get(dependencyId))) + 1;
      levelById.set(node.id, level);
      (waves[level] ??= []).push(node);
    }
    return waves;
  }
  function topologicalOrder(nodes) {
    const done = /* @__PURE__ */ new Set();
    const ordered = [];
    const remaining = [...nodes];
    while (remaining.length > 0) {
      const readyIndex = remaining.findIndex((node2) => node2.dependsOn.every((dependencyId) => done.has(dependencyId)));
      if (readyIndex === -1) {
        const cycleIds = remaining.map((node2) => JSON.stringify(node2.id)).join(", ");
        throw new Error(
          `dagExecute: cycle detected involving node ids ${cycleIds} \u2014 DAG execution requires an acyclic dependsOn graph`
        );
      }
      const node = remaining.splice(readyIndex, 1)[0];
      done.add(node.id);
      ordered.push(node);
    }
    return ordered;
  }

  // pr-review-reduced-dag.workflow.ts
  var CHEAP_MODEL = "haiku";
  var CHEAP_EFFORT = "low";
  var CATEGORY_LENSES = {
    bugfix: ["root-cause", "regression-risk", "test-coverage", "maintainability"],
    feature: ["correctness", "security", "api-design", "maintainability"],
    refactor: ["behavioral-equivalence", "test-coverage", "readability", "maintainability"],
    config: ["correctness", "security", "blast-radius", "maintainability"],
    docs: ["accuracy", "completeness", "clarity"]
  };
  var FINDINGS_SCHEMA = {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            file: { type: "string", minLength: 1 },
            severity: { type: "string", enum: ["high", "medium", "low"] },
            detail: { type: "string", minLength: 1 }
          },
          required: ["title", "file", "severity", "detail"],
          additionalProperties: false
        }
      }
    },
    required: ["findings"],
    additionalProperties: false
  };
  var VERIFIER_SCHEMA = {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            findingId: { type: "string", minLength: 1 },
            verdict: { type: "string", enum: ["confirmed", "refuted", "unverifiable"] },
            citation: {
              type: "string",
              minLength: 3,
              pattern: "^.+:[0-9]+(?:-[0-9]+)?$"
            },
            rationale: { type: "string", minLength: 1 }
          },
          required: ["findingId", "verdict", "citation", "rationale"],
          additionalProperties: false
        }
      }
    },
    required: ["verdicts"],
    additionalProperties: false
  };
  function parseInput(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        "pr-review-reduced-dag: input must be an object with { target, category } because the reduced shape folds classification into deterministic script logic"
      );
    }
    const obj = raw;
    if (typeof obj["target"] !== "string" || obj["target"].trim().length === 0) {
      throw new Error('pr-review-reduced-dag: "target" must be a non-empty string');
    }
    if (typeof obj["category"] !== "string" || !(obj["category"] in CATEGORY_LENSES)) {
      throw new Error(
        'pr-review-reduced-dag: "category" must be one of bugfix, feature, refactor, config, docs because the reduced shape spends no agent on classification'
      );
    }
    return {
      target: obj["target"],
      category: obj["category"]
    };
  }
  function targetBlock(target) {
    return "```\n" + target + "\n```";
  }
  function reviewPrompt(input, lens) {
    return `## Role
You are a specialized code reviewer for the "${lens}" lens.

## Change
Category: ${input.category}

**Target:**
${targetBlock(input.target)}

## Instructions
- Read the actual change from first principles.
- Focus ONLY on the "${lens}" lens.
- Do not trust any prior summary; produce only findings you can support from the source.

## Output
Return { "findings": [{ "title": "...", "file": "path", "severity": "high|medium|low", "detail": "..." }] }`;
  }
  function interleaveFindings(findingsByLens) {
    const lenses = Object.keys(findingsByLens);
    const interleaved = [];
    let index = 0;
    while (true) {
      let added = false;
      for (const lens of lenses) {
        const finding = findingsByLens[lens]?.[index];
        if (finding !== void 0) {
          interleaved.push(finding);
          added = true;
        }
      }
      if (!added) return interleaved;
      index++;
    }
  }
  function verifierPrompt(input, findings) {
    return `## Role
You are the shared verifier for a reduced PR review.

## Change
Category: ${input.category}

**Target:**
${targetBlock(input.target)}

## Required constraints
1. Return one verdict per finding, each anchored in a FRESH re-read of the source and cited as file:line. A verdict with no fresh citation counts as no verdict.
2. Do NOT reference any other finding in a verdict. No "same as the previous one", no "same pattern as #2", and no cross-finding comparisons.
3. The findings below are intentionally INTERLEAVED across lenses. Judge each finding independently in the order given, never as a grouped lens block.

## Findings to verify
\`\`\`json
` + JSON.stringify(findings, null, 2) + `
\`\`\`

## Output
Return { "verdicts": [{ "findingId": "...", "verdict": "confirmed|refuted|unverifiable", "citation": "path:line", "rationale": "..." }] }`;
  }
  function summarize(verdict, findings) {
    if (findings.length === 0) return "No findings were returned by the reduced review lenses.";
    const counts = {
      confirmed: findings.filter((finding) => finding.verifierVerdict === "confirmed").length,
      refuted: findings.filter((finding) => finding.verifierVerdict === "refuted").length,
      unverifiable: findings.filter((finding) => finding.verifierVerdict === "unverifiable").length
    };
    return `${verdict}: ${counts.confirmed} confirmed, ${counts.refuted} refuted, ${counts.unverifiable} unverifiable findings.`;
  }
  async function run(rt, input) {
    rt.phase("Classify");
    const lenses = [...reducedLenses(CATEGORY_LENSES[input.category])];
    const classificationTrail = { trail: [makeRecord("prReviewReducedDag:classify", true, { decision: input.category })] };
    const reviewFindingsByLens = /* @__PURE__ */ new Map();
    let verifierOutput = null;
    const reviewNodes = lenses.map((lens) => ({
      id: `review:${lens}`,
      dependsOn: [],
      kind: "review",
      lens
    }));
    const verifyNode = {
      id: "verify:shared",
      dependsOn: reviewNodes.map((node) => node.id),
      kind: "verify"
    };
    const dag = await dagExecute(rt, {
      nodes: [...reviewNodes, verifyNode],
      stageKey: "reduced",
      run: async (node, dagRt) => {
        if (node.kind === "review") {
          dagRt.phase("Review");
          const output2 = await dagRt.agent(reviewPrompt(input, node.lens), {
            schema: FINDINGS_SCHEMA,
            label: `pr-review-reduced-dag:review:${node.lens}`,
            phase: "Review",
            model: CHEAP_MODEL,
            effort: CHEAP_EFFORT
          });
          if (output2 === null) return null;
          reviewFindingsByLens.set(
            node.lens,
            output2.findings.map((finding, index) => ({
              ...finding,
              lens: node.lens,
              findingId: `${node.lens}:${index + 1}`
            }))
          );
          return output2;
        }
        dagRt.phase("Verify");
        const interleavedFindings = interleaveFindings(Object.fromEntries(reviewFindingsByLens));
        const output = await dagRt.agent(verifierPrompt(input, interleavedFindings), {
          schema: VERIFIER_SCHEMA,
          label: "pr-review-reduced-dag:verify",
          phase: "Verify",
          model: CHEAP_MODEL,
          effort: CHEAP_EFFORT
        });
        verifierOutput = output;
        return output;
      }
    });
    if (verifierOutput === null) {
      throw new Error("pr-review-reduced-dag: the shared verifier did not return a result");
    }
    const sharedVerifier = verifierOutput;
    rt.phase("Synthesize");
    const allFindings = interleaveFindings(Object.fromEntries(reviewFindingsByLens));
    const verdictById = new Map(
      sharedVerifier.verdicts.map((verdict2) => [verdict2.findingId, verdict2])
    );
    const findings = allFindings.map((finding) => {
      const verifierVerdict = verdictById.get(finding.findingId);
      if (verifierVerdict === void 0) {
        throw new Error(`pr-review-reduced-dag: verifier omitted verdict for ${finding.findingId}`);
      }
      return {
        ...finding,
        verifierVerdict: verifierVerdict.verdict,
        citation: verifierVerdict.citation,
        rationale: verifierVerdict.rationale
      };
    });
    const verdict = findings.some((finding) => finding.verifierVerdict !== "refuted") ? "request-changes" : "approve";
    const synthesisTrail = { trail: [makeRecord("prReviewReducedDag:synthesize", true, { decision: verdict })] };
    return {
      category: input.category,
      target: input.target,
      lenses,
      waves: dag.value.waves,
      verdict,
      summary: summarize(verdict, findings),
      findings,
      envelope: { trail: collectTrail(classificationTrail, dag, synthesisTrail) }
    };
  }
  var pr_review_reduced_dag_workflow_default = defineWorkflow({
    meta: {
      name: "pr-review-reduced-dag",
      description: "Reduced PR review as a DAG: deterministic classification from input, three independent review lenses, one shared verifier, deterministic synthesis.",
      whenToUse: "Use when you want the reduced PR-review budgeted shape as a runnable DAG. Pass both target and category: this reduced form spends no agent on classification and no agent on synthesis.",
      phases: [
        { title: "Classify", detail: "Deterministic category selection from workflow input" },
        { title: "Review", detail: "Three reduced lenses run in one DAG wave", model: "haiku" },
        { title: "Verify", detail: "One shared verifier depends on all three review lenses", model: "haiku" },
        { title: "Synthesize", detail: "Deterministic verdict and summary in script logic" }
      ]
    },
    parseInput,
    run
  });
  return __toCommonJS(pr_review_reduced_dag_workflow_exports);
})();

// --- wt glue: bind sandbox globals into rt, run the workflow, return ---
const __rt = { agent, parallel, pipeline, phase, log, budget, workflow };
return await __wt.default.run(__rt, typeof args !== "undefined" ? args : undefined);

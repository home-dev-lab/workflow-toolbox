// verify-findings.js — a complete, runnable example.
//
// Given a list of claims, spawn three REFUTE-FIRST verifiers per claim in
// parallel. Each verifier is told to assume the claim is wrong and to default to
// "refuted" when it cannot independently confirm. A claim dies on >=2 refutations.
// Claims nobody could confirm OR refute are KEPT and flagged unverifiable — never
// silently dropped, because "we couldn't check it" is not the same as "it's false".
//
// Why three independent verifiers: a single agent can die mid-reasoning and emit
// a confident-but-truncated verdict. Voting across fresh contexts dilutes that.

export const meta = {
  name: 'verify-findings',
  description: 'Refute-first triple-verify a list of claims; kill on majority refutation, keep unverifiable ones flagged',
  phases: [{ title: 'Normalize' }, { title: 'Verify' }, { title: 'Tally' }],
};

// Verdict is about the CLAIM: "refuted" means the verifier found counter-evidence;
// "confirmed" means it survived the attack; "uncertain" means neither — and we
// require counterEvidence even when confirming, so confirmations aren't free.
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    counterEvidence: { type: 'string', description: 'Independently gathered; required even when confirming' },
  },
  required: ['verdict', 'counterEvidence'],
};

const VERIFIER_COUNT = 3;
const REFUTE_PREAMBLE =
  'You are an adversarial verifier. Assume the following claim is WRONG and try to ' +
  'disprove it with independently gathered evidence. If you cannot confirm it from ' +
  'your own evidence, return "uncertain" — do NOT confirm on a hunch. Default to ' +
  'doubt: only return "confirmed" when your own counter-investigation positively backs it.';

phase('Normalize');
// String args arrive JSON-encoded over the tool boundary. Parse with a fallback:
// a bare non-JSON string is treated as a single claim rather than crashing.
const parsed =
  typeof args === 'string'
    ? (() => { try { return JSON.parse(args); } catch { return args; } })()
    : args;

// Accept { claims: [...] }, a bare array, or a single string. Coerce to a flat
// list of claim strings; ignore empties.
const list = Array.isArray(parsed)
  ? parsed
  : parsed && Array.isArray(parsed.claims)
    ? parsed.claims
    : parsed
      ? [parsed]
      : [];
const claims = list.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).filter(Boolean);

if (claims.length === 0) {
  throw new Error('verify-findings needs claims. Pass { "claims": ["...", "..."] } or a single claim string.');
}
log(`Verifying ${claims.length} claim(s) with ${VERIFIER_COUNT} refute-first verifiers each`);

phase('Verify');
// For each claim, gather VERIFIER_COUNT verdicts in parallel. Thunks, not bare
// promises — `() => agent(...)`. We keep the per-claim shape so the tally below
// can count refutations exactly.
const judged = [];
for (const claim of claims) {
  const verdicts = await parallel(
    Array.from({ length: VERIFIER_COUNT }, (_v, i) => () =>
      agent(`${REFUTE_PREAMBLE}\n\nCLAIM:\n${claim}`, {
        label: `verify[${i}]`,
        schema: VERDICT_SCHEMA,
      })
    )
  );
  // A null verdict (verifier skipped/errored) counts as neither confirm nor
  // refute — it must not be read as agreement.
  judged.push({ claim, verdicts: verdicts.filter(Boolean) });
}

phase('Tally');
// Deterministic counting in plain code — never let an agent narrate the numbers.
const confirmed = [];
const refuted = [];
const unverifiable = [];
let nullVerdicts = 0;

for (const { claim, verdicts } of judged) {
  nullVerdicts += VERIFIER_COUNT - verdicts.length;
  const refutes = verdicts.filter((v) => v.verdict === 'refuted').length;
  const confirms = verdicts.filter((v) => v.verdict === 'confirmed').length;

  if (refutes >= 2) {
    refuted.push({ claim, refutes, evidence: verdicts.filter((v) => v.verdict === 'refuted').map((v) => v.counterEvidence) });
  } else if (confirms >= 2) {
    confirmed.push({ claim, confirms });
  } else {
    // Neither a refute-majority nor a confirm-majority: KEEP it, flagged.
    unverifiable.push({ claim, refutes, confirms, reason: 'no majority — kept rather than dropped' });
  }
}

if (nullVerdicts > 0) log(`${nullVerdicts} verdict(s) were null (verifier skip/error) — counted as non-agreement`);

return {
  confirmed,
  refuted,
  unverifiable,
  stats: {
    claims: claims.length,
    confirmed: confirmed.length,
    refuted: refuted.length,
    unverifiable: unverifiable.length,
    verifiersPerClaim: VERIFIER_COUNT,
    nullVerdicts,
  },
};

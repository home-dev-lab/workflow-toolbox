// repo-health-snapshot.js — a complete, runnable example.
//
// Fan one reader agent out per repository area (dependencies, tests, docs, ci by
// default, or args.areas). Each scores its area 1-5 and lists concrete issues.
// Then ONE synthesis agent ranks the areas and proposes top actions. A barrier is
// the right call here — the ranking genuinely needs every area's score together,
// so this is fan-out-and-synthesize, not a per-item pipeline.

export const meta = {
  name: 'repo-health-snapshot',
  description: 'Score each repo area in parallel, then rank areas and propose top actions',
  phases: [{ title: 'Scan areas' }, { title: 'Rank & recommend' }],
};

// Schema because the synthesis prompt and the deterministic stats both read
// .area, .score and .issues off each result.
const AREA_SCHEMA = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    score: { type: 'integer', minimum: 1, maximum: 5, description: '1 = critical, 5 = healthy' },
    issues: { type: 'array', items: { type: 'string' }, description: 'Concrete, file-anchored problems' },
  },
  required: ['area', 'score', 'issues'],
};

const DEFAULT_AREAS = ['dependencies', 'tests', 'docs', 'ci'];

// String args arrive JSON-encoded; parse with a fallback so a bad string can't
// crash the launch. Accept { areas: [...] } or a bare array; else use the default.
const parsed =
  typeof args === 'string'
    ? (() => { try { return JSON.parse(args); } catch { return null; } })()
    : args;
const areas = Array.isArray(parsed)
  ? parsed
  : parsed && Array.isArray(parsed.areas)
    ? parsed.areas
    : DEFAULT_AREAS;

if (areas.length === 0) {
  throw new Error('repo-health-snapshot needs at least one area. Pass { "areas": ["tests", "ci"] } or omit args for the defaults.');
}

phase('Scan areas');
log(`Scanning ${areas.length} area(s): ${areas.join(', ')}`);

// parallel() over THUNKS — `() => agent(...)`. A reader that skips or errors
// resolves to null in the array; we account for those nulls explicitly below.
const raw = await parallel(
  areas.map((area) => () =>
    agent(
      `Inspect the "${area}" area of this repository. Read the relevant files and report a ` +
        `health score from 1 (critical) to 5 (healthy) and a list of concrete, file-anchored issues.`,
      { label: `scan:${area}`, schema: AREA_SCHEMA }
    )
  )
);

// .filter(Boolean) drops the null holes; we COUNT them so a half-scanned snapshot
// is never reported as if it were complete.
const scored = raw.filter(Boolean);
const dropped = raw.length - scored.length;
if (dropped > 0) log(`${dropped} area scan(s) returned null — snapshot is partial`);

if (scored.length === 0) {
  return { summary: null, areas: [], stats: { spawned: areas.length, dropped } };
}

phase('Rank & recommend');
// The synthesis agent needs ALL scores at once to rank them — that is why we
// took the barrier. Data crosses as prompt text via JSON.stringify.
const summary = await agent(
  'Given these per-area health results, rank the areas worst-to-best and propose the top 3 ' +
    `actions that would most improve overall repo health:\n${JSON.stringify(scored, null, 2)}`,
  { label: 'synthesize', phase: 'Rank & recommend' }
);

return {
  summary,
  areas: scored,
  stats: { spawned: areas.length, dropped },
};

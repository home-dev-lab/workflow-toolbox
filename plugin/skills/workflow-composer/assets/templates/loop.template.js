// loop.template.js — iterate until the work runs dry, with a TYPED stop
// condition. Every loop MUST have one — a bare `while (true)` over agents can
// burn forever. This skeleton layers three guards: a hard iteration ceiling, a
// dry-rounds counter (stop when rounds stop producing), and an OPTIONAL budget
// floor. Use a loop only when iteration adds value and the size is unknown up
// front; a known fixed list is just a map.

export const meta = {
  name: 'YOUR_WORKFLOW_NAME',           // kebab-case; keep equal to the filename
  description: 'ONE_LINE_SHOWN_IN_THE_PERMISSION_DIALOG',
  phases: [{ title: 'Iterate' }],
};

// Schema because we read `.items` and `.exhausted` off each round below.
const ROUND_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'string' }, description: 'NEW_FINDINGS_THIS_ROUND' },
    exhausted: { type: 'boolean', description: 'TRUE_WHEN_THE_AGENT_BELIEVES_NOTHING_IS_LEFT' },
  },
  required: ['items', 'exhausted'],
};

const MAX_ITERATIONS = 8;   // hard ceiling — the always-present backstop
const MAX_DRY_ROUNDS = 2;   // stop after this many consecutive empty rounds

// Optional budget floor: stop before spending the last `BUDGET_FLOOR` tokens so
// a final synthesis can still run. GUARD on `budget.total` first — when no
// budget was set, total is null and remaining() is Infinity, so an unguarded
// `remaining() < FLOOR` is never true: the floor silently does nothing (the
// Infinity trap). With the guard, no budget == no floor, which is correct.
const BUDGET_FLOOR = 50000;

phase('Iterate');
const collected = [];
let iterations = 0;
let dryRounds = 0;
let stoppedBy = 'maxIterations';   // overwritten when a softer guard fires first

while (iterations < MAX_ITERATIONS) {
  if (budget.total && budget.remaining() < BUDGET_FLOOR) { stoppedBy = 'budgetFloor'; break; }
  iterations++;

  const round = await agent(
    `YOUR_ITERATION_TASK. Already found: ${JSON.stringify(collected)}. Return only NEW items.`,
    { label: `round:${iterations}`, schema: ROUND_SCHEMA }
  );

  const found = round && round.items ? round.items : [];   // null round == a dry round
  collected.push(...found);
  log(`Round ${iterations}: +${found.length} (total ${collected.length})`);

  if (found.length === 0) dryRounds++; else dryRounds = 0;
  if (dryRounds >= MAX_DRY_ROUNDS) { stoppedBy = 'dryRounds'; break; }
  if (round && round.exhausted) { stoppedBy = 'agentReportedExhausted'; break; }
}

// Report WHY the loop stopped — a maxIterations stop hints there may be more.
return { collected, stats: { iterations, dryRounds, stoppedBy } };

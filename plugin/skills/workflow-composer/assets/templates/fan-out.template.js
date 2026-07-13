// fan-out.template.js — N independent agents run at once, then ONE agent
// synthesizes their pooled output. Reach for this only when the synthesis step
// genuinely needs every result together (ranking, merging, dedup). If each item
// flows on its own with no shared view, use pipeline.template.js instead.

export const meta = {
  name: 'YOUR_WORKFLOW_NAME',           // kebab-case; keep equal to the filename
  description: 'ONE_LINE_SHOWN_IN_THE_PERMISSION_DIALOG',
  phases: [{ title: 'Fan out' }, { title: 'Synthesize' }],
};

// Schema on EVERY result a later line reads a field off. Without it the agent
// returns free text and `r.finding` below is silently undefined.
const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    finding: { type: 'string', description: 'WHAT_EACH_WORKER_REPORTS' },
  },
  required: ['subject', 'finding'],
};

// The work units. Swap for args, a glob, a discovered list — anything iterable.
const WORK_ITEMS = ['ITEM_ONE', 'ITEM_TWO', 'ITEM_THREE'];

phase('Fan out');
log(`Spawning ${WORK_ITEMS.length} independent workers`);

// parallel() takes THUNKS — `() => agent(...)`, never a bare `agent(...)`.
// A bare promise would start eagerly and defeat the scheduler; a thunk lets the
// runtime control concurrency. An agent that errors or skips resolves to null.
const raw = await parallel(
  WORK_ITEMS.map((item) => () =>
    agent(`YOUR_TASK_HERE for: ${item}`, { label: `scan:${item}`, schema: ITEM_SCHEMA })
  )
);

// .filter(Boolean) strips the null holes (skips/errors). Count what fell out —
// never let losses vanish silently; the caller needs to know coverage shrank.
const results = raw.filter(Boolean);
const dropped = raw.length - results.length;
if (dropped > 0) log(`${dropped} worker(s) returned null — coverage reduced`);

phase('Synthesize');
// The synthesis agent sees ALL results at once (that is the whole point of the
// barrier). Data crosses the boundary as prompt text — stringify it in.
// Its prompt is 100% inline (no "read the repo/diff" instruction), so it can shed
// the ambient tool/skill injection every spawn otherwise pays: add
// `agentType: 'workflow-toolbox:lean'` to the opts when the workflow-toolbox
// plugin is installed (it is, if you are composing from its skill).
const summary = await agent(
  `YOUR_SYNTHESIS_INSTRUCTION over these findings:\n${JSON.stringify(results, null, 2)}`,
  { label: 'synthesize' }
);

return { summary, results, stats: { spawned: WORK_ITEMS.length, dropped } };

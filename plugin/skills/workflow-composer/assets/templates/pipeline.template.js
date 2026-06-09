// pipeline.template.js — each item flows through the stages ON ITS OWN, with no
// barrier between stages. A fast item reaches the last stage while a slow one is
// still in the first; nobody waits. This is the DEFAULT for staged work — prefer
// it over parallel() unless a stage truly needs every item at once (see note).

export const meta = {
  name: 'YOUR_WORKFLOW_NAME',           // kebab-case; keep equal to the filename
  description: 'ONE_LINE_SHOWN_IN_THE_PERMISSION_DIALOG',
  phases: [{ title: 'Stage 1' }, { title: 'Stage 2' }],
};

// Schema on the FIRST stage's output, because stage 2 reads a field off it
// (`draft.gist`). The last stage returns free text here, so it needs no schema —
// nothing downstream consumes its shape.
const STAGE1_SCHEMA = {
  type: 'object',
  properties: {
    gist: { type: 'string', description: 'WHAT_STAGE_ONE_EXTRACTS' },
  },
  required: ['gist'],
};

const ITEMS = ['ITEM_ONE', 'ITEM_TWO', 'ITEM_THREE'];

phase('Stage 1');
log(`Streaming ${ITEMS.length} items through 2 stages, no barrier`);

// Stage callbacks receive (prevResult, originalItem, index):
//   stage 1 — prev is undefined (no prior stage); use the originalItem.
//   stage 2 — prev is stage 1's result; originalItem is still the source item.
// A stage that throws drops THAT item to null and skips its remaining stages;
// other items keep flowing.
const outputs = await pipeline(
  ITEMS,
  (_prev, item) =>
    agent(`STAGE_1_TASK for: ${item}`, { label: 'extract', phase: 'Stage 1', schema: STAGE1_SCHEMA }),
  (draft, item, index) => {
    if (!draft) return null;          // upstream skipped/errored — propagate the hole
    return agent(
      `STAGE_2_TASK (#${index}) for "${item}" using:\n${JSON.stringify(draft)}`,
      { label: 'expand', phase: 'Stage 2' }
    );
  }
);

// Count the holes; do not silently shorten the array.
const results = outputs.filter(Boolean);
const dropped = outputs.length - results.length;
if (dropped > 0) log(`${dropped} item(s) dropped along the pipeline`);

// ── When a barrier WOULD be needed instead of this pipeline ──────────────────
// If a later stage must see ALL items together — global dedup, a total count,
// cross-item ranking, or a "stop once N succeed" early-exit — a per-item
// pipeline cannot express it. Collect with parallel(thunks) for the barrier
// stage, then run the cross-item logic over the gathered array. Use that only
// for the genuine cross-item step; keep everything else streaming here.

return { results, stats: { in: ITEMS.length, out: results.length, dropped } };

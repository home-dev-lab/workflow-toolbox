// missing-run.workflow.ts — negative fixture: default export lacks run().
//
// A default export that is not a DefinedWorkflow (here: a plain object with
// meta but no run function — i.e. the author forgot defineWorkflow) must be
// rejected with the actionable export-default message.
export default {
  meta: {
    name: 'wt-fixture-missing-run',
    description: 'Negative fixture — default export has meta but no run',
  },
}

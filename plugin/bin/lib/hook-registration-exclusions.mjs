// hook-registration-exclusions.mjs — every `plugin/bin/*-hook.mjs` file that is deliberately
// NOT declared in plugin.json, and why. Read by hook-registration-coverage-core.mjs's gate
// (toolkit/packages/build/test/hook-registration-coverage.test.ts). Same shape as
// toolkit/examples/docs-provenance.ts's `PLUGIN_BIN_DOC_DECISIONS` — a decision list with a
// reason per entry, audited against reality by its own test rather than trusted on its face.
//
// Adding an entry here without also making the exclusion TRUE is caught by the gate's
// staleExclusions/redundantExclusions checks — a script here must be shipped AND absent from
// the manifest, or the entry is flagged rather than silently trusted (card's requirement #3).

export const HOOK_REGISTRATION_EXCLUSIONS = [
  {
    script: 'wt-adopt-rules-check-hook.mjs',
    reason:
      'Deliberate deprecation shim (documented in its own header) for the pre-0.103.x hook name. ' +
      'Invoked directly by a side-effecting import from wt-adopt-check-hook.mjs so a session that ' +
      'snapshotted the OLD path at session start still gets the adoption-staleness notice — never ' +
      'through the manifest itself, so it cannot appear there.',
  },
]

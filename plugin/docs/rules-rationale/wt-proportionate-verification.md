# wt-proportionate-verification — rationale and field cases

Nothing extracted. The body of `plugin/rules/wt-proportionate-verification.md` between the
`<!-- embedded-copy:proportionate-verification-ladder:start -->` / `:end` markers is a
byte-identical copy shared with `plugin/agent-templates/{pilot,pilot-orchestrator}.md` and their
`plugin/launch-agents/agents/` twins, enforced by
`toolkit/packages/build/test/embedded-copy-sync.test.ts` — delegated agents run with no ambient
rules, so this block is their only way to receive the ladder. Cutting any line out of it would
require mirroring the cut into all four agent copies in the same pass and would risk removing a
`REQUIRED_CLAUSES` sentence that test asserts on; the marginal size saved does not justify that
blast radius. Left whole.

# wt-durable-fix-at-the-right-level — rationale and field cases

The operative directives now live in `plugin/rules/wt-durable-fix-at-the-right-level.md`. This file carries the paragraph the shipped `wt-guard-recurrence-hook.mjs` now enforces mechanically, kept here verbatim for provenance.

## The trigger is a COUNT, never a judgement

⚠ **Trigger is a COUNT, never a judgement.** *"Could a hook/gate/test/check make this impossible
to repeat?"* gets evaluated mid-task by whoever just succeeded at working AROUND the problem —
unenforceable, silently skipped, the exact shape an escalation clause may not use. Operative form:
**same guard fired for the same reason more than twice in one week → mechanise what it guards, or
fix the guard.** READ the number, never recall it.

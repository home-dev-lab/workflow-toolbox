# wt-step-back-architectural — rationale and field cases

Nothing extracted. An independent cross-family review (2026-09-02) found that the "A fix whose
defect has a TWIN elsewhere" section's directive to "answer this SAME pass, not later" and
"carry fix out + carry improvements back = one pass, not two" is not enforced by
`wt-propagation-reminder-hook.mjs` — the hook's own header states it only ever RAISES the
propagation question at edit time, never answers it or requires same-pass resolution. An
earlier draft of this cut collapsed the whole section to one "Enforced by" line; that
overstated the hook's actual coverage and was reverted. Left whole in the rule.

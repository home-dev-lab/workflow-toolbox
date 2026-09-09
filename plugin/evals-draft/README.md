# Draft eval cases — NOT run by the release gate

A case lives here while it cannot pass reliably on the eval model. `wt-plugin-eval-gate.mjs` runs
`plugin/evals/` only. `pilot-contract-launch-then-end` (2026-09-09): four prompt shapes measured on haiku
— file pointer 0/3, inline excerpt 1/3, settled facts + no tools 0/3 (the agent tried to EXECUTE the
launch), "written exam" 1/3. The judge is consistent; the eval model is not. It returns to `plugin/evals/`
when it passes 3/3 on three consecutive gates.

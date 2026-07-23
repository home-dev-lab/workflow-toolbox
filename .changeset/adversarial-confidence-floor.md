---
"@workflow-toolbox/patterns": minor
---

adversarialVerification: add a `minValidVotes` confidence floor (default 2). A `confirmed`/`refuted` verdict now requires at least this many surviving VALID (non-null, provenance-passed, retry-recovered) votes; a thinner majority — e.g. a multi-vote claim reduced to one valid vote by verifier failure or provenance disqualification — is DEMOTED to `partially-confirmed` (the existing low-confidence marker; no new verdict value). Clamped per claim to `min(minValidVotes, claimVotes)`, symmetric with `refuteThreshold`, so a deliberately low-vote claim (`votesPerClaim` / `votes: 1`) stays decided by the votes it was given. Set `minValidVotes: 1` for the pre-floor behaviour.

---
'@workflow-toolbox/patterns': minor
---

`adversarialVerification` now retries a verifier vote once when it was disqualified for
missing provenance, instead of dropping it outright — a transient provenance miss no longer
silently thins the vote pool. The effective-label provenance resolution is corrected so a
vote is credited against the label it actually ran under, and the provenance guard is
anchored so a disqualified-without-provenance vote can't slip through the retry path
uncounted.

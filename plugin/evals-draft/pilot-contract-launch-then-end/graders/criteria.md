---
type: llm
weight: 1
---

A successful answer launches `wt-lane.mjs` and explicitly ends the pilot turn so the runner can
watch the `EXIT=` marker. Any Bash sleep, polling loop, `wt-lane-wait`, foreground lane, or
ScheduleWakeup answer fails.

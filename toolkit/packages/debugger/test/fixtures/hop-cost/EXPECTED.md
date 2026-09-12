# Known Cost

The transcript is hand-authored and the expected values are counted independently.

- Hops: `3` (`alpha`, `beta`, then `gamma` from `alpha`).
- Maximum depth: `2` (`gamma`).
- Widest turn: `2` (the main transcript's two `Agent` calls in `main-spawns`).
- Chatter: `2` messages to `alpha`.
- Alpha chatter re-ingest fresh input: `101 (by-time; delivered text differs) + 102 (by-text) = 203` tokens.
- Alpha chatter re-ingest cache-read: `21 (by-time; delivered text differs) + 22 (by-text) = 43` tokens.
- Beta is an async spawn: its launch stub is reported separately. Its re-ingested output is `ceil(101 / 4) = 26` notification-block tokens plus `ceil(9 / 4) = 3` read-back tokens, for `29` returned tokens labelled `notification + read-back`.
- Prompt and returned message sizes are text estimates (`ceil(characters / 4)`), because Claude Code records no per-tool-block token usage.

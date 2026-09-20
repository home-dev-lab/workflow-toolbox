# wt-deep-search

**EXPERIMENTAL.** It improves web search in two ways, and you can install it with no key and no
configuration at all: with nothing configured, your searches behave exactly as they do today.

## What you get

**Your `WebSearch` calls get answered by something better, without changing anything you do.**
A question about Claude Code itself — the changelog, hooks, agents, skills, the formatter, a
setting — is answered from the documentation mirror on your own disk, offline and free, if you
have one. A question about a third-party library goes to context7. An ordinary question goes to
Brave or Exa when you have set a key. Anything else falls through to the web search you already
had, unchanged. The answer always names which engine actually answered.

**And a `/deep-search` skill for research that takes minutes.** It starts detached, hands you a
handle, and you collect the result later — so a ten-minute research never blocks a turn.

## Install

Add the plugin. Nothing else is required.

| you have | you get |
| --- | --- |
| nothing configured | plain `WebSearch`, unchanged — the plugin is invisible |
| `magic-claude-docs` installed (the mirror at `~/.claude-code-docs`) | Claude Code questions answered offline, for free |
| context7 | library and framework questions answered from real documentation |
| `BRAVE_API_KEY` (or `BRAVE_SEARCH_API_KEY`) | ordinary questions answered by Brave, with dates |
| `EXA_API_KEY` | ordinary questions answered by Exa, and the deep-research ladder |
| `opencode` on your PATH | the agentic rung, billed to your subscription rather than metered |

**No key is ever required.** Each rung reports itself absent and the next one takes over; a rung
that would answer badly is skipped in favour of the one below it.

⚠ The documentation mirror is a separate plugin, `magic-claude-docs`, which is not ours. Without
it, mirror detection simply reports it absent and every question continues down the ladder.

## Cost

The mirror and context7 cost nothing. Brave's free plan gives 2000 requests a month. Exa is
metered, and the plugin refuses the two Exa modes that are expensive by surprise: an Agent run on
effort `auto` is billed at $5 per run and beta `max` at $20, so an explicit effort is always
required. The agentic rung spends your `opencode` subscription, never a metered API.

## Dependencies

None, at build time and at run time. That is deliberate and it is what makes installing this
riskless: there is no lockfile to trust, nothing fetched, nothing to audit but the source here.

## Platforms

See `CROSS-PLATFORM.md`: it states, per system dependency, whether it throws, degrades to a named
unknown, or silently returns a plausible value on Linux, macOS and Windows — and which rows were
run rather than read.

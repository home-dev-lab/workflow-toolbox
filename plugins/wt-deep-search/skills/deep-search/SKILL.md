---
name: deep-search
description: "Read this BEFORE searching. It says which engine answers your question, with which parameters, and how to run a DEEP research that takes minutes without blocking your turn. Invoke it when you are about to call WebSearch, when a question needs several sources, when it is about a named library, framework, CLI or API, or when the user asks for a deep search."
when_to_use: about to call WebSearch · about to call WebFetch on a URL you guessed · a question about a library, framework, SDK, API, CLI or cloud service · a question about what changed in a version or a release · a claim you are about to state from memory about someone else's software · a research question needing several sources or citations · recherche web, recherche profonde, documentation d'une bibliothèque, quelle version, qu'est-ce qui a changé
user-invocable: true
effort: low
---

# Deep search

This skill does two things. Read the half you need.

- **The FAST half** is already automatic where the `deep-search` plugin is installed: a hook
  answers `WebSearch` from the local Claude Code mirror, from context7, or from Brave or Exa,
  and falls through to the ordinary web search when no rung fits. You call `WebSearch`; it
  improves underneath. Read *Which engine answers what* only to know what happened and what it
  could not see.
- **The DEEP half is YOURS to drive.** It takes minutes, so it can never run inside a tool
  call. Run it detached, keep working, collect the result later with the handle it gives you.
  Everything from *Judge the difficulty* down is the deep half.

## Which engine answers what

Take the FIRST row that matches. Descend a row on any failure — no key, an error, an exhausted
quota, an empty result. A rung that answers badly is worse than the rung below it.

| Your question | Engine | Cost |
| --- | --- | --- |
| Claude Code itself — its changelog, hooks, agents, skills, the formatter, a setting, a slash command | the local mirror `~/.claude-code-docs` | nil |
| A third-party library, framework, SDK, API or CLI | `context7` | nil |
| A simple fact, a page to find, a current event | Brave, else Exa at its cheapest type | free or near nil |
| A question no single query answers | the deep half below | subscription quota, or metered |
| Anything else, or nothing configured | plain `WebSearch` | free |

Never answer a question about someone else's software from memory, even for React, Vite or
Playwright. Never `WebFetch` a page over a few kilobytes — its HTML lands in your context; use
`ctx_fetch_and_index` then `ctx_search`.

## Judge the difficulty yourself — there is no keyword table, deliberately

You judge, per question. A lookup table would freeze judgement into keywords, which is the exact
defect the mirror's own classifier demonstrated. Ask, in this order:

1. **Would ONE good query answer it?** Then it is not a deep search. Run the fast half and stop.
2. **Does it need several sources reconciled, or a synthesis?** Start at `deep-lite`.
3. **Does it need multi-step search — a second query whose terms only exist in the first
   answer?** Use `deep`.
4. **Does completeness matter more than latency — an exhaustive comparison, an enumeration, a
   claim you will publish?** Use `deep-reasoning`.
5. **Does answering require ACTING — reading repositories, running a tool, following leads you
   cannot enumerate in advance?** Use `agentic`, which is an `opencode` run driving its own
   sub-agents.

Climb only when the rung below cannot do it. A deep research is a decided act, never a reflex:
`agentic` spends the subscription quota other work also needs.

## opencode has TWO doors — never write them as one

| door | you enter it because | who decided |
| --- | --- | --- |
| difficulty | the question needs an agentic search, one level above `deep-reasoning` | you, judging above |
| availability | Exa is exhausted, keyless, or refusing | the provider's own answer |

The runner records which door it used. Keep them distinct: collapsing them into "else opencode"
deletes the agentic tier the day Exa works well.

## Run it — detached, then collect

From the plugin's own directory — `$CLAUDE_PLUGIN_ROOT` names it when this skill runs inside the
plugin, and the commands below are relative to it:

```
node bin/deep.mjs start --mode <deep-lite|deep|deep-reasoning|agentic> --question "<your question>" [--shape prose|structured]
node bin/deep.mjs status <handle>
node bin/deep.mjs result <handle>
node bin/deep.mjs list
```

`start` prints a handle and returns at once. Do other work. Come back with `status`; collect with
`result`. Never poll in the foreground and never wait on it inside a tool call.

⚠ **Choose the shape at START, not at collection.** The output schema is sent with the question, so
a run begun for prose has no claims to give you afterwards and says so rather than pretending.
Pass `--shape structured` when an AGENT will consume the answer; leave it prose for a human.

Measured 2026-09-21 on real runs: `deep-lite` answers in about 3 seconds and the run reports its own
cost, $0.012. Read that figure; never quote one from a price list.

## The prompt changes shape with the mode — this is measured, not preferred

| mode | send |
| --- | --- |
| Brave, Exa `instant` and `fast` | a SHORT keyword query. A long question made the mirror's scorer return the wrong page; the plain one returned the right guide |
| Exa `deep` and `deep-reasoning` | the question in PROSE, plus an output schema. Without the schema, `deep-reasoning` returns URLs and no prose — an evening was lost believing the product could not write |
| `agentic` | a FULL brief, as you would write for a lane. It drives sub-agents; a keyword query wastes it |

## Money — these are locks, not preferences

- **There is no `effort` any more, and asking for one is refused.** It belonged to Exa's Research
  and Agent product, which is RETIRED — measured 2026-09-21, `POST https://api.exa.ai/research/v1`
  answers 410 `RESEARCH_RETIRED`. The deep rungs go through `/search` with a research `type`, in
  ONE call. The old $5-per-run `auto` trap went with the product; `auto` as a search TYPE is
  ordinary and fine.
- **Every run reports what it actually cost**, and the answer carries that figure.
- Brave's free plan gives 1 request per second and 2000 per month, web search only — its
  `llm/context` and `chat/completions` endpoints answer `OPTION_NOT_IN_PLAN`.
- On a 429 the runner retries with backoff. On insufficient credit or `OPTION_NOT_IN_PLAN` it
  switches to opencode at once. A 5xx or a network error is transient and marks nothing.

## The output shape follows the CONSUMER, not the mode

| who reads it | shape |
| --- | --- |
| the user, or your own reasoning | prose, with the citation inline after each assertion |
| an SDK-runner agent | the structured object: `claim`, `url`, `date`, and what could not be verified |

For an agent, prose is pure cost — it would have to re-parse it before acting.

⚠ **The shape decides whether you get a source per claim — measured 2026-09-21, both ways, same
question.** With the claim schema, every claim came back with its own `url` and `date`. In prose,
the answer carried `[1][2][3]` markers and the URLs sat in a separate grounding field, which is
why the prose output now prints the sources underneath: a marker that resolves to nothing is a
citation in appearance only. Treat a missing citation as missing, never as implied by the others.

## What you owe the reader afterwards

Name the engine that actually answered, and say what it could not see. "context7 has no docs for
this library" and "I searched the web and found nothing" are different claims — a search proves
absence only inside the set it was given.

## When the plugin is NOT installed, drive the fast rungs by hand

Check first: the hook only exists where `deep-search` (or `wt-deep-search`) is loaded, and the
mirror only where `magic-claude-docs` is. Verify `~/.claude-code-docs/` exists before routing
there; absent, say which source answered instead.

- **The mirror** — 189 pages from `code.claude.com/docs/en/`, plus weekly digests and
  `recent_changes.md`. Read `~/.claude-code-docs/<topic>.md` directly, or run
  `/magic-claude-docs:docs <topic>`; for what changed, `/magic-claude-docs:docs what's new`.
- **context7 — two calls, always in this order.** Run `resolve-library-id` with the library's
  plain name and read what it returns, since it can name several and you pick. Then run
  `query-docs` with that id and your actual question in prose. Pass the version when the question
  is about a version, and `topic` when the library is large and the question is narrow. Its answer
  is documentation, never a verdict about YOUR code — read your own tree before concluding.
- **Exa by hand** — set the contents parameters, which change the answer more than the type does:
  `contents.highlights` (start here), `contents.maxAgeHours` when the answer decays,
  `output_schema` when you will consume it as data, filters only as HARD constraints, and
  `numResults` in one call since there is no pagination.
- **OpenAlex** for academic or bibliographic evidence: free, no key. Resolve a work or an author by
  id before citing it — a title you remember is not a citation.

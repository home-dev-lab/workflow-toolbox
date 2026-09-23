import { beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGINS = ['wt-secret-guard']
const PRIVATE_HOME_PATH = /\/home\/doublefx/
const PRIVATE_ID = /(?<!\d)\d{19}(?!\d)/

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}

describe('shipped private plugins', () => {
  for (const plugin of PLUGINS) {
    let selftest: SpawnSyncReturns<string>

    beforeAll(() => {
      selftest = spawnSync(process.execPath, [join(REPO_ROOT, 'plugins', plugin, 'hooks', 'hooks.selftest.mjs')], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
    }, 45_000) // Measured locally at 9.2s; allow 5x for loaded cross-OS runners.

    it(`${plugin} selftest exits successfully`, () => {
      expect(selftest.status, selftest.stderr || selftest.stdout).toBe(0)
    })

    for (const lock of [
      'prompt storage rewrites history display and nested pasted contents without changing unrelated lines or mode',
      'concurrent history appends survive every in-place overwrite byte-identical',
      'prompt storage locates the JSON-escaped secret and leaves valid same-length JSON',
      'not-found prompt storage warns exactly once without revealing the secret',
      'malformed prompt history is left untouched and does not repeat the storage notice',
      'compare-then-write mismatch writes nothing and keeps one secret-free notice',
      'history rewrite retries inside a bounded clock window when the record is initially absent',
      'prompt storage falls back from CLAUDE_CONFIG_DIR to HOME dot-claude',
      'sdk prompt storage rewrites an enqueue record written after prompt forwarding',
      'queue-operation targeting is independent of prompt origin and retries a late enqueue',
      'does not register an inert user-tier prompt.context guard',
      'inbound known-vendor credential is withheld with a visible revocation notice',
      'ordinary inbound message mentioning key is unchanged and answerable',
      'plain-line op credential output is scrubbed',
      'complete concealed JSON output is scrubbed',
      'truncated concealed JSON output is scrubbed',
      'stderr-prefixed concealed JSON output is scrubbed',
      'trailing-line concealed JSON output is scrubbed',
      'concealed JSON escaped values are decoded while serialized bytes are scrubbed',
      'ordinary JSON values are not scrubbed',
      'malformed concealed JSON does not throw and scrubs its value',
      'double-quoted op reference rewrites with exactly one level of quoting',
      'single-quoted op reference rewrites with exactly one level of quoting',
      'op reference written to a tpl file is left literal',
      'V30 a heredoc that MENTIONS a reference triggers no op call and passes untouched',
      'V31 a command using our forms never runs a program whose name the guard cannot read literally, wherever bash reads a command name',
      'V32 a value the guard substituted is masked in that command output whatever its kind',
      'V33 the heredoc end matches bash exactly, and an uncertain heredoc refuses a command using our forms',
      'V34 overlapping detections are merged before replacement: no pattern unmasks what another masked',
      'V35 the source-keyword exemption covers a NAME value, never a quoted literal',
      'V36 the failure memory never exceeds its bound, in-flight resolutions included',
      'V37 ordinary commands using our forms are not refused for the syntax around them',
      'V38 a command using our forms never runs, through a listed external wrapper, a program whose name the guard cannot read literally',
      'V39 ordinary commands through a listed wrapper pass, and the op read form behind a wrapper is validated beside our forms',
      'V40 the verify9 bypasses never run a command using our forms',
      'V41 a token identifies exactly one value: no collision overwrites a vault entry',
      'V42 beside our forms only the allow-list grammar runs; without our forms every command passes byte-identical',
      'V43 the verify10 bypasses and masking failures are closed',
      'V44 beside our forms a word whose role or expansion is uncertain is refused',
      'V45 the verify11 bypasses and masking failures are closed',
      'V46 beside our forms: no continuation, no CR, no $[ ], keywords decoded, no xargs, idempotent tokens, newline variants masked',
      'V47 the verify12 bypasses and failures are closed',
      'V48 beside our forms every byte outside printable ASCII, space, tab and newline is refused, in every position',
      'V49 no lookup in the guard answers for an inherited property name',
      'V50 the verify13 findings are closed and the README describes what the code does',
      'V51 the host loads the module: no dynamic $.env.get, secret:env refuses with its reason, a compound keyword is named',
      'V52 the verify14 findings: no replacement is spelled like a held value; op is placed through redirections',
      'V53 the verify15 findings: an issued token stays usable after its spelling becomes a value; a comment ends op read; no message recommends secret:env',
      'op reference in a sed search pattern is left literal',
      'op reference inside a larger quoted string is left literal',
      'already substituted op reference is not rewritten again',
      'email masking is off by default in prompts and tool results',
      'email masking option covers prompts and tool results',
      'IP masking is off by default in prompts and tool results',
      'IP masking option covers prompts and tool results',
      'destructuring defaults named like credentials pass through tool results',
      'object literal assignment expressions named like credentials pass through tool results',
      'function parameter defaults named like credentials pass through tool results',
      'short genuine credential assignments in command output remain scrubbed',
      'source-looking prefixes do not exempt a later credential assignment on the same line',
      'exported credential assignments are scrubbed from tool results',
      'exported credential assignments are scrubbed from inbound messages',
      'indented and diff-prefixed exported credentials are scrubbed',
      'exported source declarations pass while an exported credential is scrubbed',
      'UUID Exa API key in a provider client constructor is scrubbed',
      'bare UUID in a plain log line stays untouched',
      'Brave API key shape is scrubbed',
      'raw outbound values are refused on every governed tool without calling next',
      'field-aware outbound classification catches credential UUIDs but not bare run ids',
      'outbound fixture canonicalization and unsupported-tool branches fail closed',
      'reference-shaped outbound values and clean controls pass byte-identically',
      'denied tool input is repaired in place in the transcript by tool_use_id',
      'assistant stream masks every character-boundary split and scrubs the final answer',
      'assistant stream finally flushes held text while signed thinking remains untouched',
      'assistant stream remains bounded for long clean, detected, and unterminated private-key blocks',
      'AssistantMessage render masking is display-only and forwards only scrubbed props',
      'journal reload preserves records already present in the per-session file',
      'classic startup notice requires the flag and stays silent when Function Hooks are enabled',
      'R1 reference spans do not exempt adjacent raw assignments',
      'R2 network and delegated prompts are guarded while search results are scrubbed',
      'R3 transcript repair reads only a bounded tail above 4 MiB',
      'R3 a partial trailing transcript line retries after completion',
      'R3 replacement between compare and write fails closed on file identity',
      'R4 Windows prompt repair uses a shipped PowerShell -File adapter',
      'R5 assistant stream masks a long opaque known value split across flush boundaries',
      'V6 detected-prefix flush retains every byte of an incomplete known value',
      'V10 an incomplete known value is not released by a flush another detection triggers',
      'V11 a detected value straddling a prefix/tail cut is never released in halves',
      'stream fragment invariant holds at every split and every seeded chunking',
      'D1 turn.step leaves tool input chunks byte-identical for tool.call refusal',
      'D2 known vault values and their base64 forms are refused outbound',
      'D3 nested password findings carry the raw leaf into transcript repair',
      'D4 file references bind contents as data instead of shell source',
      'D5 explicit op read keeps account and failed prefetch refuses execution',
      'D6 journal appends from concurrent module instances without losing either event',
      'D7 resolver startup diagnostics never include arbitrary exception text',
      'D8 fixture paths receive no outbound allowance',
      'D9 every attachment is scrubbed and SessionStart hook origin still warns',
      'D10 Edit old_string can remove a leaked secret',
      'D11 refusal guidance is surface specific',
      'D12 declared turnId and index fields drive dedupe identities',
      'D13 subagent denial names the unmeasured storage gap without touching the main transcript',
      'D14 read policy covers expansions, multiple paths, globs, envrc and backslashes',
      'D15 dated measurement comments remain beside measured adapters',
      'D17 history storage returns immediately after successful repair',
    ]) it(`${plugin}: ${lock}`, () => expect(selftest.stdout).toContain(`PASS ${lock}`))
  }

  it('contains no machine-specific home path or private 19-digit identifier', () => {
    const hits: string[] = []
    for (const plugin of PLUGINS) for (const file of files(join(REPO_ROOT, 'plugins', plugin))) {
      const text = readFileSync(file, 'utf8')
      if (PRIVATE_HOME_PATH.test(text) || PRIVATE_ID.test(text)) hits.push(relative(REPO_ROOT, file))
    }
    expect(hits).toEqual([])
  })
})

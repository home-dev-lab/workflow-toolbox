export interface HelpGrammar {
  /** Options that consume the next token, whatever it is (including `--help`, `-h`, `--`). */
  valueFlags: readonly string[]
  /** Options that consume nothing. */
  booleanFlags: readonly string[]
  /** True only when the CLI treats a literal `--` as "everything after it is data". */
  endOfOptions?: boolean
}

export type HelpVerdict =
  | { kind: 'help' }
  | { kind: 'unknown-option', token: string }
  | { kind: 'none' }

/** Walk argv like the CLI's parser (see cli-help.mjs). Throws a TypeError when `grammar` is missing or malformed. */
export function inspectHelpRequest(argv: readonly string[], grammar: HelpGrammar): HelpVerdict

/** True when `--help` / `-h` is in flag position under `grammar`. */
export function isHelpRequested(argv: readonly string[], grammar: HelpGrammar): boolean

/** Print `helpText` and exit 0 on help; exit 2 on an undeclared option next to a help token; otherwise return. */
export function handleHelpFlag(argv: readonly string[], helpText: string, grammar: HelpGrammar): void

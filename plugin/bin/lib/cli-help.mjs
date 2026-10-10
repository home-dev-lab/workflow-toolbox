// cli-help.mjs — the ONE convention every operator-facing wt-* CLI uses for --help/-h.
//
// Why this exists: `--help` used to be an ordinary unknown flag on most of these scripts,
// refused with exit 2 exactly like a typo. That is the wrong answer to the single most
// common thing anyone types at an unfamiliar binary, and it makes a wrapper that probes
// availability with `--help` conclude the tool is broken.
//
// Why help is decided by a grammar walk: `--help` is only help when it is a FLAG. As the value of a
// value-taking option (`--today --help`, `--range --help`) it is data, and treating it as help
// would print usage and exit 0 — which a hook reads as "the guard passed" without the guard having
// looked at anything. Whether a token is a value depends on the parser's state, not on how the
// token is spelled, so the helper walks argv the way the CLI's own parser does, from a grammar
// the CLI declares in full:
//   valueFlags    options that consume the next token, whatever it is (`--help`, `-h`, `--`, `-x`)
//   booleanFlags  options that consume nothing
//   endOfOptions  true only when the CLI really treats a literal `--` as "everything after is data"
// A token that does not start with `-`, or is exactly `-`, is a positional. `--name=v` is NOT
// understood: no caller's parser reads equals syntax, and several skip the next token after any
// `--` token, so the helper cannot know what `--name=v` would consume. It is an undeclared option.
//
// The walk has three outcomes (see `inspectHelpRequest`):
//   help            a `--help` / `-h` met in option position -> usage, exit 0.
//   unknown-option  an option-looking token the grammar does not declare, met in option position
//                   while argv also holds a help token somewhere. The helper cannot tell what that
//                   token would have consumed, so it refuses (`<cli>: unknown option <token>`,
//                   exit 2) rather than guess: printing usage could hide a value, and falling
//                   through would let the command run although the caller asked for help.
//   none            nothing to do; the CLI's own parser decides, so an invocation WITHOUT a help
//                   token behaves exactly as before this helper existed.
//
// The grammar is a required argument and is validated at call time: a CLI added later cannot opt
// out of declaring it, and a declaration that forgot an option fails visibly (the option is refused
// next to a help token) instead of reopening the "help as a value" hole.
// A CLI calls this once, at the very top of its arg handling, with its own usage text.

const HELP_TOKENS = new Set(['--help', '-h'])

function assertGrammar(grammar) {
  const fail = (why) => {
    throw new TypeError(`cli-help: a grammar { valueFlags: string[], booleanFlags: string[], endOfOptions?: boolean } is required (${why})`)
  }
  if (grammar === null || typeof grammar !== 'object' || Array.isArray(grammar)) fail('missing or not an object')
  for (const key of ['valueFlags', 'booleanFlags']) {
    const list = grammar[key]
    if (!Array.isArray(list) || list.some((flag) => typeof flag !== 'string' || !flag.startsWith('-') || flag.length < 2)) {
      fail(`${key} must be an array of option names`)
    }
  }
  if (grammar.endOfOptions !== undefined && typeof grammar.endOfOptions !== 'boolean') fail('endOfOptions must be a boolean')
  const overlap = grammar.valueFlags.filter((flag) => grammar.booleanFlags.includes(flag))
  if (overlap.length > 0) fail(`declared as both value and boolean: ${overlap.join(', ')}`)
  if (grammar.valueFlags.concat(grammar.booleanFlags).some((flag) => HELP_TOKENS.has(flag))) fail('--help / -h are not options of the grammar')
}

/**
 * Walk argv like the CLI's parser and say what a help request would do. Pure.
 * @param {readonly string[]} argv
 * @param {{ valueFlags: readonly string[], booleanFlags: readonly string[], endOfOptions?: boolean }} grammar
 * @returns {{ kind: 'help' } | { kind: 'unknown-option', token: string } | { kind: 'none' }}
 */
export function inspectHelpRequest(argv, grammar) {
  assertGrammar(grammar)
  const values = new Set(grammar.valueFlags)
  const booleans = new Set(grammar.booleanFlags)
  const mentionsHelp = argv.some((token) => HELP_TOKENS.has(token))
  if (!mentionsHelp) return { kind: 'none' }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (grammar.endOfOptions === true && token === '--') return { kind: 'none' }
    if (HELP_TOKENS.has(token)) return { kind: 'help' }
    if (values.has(token)) {
      index += 1
      continue
    }
    if (booleans.has(token)) continue
    if (!token.startsWith('-') || token === '-') continue
    return { kind: 'unknown-option', token }
  }
  return { kind: 'none' }
}

/** True when `--help` / `-h` is in flag position under `grammar`. */
export function isHelpRequested(argv, grammar) {
  return inspectHelpRequest(argv, grammar).kind === 'help'
}

export function handleHelpFlag(argv, helpText, grammar) {
  const verdict = inspectHelpRequest(argv, grammar)
  if (verdict.kind === 'help') {
    const text = helpText.endsWith('\n') ? helpText : `${helpText}\n`
    process.stdout.write(text)
    process.exit(0)
  }
  if (verdict.kind === 'unknown-option') {
    const cli = (process.argv[1] ?? 'cli').replace(/^.*[\\/]/, '').replace(/\.mjs$/, '')
    const shown = verdict.token.replace(/[\r\n]+/g, ' ').slice(0, 80)
    process.stderr.write(`${cli}: unknown option ${shown}\n`)
    process.exit(2)
  }
}

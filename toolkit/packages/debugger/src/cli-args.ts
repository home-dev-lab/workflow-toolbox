// cli-args.ts — PURE argv parsing shared by the wt-debug CLI, the report CLI,
// and the published `workflow-toolbox debug`/`workflow-toolbox report` subcommands (bundled by tsup).
//
// Why hand-rolled: Claude Code project slugs are an absolute cwd with
// non-alphanumerics mapped to "-", so EVERY real slug starts with a dash
// (e.g. `-home-user-projects-x`). node:util parseArgs and naive
// `startsWith('-')` guards both read such a value as a flag — `--project`
// (and `--out`) must consume the next token as a value even when it starts
// with a dash, while still rejecting a KNOWN flag (a real "missing value").

export interface DebugArgs {
  runId: string | null
  json: boolean
  project: string | undefined
  help: boolean
  error?: string
}

export interface ReportArgs {
  runId: string | null
  project: string | undefined
  out: string | undefined
  quiet: boolean
  help: boolean
  error?: string
}

const KNOWN_FLAGS = new Set(['--json', '--project', '--out', '--quiet', '--help', '-h'])

/** Consume argv[i] as the value of `flag`. Returns an error string instead of
 *  the value when the token is absent or is itself a known flag. */
function takeValue(
  argv: string[],
  i: number,
  flag: string,
): { value?: string; error?: string } {
  const v = argv[i]
  if (v === undefined || KNOWN_FLAGS.has(v)) {
    return { error: `${flag} requires a value.` }
  }
  return { value: v }
}

/** Strip the equals form's value, erroring on `--flag=` (empty — matches the
 *  space form's missing-value behavior). */
function equalsValue(arg: string, flag: string): { value?: string; error?: string } {
  const v = arg.slice(flag.length + 1)
  if (v === '') return { error: `${flag} requires a value.` }
  return { value: v }
}

export function parseDebugArgs(argv: string[]): DebugArgs {
  const r: DebugArgs = { runId: null, json: false, project: undefined, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--json') r.json = true
    else if (a === '--project') {
      const t = takeValue(argv, ++i, '--project')
      if (t.error) return { ...r, error: t.error }
      r.project = t.value
    } else if (a.startsWith('--project=')) {
      const t = equalsValue(a, '--project')
      if (t.error) return { ...r, error: t.error }
      r.project = t.value
    } else if (a === '--help' || a === '-h') r.help = true
    else if (!a.startsWith('-')) r.runId = a
  }
  return r
}

export function parseReportArgs(argv: string[]): ReportArgs {
  const r: ReportArgs = {
    runId: null,
    project: undefined,
    out: undefined,
    quiet: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--quiet') r.quiet = true
    else if (a === '--project') {
      const t = takeValue(argv, ++i, '--project')
      if (t.error) return { ...r, error: t.error }
      r.project = t.value
    } else if (a.startsWith('--project=')) {
      const t = equalsValue(a, '--project')
      if (t.error) return { ...r, error: t.error }
      r.project = t.value
    } else if (a === '--out') {
      const t = takeValue(argv, ++i, '--out')
      if (t.error) return { ...r, error: t.error }
      r.out = t.value
    } else if (a.startsWith('--out=')) {
      const t = equalsValue(a, '--out')
      if (t.error) return { ...r, error: t.error }
      r.out = t.value
    }
    else if (a === '--help' || a === '-h') r.help = true
    else if (!a.startsWith('-')) r.runId = a
  }
  return r
}

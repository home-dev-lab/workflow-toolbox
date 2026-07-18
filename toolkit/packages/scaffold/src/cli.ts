// CLI entry — IMPURE (reads a JSON spec, writes the .workflow.ts / agent .md). Held out of
// `pnpm test` (no .test.ts peer — the @workflow-toolbox/smoke + @workflow-toolbox/debugger convention);
// still typechecked by `tsc`. Maintainer/author:
//   pnpm wt:scaffold <spec.json> [--out-dir <dir>] [--stdout]          # a .workflow.ts skeleton
//   pnpm wt:scaffold agent <spec.json> [--out-dir <dir>] [--stdout]    # a least-privilege agentType .md
//
// The per-mode load+render+filename mapping and the --stdout / no-clobber / mkdir / write
// mechanics are the shared ./dispatch helpers (the same ones the published `workflow-toolbox
// scaffold` subcommand uses, so the two cannot drift); only this dev CLI's arg parsing,
// messages and `next` hints live here.

import * as path from 'node:path'
import { capabilitiesLaunchHint, observerLaunchHint, PATTERN_NAMES } from './scaffold.js'
import { renderScaffold, writeScaffoldArtifact } from './dispatch.js'
import type { RenderedScaffold, ScaffoldMode, ScaffoldWriteResult } from './dispatch.js'

interface CliArgs {
  mode: ScaffoldMode
  specPath: string | null
  outDir: string
  stdout: boolean
  force: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let rest = argv
  let mode: ScaffoldMode = 'workflow'
  if (rest[0] === 'agent') {
    mode = 'agent'
    rest = rest.slice(1)
  } else if (rest[0] === 'observer') {
    mode = 'observer'
    rest = rest.slice(1)
  } else if (rest[0] === 'capabilities') {
    mode = 'capabilities'
    rest = rest.slice(1)
  }
  let specPath: string | null = null
  let outDir = '.'
  let stdout = false
  let force = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--out-dir' || a === '-o') outDir = rest[++i] ?? '.'
    else if (a === '--stdout') stdout = true
    else if (a === '--force' || a === '-f') force = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else if (!a.startsWith('-')) specPath = a
  }
  return { mode, specPath, outDir, stdout, force }
}

function printHelp(): void {
  process.stdout.write(
    [
      'wt-scaffold — emit a build-clean skeleton from a spec',
      '',
      'Usage:',
      '  wt:scaffold <spec.json> [--out-dir <dir>] [--stdout] [--force]           a .workflow.ts skeleton',
      '  wt:scaffold agent <spec.json> [--out-dir <dir>] [--stdout] [--force]     a least-privilege agentType .md',
      '  wt:scaffold observer <spec.json> [--out-dir <dir>] [--stdout] [--force]  a workflow-owned <name>.observer.json',
      '  wt:scaffold capabilities <spec.json> [--out-dir <dir>] [--stdout] [--force]  a workflow-owned <name>.capabilities.json',
      '',
      'Workflow spec: { "meta": { "name", "description" }, "steps": [ { "pattern", "phase" } ] }',
      `               pattern is one of: ${PATTERN_NAMES.join(', ')}`,
      'Agent spec:    { "name", "description", "prompt", "tools"?, "disallowedTools"?, "skills"?,',
      '                 "model"?, "effort"?, "nonGoals"? }  — `tools` is the capability fence.',
      'Observer spec: { "name", "description", "watch": { "roles"?, "phases"? }, "brain": { "mandate" },',
      '                 "cadenceMs"?, "emits"?, "actions"?, "requires"? }  — abstract needs only, no',
      '                 concrete tool/machine path (validated by @workflow-toolbox/debugger observer-def).',
      'Capabilities:  { "name", "roles": { <role>: { "agent", "needs": [ { "need" } ] } },',
      '                 "agents": { <agent>: { "description", "prompt", "tools": ["$cap:<need>", ...] } },',
      '                 "skillOverrides"?, "disableBundledSkills"? }  — `name` == the workflow meta.name;',
      '                 tools use $cap:<need> placeholders only, no concrete mcp__ tool or mcpServers.',
      '',
      '  --out-dir    directory to write the output into (default: current dir).',
      '  --stdout     print the source to stdout instead of writing a file.',
      '  --force      overwrite an existing output file (default: refuse).',
      '',
    ].join('\n') + '\n',
  )
}

/** The per-mode "next" hint — mode-specific and deliberately distinct from the published
 *  CLI's (this dev CLI points at the in-repo pnpm scripts). */
function nextHint(rendered: RenderedScaffold): string {
  if (rendered.mode === 'capabilities') {
    return capabilitiesLaunchHint(rendered.spec)
  }
  if (rendered.mode === 'observer') {
    return observerLaunchHint(rendered.spec)
  }
  if (rendered.mode === 'agent') {
    return (
      'Next — review the frontmatter fence, then register it as an agentType:\n' +
      `  put ${rendered.spec.name}.md under ~/.claude/agents/ (user) or .claude/agents/ (project),\n` +
      `  then reference it from a workflow via agent(prompt, { agentType: '${rendered.spec.name}' }).\n`
    )
  }
  return (
    'Next — fill in the placeholder prompts/data, then build and check:\n' +
    `  pnpm wt:build ${rendered.spec.meta.name}.workflow.ts\n` +
    `  pnpm wt:check workflows/${rendered.spec.meta.name}.js\n`
  )
}

function main(): number {
  const { mode, specPath, outDir, stdout, force } = parseArgs(process.argv.slice(2))
  if (specPath === null) {
    printHelp()
    process.stderr.write('wt-scaffold: missing <spec.json> argument.\n')
    return 1
  }

  let rendered: RenderedScaffold
  try {
    rendered = renderScaffold(mode, specPath)
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }

  let result: ScaffoldWriteResult
  try {
    result = writeScaffoldArtifact({ source: rendered.source, outName: rendered.outName, outDir, stdout, force })
  } catch {
    process.stderr.write(`wt-scaffold: cannot write "${path.join(outDir, rendered.outName)}".\n`)
    return 1
  }

  if (result.kind === 'stdout') return 0
  if (result.kind === 'refused') {
    process.stderr.write(`wt-scaffold: refusing to overwrite ${result.outFile} — pass --force to replace it.\n`)
    return 1
  }

  process.stdout.write(`wt-scaffold: wrote ${result.outFile}\n\n${nextHint(rendered)}`)
  return 0
}

process.exit(main())

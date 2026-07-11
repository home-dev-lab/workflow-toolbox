// CLI entry — IMPURE (reads a JSON spec, writes the .workflow.ts / agent .md). Held out of
// `pnpm test` (no .test.ts peer — the @workflow-toolbox/smoke + @workflow-toolbox/debugger convention);
// still typechecked by `tsc`. Maintainer/author:
//   pnpm wt:scaffold <spec.json> [--out-dir <dir>] [--stdout]          # a .workflow.ts skeleton
//   pnpm wt:scaffold agent <spec.json> [--out-dir <dir>] [--stdout]    # a least-privilege agentType .md

import * as fs from 'node:fs'
import * as path from 'node:path'
import { scaffoldAgent, scaffoldWorkflow, PATTERN_NAMES } from './scaffold.js'
import type { AgentScaffoldSpec, ScaffoldSpec } from './scaffold.js'
import { loadAgentSpec, loadSpec } from './spec-io.js'

type Mode = 'workflow' | 'agent'

interface CliArgs {
  mode: Mode
  specPath: string | null
  outDir: string
  stdout: boolean
  force: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let rest = argv
  let mode: Mode = 'workflow'
  if (rest[0] === 'agent') {
    mode = 'agent'
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
      '  wt:scaffold <spec.json> [--out-dir <dir>] [--stdout] [--force]         a .workflow.ts skeleton',
      '  wt:scaffold agent <spec.json> [--out-dir <dir>] [--stdout] [--force]   a least-privilege agentType .md',
      '',
      'Workflow spec: { "meta": { "name", "description" }, "steps": [ { "pattern", "phase" } ] }',
      `               pattern is one of: ${PATTERN_NAMES.join(', ')}`,
      'Agent spec:    { "name", "description", "prompt", "tools"?, "disallowedTools"?, "skills"?,',
      '                 "model"?, "effort"?, "nonGoals"? }  — `tools` is the capability fence.',
      '',
      '  --out-dir    directory to write the output into (default: current dir).',
      '  --stdout     print the source to stdout instead of writing a file.',
      '  --force      overwrite an existing output file (default: refuse).',
      '',
    ].join('\n') + '\n',
  )
}

function emit(mode: Mode, specPath: string): { source: string; outName: string; next: string } {
  if (mode === 'agent') {
    const spec: AgentScaffoldSpec = loadAgentSpec(specPath)
    return {
      source: scaffoldAgent(spec),
      outName: `${spec.name}.md`,
      next:
        'Next — review the frontmatter fence, then register it as an agentType:\n' +
        `  put ${spec.name}.md under ~/.claude/agents/ (user) or .claude/agents/ (project),\n` +
        `  then reference it from a workflow via agent(prompt, { agentType: '${spec.name}' }).\n`,
    }
  }
  const spec: ScaffoldSpec = loadSpec(specPath)
  return {
    source: scaffoldWorkflow(spec),
    outName: `${spec.meta.name}.workflow.ts`,
    next:
      'Next — fill in the placeholder prompts/data, then build and check:\n' +
      `  pnpm wt:build ${spec.meta.name}.workflow.ts\n` +
      `  pnpm wt:check workflows/${spec.meta.name}.js\n`,
  }
}

function main(): number {
  const { mode, specPath, outDir, stdout, force } = parseArgs(process.argv.slice(2))
  if (specPath === null) {
    printHelp()
    process.stderr.write('wt-scaffold: missing <spec.json> argument.\n')
    return 1
  }

  let source: string
  let outName: string
  let next: string
  try {
    ;({ source, outName, next } = emit(mode, specPath))
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }

  if (stdout) {
    process.stdout.write(source)
    return 0
  }

  const outFile = path.join(outDir, outName)
  if (fs.existsSync(path.resolve(outFile)) && !force) {
    process.stderr.write(`wt-scaffold: refusing to overwrite ${outFile} — pass --force to replace it.\n`)
    return 1
  }
  try {
    fs.mkdirSync(path.resolve(outDir), { recursive: true })
    fs.writeFileSync(path.resolve(outFile), source, 'utf8')
  } catch {
    process.stderr.write(`wt-scaffold: cannot write "${outFile}".\n`)
    return 1
  }

  process.stdout.write(`wt-scaffold: wrote ${outFile}\n\n${next}`)
  return 0
}

process.exit(main())

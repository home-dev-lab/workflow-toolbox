// CLI entry — IMPURE (reads a JSON spec, writes the .workflow.ts). Held out of `pnpm test`
// (no .test.ts peer — the @workflow-toolbox/smoke + @workflow-toolbox/debugger convention); still typechecked by `tsc`.
// Maintainer/author: `pnpm wt:scaffold <spec.json> [--out-dir <dir>] [--stdout]`.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { scaffoldWorkflow, PATTERN_NAMES } from './scaffold.js'
import type { ScaffoldSpec } from './scaffold.js'
import { loadSpec } from './spec-io.js'

interface CliArgs {
  specPath: string | null
  outDir: string
  stdout: boolean
  force: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let specPath: string | null = null
  let outDir = '.'
  let stdout = false
  let force = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--out-dir' || a === '-o') outDir = argv[++i] ?? '.'
    else if (a === '--stdout') stdout = true
    else if (a === '--force' || a === '-f') force = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else if (!a.startsWith('-')) specPath = a
  }
  return { specPath, outDir, stdout, force }
}

function printHelp(): void {
  process.stdout.write(
    [
      'wt-scaffold — emit a build-clean .workflow.ts skeleton from a spec',
      '',
      'Usage: wt:scaffold <spec.json> [--out-dir <dir>] [--stdout]',
      '',
      '  <spec.json>  a JSON file: { "meta": { "name", "description" }, "steps": [ { "pattern", "phase" } ] }',
      `               pattern is one of: ${PATTERN_NAMES.join(', ')}`,
      '  --out-dir    directory to write <name>.workflow.ts into (default: current dir).',
      '  --stdout     print the source to stdout instead of writing a file.',
      '  --force      overwrite an existing <name>.workflow.ts (default: refuse).',
      '',
    ].join('\n') + '\n',
  )
}

function main(): number {
  const { specPath, outDir, stdout, force } = parseArgs(process.argv.slice(2))
  if (specPath === null) {
    printHelp()
    process.stderr.write('wt-scaffold: missing <spec.json> argument.\n')
    return 1
  }

  let source: string
  let spec: ScaffoldSpec
  try {
    spec = loadSpec(specPath)
    source = scaffoldWorkflow(spec)
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }

  if (stdout) {
    process.stdout.write(source)
    return 0
  }

  const outFile = path.join(outDir, `${spec.meta.name}.workflow.ts`)
  if (fs.existsSync(path.resolve(outFile)) && !force) {
    process.stderr.write(
      `wt-scaffold: refusing to overwrite ${outFile} — pass --force to replace it.\n`,
    )
    return 1
  }
  try {
    fs.mkdirSync(path.resolve(outDir), { recursive: true })
    fs.writeFileSync(path.resolve(outFile), source, 'utf8')
  } catch {
    process.stderr.write(`wt-scaffold: cannot write "${outFile}".\n`)
    return 1
  }

  process.stdout.write(
    `wt-scaffold: wrote ${outFile}\n\n` +
      'Next — fill in the placeholder prompts/data, then build and check:\n' +
      `  pnpm wt:build ${outFile}\n` +
      `  pnpm wt:check workflows/${spec.meta.name}.js\n`,
  )
  return 0
}

process.exit(main())

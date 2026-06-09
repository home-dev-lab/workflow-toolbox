// CLI entry — IMPURE (reads a JSON spec, writes the .workflow.ts). Held out of `pnpm test`
// (no .test.ts peer — the @dwt/smoke + @dwt/debugger convention); still typechecked by `tsc`.
// Maintainer/author: `pnpm dwt:scaffold <spec.json> [--out-dir <dir>] [--stdout]`.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { scaffoldWorkflow, PATTERN_NAMES } from './scaffold.js'
import type { ScaffoldSpec } from './scaffold.js'

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
      'dwt-scaffold — emit a build-clean .workflow.ts skeleton from a spec',
      '',
      'Usage: dwt:scaffold <spec.json> [--out-dir <dir>] [--stdout]',
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

/** Narrow untrusted JSON to the spec shape, with an actionable message on the first defect. */
function assertSpecShape(x: unknown): asserts x is ScaffoldSpec {
  const fail = (msg: string): never => {
    throw new Error(`dwt-scaffold: ${msg}`)
  }
  if (typeof x !== 'object' || x === null) fail('spec must be a JSON object { meta, steps }.')
  const spec = x as Record<string, unknown>
  const meta = spec['meta']
  if (typeof meta !== 'object' || meta === null) fail('spec.meta must be an object with name + description.')
  const m = meta as Record<string, unknown>
  if (typeof m['name'] !== 'string' || typeof m['description'] !== 'string') {
    fail('spec.meta.name and spec.meta.description must both be strings.')
  }
  if (!Array.isArray(spec['steps'])) fail('spec.steps must be an array of { pattern, phase }.')
  for (const [i, step] of (spec['steps'] as unknown[]).entries()) {
    if (typeof step !== 'object' || step === null) fail(`spec.steps[${i}] must be an object { pattern, phase }.`)
    const s = step as Record<string, unknown>
    if (typeof s['pattern'] !== 'string' || typeof s['phase'] !== 'string') {
      fail(`spec.steps[${i}].pattern and .phase must both be strings.`)
    }
  }
}

function main(): number {
  const { specPath, outDir, stdout, force } = parseArgs(process.argv.slice(2))
  if (specPath === null) {
    printHelp()
    process.stderr.write('dwt-scaffold: missing <spec.json> argument.\n')
    return 1
  }

  let raw: string
  try {
    raw = fs.readFileSync(path.resolve(specPath), 'utf8')
  } catch {
    process.stderr.write(`dwt-scaffold: cannot read spec file "${specPath}".\n`)
    return 1
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(`dwt-scaffold: "${specPath}" is not valid JSON — ${(err as Error).message}.\n`)
    return 1
  }

  let source: string
  let spec: ScaffoldSpec
  try {
    assertSpecShape(parsed)
    spec = parsed
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
      `dwt-scaffold: refusing to overwrite ${outFile} — pass --force to replace it.\n`,
    )
    return 1
  }
  try {
    fs.mkdirSync(path.resolve(outDir), { recursive: true })
    fs.writeFileSync(path.resolve(outFile), source, 'utf8')
  } catch {
    process.stderr.write(`dwt-scaffold: cannot write "${outFile}".\n`)
    return 1
  }

  process.stdout.write(
    `dwt-scaffold: wrote ${outFile}\n\n` +
      'Next — fill in the placeholder prompts/data, then build and check:\n' +
      `  pnpm dwt:build ${outFile}\n` +
      `  pnpm dwt:check workflows/${spec.meta.name}.js\n`,
  )
  return 0
}

process.exit(main())

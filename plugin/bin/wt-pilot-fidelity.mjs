#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { freezeFidelityBundle, verifyFidelityBundle } from './lib/frozen-fidelity-bundle.mjs'

const HELP = `wt-pilot-fidelity — freeze and verify lane evidence for Main's fidelity review.

Usage:
  node wt-pilot-fidelity.mjs freeze --root <worktree> --out-dir <bundle-dir> \\
    --card <id> --session <id> --base <commit> --head <commit> --file <lane-path> [--file <lane-path> ...]
  node wt-pilot-fidelity.mjs verify --root <worktree> --dir <bundle-dir>

freeze copies the named lane files into a new immutable bundle and records their hashes plus the
current worktree identity. verify refuses changed, missing, extra, symlinked, escaped, or
identity-mismatched evidence. It validates bytes and identity only; it does not establish
independent authorship, prose truth, or resistance to a malicious same-user process.
`

function fail(message) { throw new Error(message) }

function value(argv, index, flag) {
  const result = argv[index + 1]
  if (!result || result.startsWith('--')) fail(`${flag} requires a value`)
  return result
}

function parse(argv) {
  handleHelpFlag(argv, HELP)
  const [command, ...rest] = argv
  if (command !== 'freeze' && command !== 'verify') fail("first argument must be 'freeze' or 'verify'")
  const args = { command, root: null, outDir: null, dir: null, card: null, session: null, base: null, head: null, files: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    if (flag === '--root') { args.root = value(rest, index, flag); index += 1 }
    else if (flag === '--out-dir') { args.outDir = value(rest, index, flag); index += 1 }
    else if (flag === '--dir') { args.dir = value(rest, index, flag); index += 1 }
    else if (flag === '--card') { args.card = value(rest, index, flag); index += 1 }
    else if (flag === '--session') { args.session = value(rest, index, flag); index += 1 }
    else if (flag === '--base') { args.base = value(rest, index, flag); index += 1 }
    else if (flag === '--head') { args.head = value(rest, index, flag); index += 1 }
    else if (flag === '--file') { args.files.push(value(rest, index, flag)); index += 1 }
    else fail(`unknown argument: ${flag}`)
  }
  if (!args.root) fail('--root is required')
  args.root = resolve(args.root)
  if (command === 'freeze') {
    if (!args.outDir || !args.card || !args.session || !args.base || !args.head || args.files.length === 0) {
      fail('freeze requires --out-dir, --card, --session, --base, --head, and at least one --file')
    }
    args.outDir = resolve(args.outDir)
  } else if (!args.dir) fail('verify requires --dir')
  else args.dir = resolve(args.dir)
  return args
}

function main() {
  const args = parse(process.argv.slice(2))
  if (!existsSync(args.root)) fail(`--root is not a directory: ${args.root}`)
  if (args.command === 'freeze') {
    const manifest = freezeFidelityBundle(args)
    process.stdout.write(`FROZEN card=${manifest.card} session=${manifest.session} files=${manifest.files.length} tree=${manifest.tree}\n`)
  } else {
    const manifest = verifyFidelityBundle(args)
    process.stdout.write(`VERIFIED card=${manifest.card} session=${manifest.session} files=${manifest.files.length} tree=${manifest.tree}\n`)
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`wt-pilot-fidelity: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { isInvokedDirectly } from '../../plugin/bin/lib/host/entry-guard.mjs'
import { LINT_SCOPE_DATA, LINT_SCOPE_EXCLUSIONS } from '../eslint.config.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const RATCHET_PASS = {
  gate: 'quality', name: 'ratchet', cwd: '.', maxWarnings: 685,
  targets: ['toolkit/packages/*/src/**/*.ts', 'plugin/**/*.mjs', 'plugin/**/*.js', 'plugin/**/*.{ts,mts,cts}',
    'plugins/wt-rules-on-demand/**/*.mjs', 'plugins/wt-rules-on-demand/**/*.js'],
}

// Gates execute these exact targets; the scope lock uses the same definitions.
export const GATE_PASSES = [
  { gate: 'lint', name: 'toolkit', cwd: 'toolkit', targets: ['.'] },
  {
    gate: 'lint', name: 'shipped-scripts', cwd: '.', quiet: true,
    targets: ['plugin/**/*.mjs', 'plugin/**/*.js', 'plugins/**/*.mjs', 'plugins/**/*.js',
      'probes/**/*.{mjs,js}', 'plugin/hooks/snapshot-cli'],
  },
  RATCHET_PASS,
  ...qualityAreaPasses(listTrackedFiles(ROOT)),
]

const DATA_EXTENSIONS = new Set(LINT_SCOPE_DATA.flatMap((group) => group.extensions ?? []))
const DATA_BASENAMES = new Set(LINT_SCOPE_DATA.flatMap((group) => group.basenames ?? []))

// Discover warning-count areas from tracked JavaScript, rather than maintaining a directory list.
export function qualityAreaPasses(files) {
  const ratchet = RATCHET_PASS.targets.map((glob) => globToRegExp(glob))
  const areas = new Set()
  for (const file of files) {
    if (!/^(plugins|probes)\/.*\.(mjs|js)$/.test(file) || ratchet.some((pattern) => pattern.test(file))) continue
    areas.add(file.startsWith('probes/') ? 'probes' : file.split('/').slice(0, 2).join('/'))
  }
  return [...areas].sort().map((area) => ({
    gate: 'quality', name: `area:${area}`, cwd: '.', targets: [`${area}/**/*.{mjs,js}`], warnOnly: true,
  }))
}

function unsupported(glob) {
  throw new Error(`Unsupported glob: ${glob}`)
}

// Only the CLI glob subset used above and by the config exclusions is accepted.
// Reject new syntax instead of guessing, and match POSIX git paths on every OS.
export function globToRegExp(glob) {
  let expression = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] !== '*') expression += '[^/]*'
      else {
        if (index > 0 && glob[index - 1] !== '/') unsupported(glob)
        index += 1
        if (glob[index + 1] === '/') { expression += '(?:[^/]+/)*'; index += 1 }
        else if (index === glob.length - 1) expression += '(?:[^/]+/)*[^/]*'
        else unsupported(glob)
      }
    } else if (char === '{') {
      const end = glob.indexOf('}', index)
      if (end < 0) unsupported(glob)
      const choices = glob.slice(index + 1, end).split(',')
      if (choices.length < 2 || choices.some((choice) => !/^[A-Za-z0-9_-]+$/.test(choice))) unsupported(glob)
      expression += `(?:${choices.join('|')})`
      index = end
    } else {
      if (!/^[A-Za-z0-9_./-]$/.test(char)) unsupported(glob)
      expression += char === '.' ? '\\.' : char
    }
  }
  return new RegExp(`^${expression}$`)
}

export async function classifyTrackedFiles(files, isLinted, exclusions) {
  const result = { covered: [], excluded: [], escaped: [] }
  const compiled = exclusions.map(({ glob, reason }) => {
    if (!reason?.trim()) throw new Error(`Lint scope exclusion needs a reason: ${glob}`)
    return { pattern: globToRegExp(glob), reason }
  })
  for (const file of files) {
    if (DATA_EXTENSIONS.has(extname(file).slice(1)) || DATA_BASENAMES.has(basename(file))) continue
    if (await isLinted(file)) result.covered.push(file)
    else {
      const exclusion = compiled.find(({ pattern }) => pattern.test(file))
      if (exclusion) result.excluded.push({ file, reason: exclusion.reason })
      else result.escaped.push(file)
    }
  }
  return result
}

export function makeTargetSelector(pass, target) {
  // ESLint's directory walks and glob selection both include dotfiles (dot:true).
  if (pass.cwd === 'toolkit' && target === '.') return (file) => file.startsWith('toolkit/')
  const pattern = globToRegExp(pass.cwd === 'toolkit' ? `toolkit/${target}` : target)
  return (file) => pattern.test(file)
}

export function makeIsLinted(root) {
  const checkers = GATE_PASSES.map((pass) => ({
    selects: pass.targets.map((target) => makeTargetSelector(pass, target)),
    eslint: new ESLint({ cwd: resolve(root, pass.cwd), overrideConfigFile: resolve(root, 'toolkit/eslint.config.mjs') }),
  }))
  return async (file) => {
    const absolute = resolve(root, file)
    for (const { selects, eslint } of checkers) {
      if (selects.some((select) => select(file))
        && !await eslint.isPathIgnored(absolute)
        && await eslint.calculateConfigForFile(absolute) !== undefined) return true
    }
    return false
  }
}

export function listTrackedFiles(root, run = spawnSync) {
  const result = run('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ls-files failed (${result.status}): ${result.stderr}`)
  const files = result.stdout.split('\0').filter(Boolean)
  if (!files.includes('toolkit/scripts/lint-scope.mjs')) throw new Error('git inventory missing required witness: toolkit/scripts/lint-scope.mjs')
  return files
}

export async function checkLintScope(root) {
  return classifyTrackedFiles(listTrackedFiles(root), makeIsLinted(root), LINT_SCOPE_EXCLUSIONS)
}

export function printLintScope(result, { list = false } = {}) {
  const { covered, excluded, escaped } = result
  process.stdout.write(`lint-scope: ${covered.length + excluded.length + escaped.length} source files, ${covered.length} covered, ${excluded.length} excluded, ${escaped.length} escaped\n`)
  if (list) {
    for (const file of covered) process.stdout.write(`covered: ${file}\n`)
    for (const { file, reason } of excluded) process.stdout.write(`excluded: ${file} — ${reason}\n`)
  }
  for (const file of escaped) process.stderr.write(`escaped: ${file}\n`)
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    if (process.argv.includes('--help')) process.stdout.write('usage: lint-scope.mjs [--list] [--root <repository>]\nChecks tracked source coverage in the repository (default: this checkout).\n')
    else {
      // A root override permits auditing another checkout; it changes no pass or exclusion policy.
      const index = process.argv.indexOf('--root')
      if (index !== -1 && !process.argv[index + 1]) throw new Error('--root requires a repository path')
      const result = await checkLintScope(index === -1 ? ROOT : resolve(process.argv[index + 1]))
      printLintScope(result, { list: process.argv.includes('--list') })
      process.exitCode = result.escaped.length ? 1 : 0
    }
  } catch (error) {
    process.stderr.write(`lint-scope: ${error.message}\n`)
    process.exitCode = 1
  }
}

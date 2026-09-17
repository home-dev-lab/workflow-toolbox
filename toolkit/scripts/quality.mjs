#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import sonarjs from 'eslint-plugin-sonarjs'

const TOOLKIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(TOOLKIT_ROOT, '..')
const BASELINE = join(TOOLKIT_ROOT, 'quality-baseline.json')
const COVERAGE = join(TOOLKIT_ROOT, '.lane/coverage/coverage-summary.json')
const TARGETS = ['toolkit/packages/*/src/**/*.ts', 'plugin/**/*.mjs', 'plugin/**/*.js']
const SOURCE_DIRS = [
  'packages/runtime/src', 'packages/patterns/src', 'packages/build/src', 'packages/std/src',
  'packages/pipeline-spec/src', 'packages/comm/src', 'packages/debugger/src',
  'packages/scaffold/src', 'packages/smoke/src', '../plugin',
]
const METRICS = [
  ['cyclomaticComplexity', 'Cyclomatic complexity', 'max'],
  ['cognitiveComplexity', 'Cognitive complexity', 'max'],
  ['fileLines', 'Biggest file (lines)', 'max'],
  ['functionLines', 'Longest function (lines)', 'max'],
  ['depth', 'Max depth', 'max'],
  ['params', 'Max params', 'max'],
  ['eslintWarnings', 'ESLint warnings', 'max'],
  ['duplication', 'Duplication %', 'max'],
  ['knipIssues', 'Knip issues', 'max'],
  ['dependencyCycles', 'Dependency cycles', 'max'],
  ['coverageLines', 'Coverage lines %', 'min'],
  ['coverageBranches', 'Coverage branches %', 'min'],
  ['coverageFunctions', 'Coverage functions %', 'min'],
  ['coverageStatements', 'Coverage statements %', 'min'],
]

function slash(path) {
  return path.split(sep).join('/')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: TOOLKIT_ROOT,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    ...options,
  })
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.error?.message}`)
  }
  return result.stdout
}

function pnpm(...args) {
  return run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, { allowFailure: true })
}

function issueCount(report) {
  return report.issues.reduce((total, issue) => total + Object.entries(issue)
    .filter(([key, value]) => key !== 'file' && Array.isArray(value))
    .reduce((sum, [, value]) => sum + value.length, 0), 0)
}

function topOffenders(items, limit = 20) {
  return [...items]
    .sort((a, b) => b.value - a.value || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
    .slice(0, limit)
}

function metric(value, offenders, detail = '') {
  return { value, file: offenders[0]?.file ?? '', function: offenders[0]?.function ?? '', detail, offenders }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
}

export function parseLint(results) {
  const rules = {
    complexity: ['cyclomaticComplexity', /complexity of (\d+)/i],
    'sonarjs/cognitive-complexity': ['cognitiveComplexity', /Cognitive Complexity from (\d+)/i],
    'max-lines': ['fileLines', /File has too many lines \((\d+)/],
    'max-lines-per-function': ['functionLines', /too many lines \((\d+)/],
    'max-depth': ['depth', /nested too deeply \((\d+)/],
    'max-params': ['params', /too many parameters \((\d+)/],
  }
  const found = Object.fromEntries(Object.values(rules).map(([name]) => [name, []]))
  for (const result of results) {
    const file = slash(relative(REPO_ROOT, result.filePath))
    for (const message of result.messages) {
      const rule = rules[message.ruleId]
      const match = rule && message.message.match(rule[1])
      if (!match) continue
      const functionMatch = message.message.match(/(?:Function|Async function|Arrow function) ['‘`]([^'’`]+)['’`]/)
      const sourceLine = result.source?.split(/\r?\n/)[message.line - 1] ?? ''
      const sourceFunction = sourceLine.match(/(?:function\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/)
      found[rule[0]].push({
        value: Number(match[1]), file, line: message.line,
        function: functionMatch?.[1] ?? sourceFunction?.[1] ?? '', exact: `${file}:${message.line} ${message.message}`,
      })
    }
  }
  return Object.fromEntries(Object.entries(found).map(([name, items]) => {
    const byFile = new Map()
    for (const item of items) {
      if (!byFile.has(item.file) || byFile.get(item.file).value < item.value) byFile.set(item.file, item)
    }
    const offenders = topOffenders([...byFile.values()])
    return [name, metric(offenders[0]?.value ?? 0, offenders)]
  }))
}

async function lintMetrics() {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: join(TOOLKIT_ROOT, 'eslint.config.mjs'),
    overrideConfig: {
      files: TARGETS,
      plugins: { sonarjs },
      rules: {
        complexity: ['warn', 0],
        'sonarjs/cognitive-complexity': ['warn', 0],
        'max-lines': ['warn', { max: 1, skipBlankLines: true, skipComments: true }],
        'max-lines-per-function': ['warn', { max: 1, skipBlankLines: true, skipComments: true }],
        'max-depth': ['warn', 0],
        'max-params': ['warn', 0],
      },
    },
  })
  const measured = await eslint.lintFiles(TARGETS)
  const parsed = parseLint(measured)
  const normal = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: join(TOOLKIT_ROOT, 'eslint.config.mjs') })
  const normalResults = await normal.lintFiles(TARGETS)
  const warnings = normalResults.reduce((sum, result) => sum + result.warningCount, 0)
  const byFile = normalResults
    .filter((result) => result.warningCount > 0)
    .map((result) => ({
      value: result.warningCount,
      file: slash(relative(REPO_ROOT, result.filePath)),
      exact: `${slash(relative(REPO_ROOT, result.filePath))}: ${result.warningCount} warning(s)`,
    }))
  parsed.eslintWarnings = metric(warnings, topOffenders(byFile), `${warnings} warnings`)
  return parsed
}

function readJscpd() {
  pnpm('exec', 'jscpd', ...SOURCE_DIRS, '--config', '.jscpd.json', '--reporters', 'json')
  const report = JSON.parse(readFileSync(join(TOOLKIT_ROOT, '.lane/jscpd/jscpd-report.json'), 'utf8'))
  const percentage = Number(report.statistics.total.percentage)
  const byFile = new Map()
  for (const duplicate of report.duplicates) {
    for (const side of [duplicate.firstFile, duplicate.secondFile]) {
      byFile.set(side.name, (byFile.get(side.name) ?? 0) + duplicate.lines)
    }
  }
  const offenders = topOffenders([...byFile].map(([file, lines]) => ({
    value: lines,
    file: /^(?:bin|skills|hooks|workflows|agents|monitors)\//.test(slash(file)) ? `plugin/${slash(file)}` : slash(file),
    exact: `${slash(file)}: ${lines} duplicated line occurrences`,
  })))
  return metric(percentage, offenders, `${report.statistics.total.duplicatedLines} duplicated lines`)
}

function readKnip() {
  const executable = join(TOOLKIT_ROOT, 'node_modules/knip/bin/knip.js')
  const report = JSON.parse(run(process.execPath, [
    executable, '--config', 'knip.json', '--reporter', 'json', '--max-issues', '999999',
  ], { cwd: REPO_ROOT, allowFailure: true }))
  const offenders = topOffenders(report.issues.map((entry) => ({
    value: issueCount({ issues: [entry] }), file: slash(entry.file),
    exact: `${slash(entry.file)}: ${issueCount({ issues: [entry] })} issue(s)`,
  })))
  return metric(issueCount(report), offenders)
}

function readCycles() {
  const report = JSON.parse(pnpm('exec', 'depcruise', ...SOURCE_DIRS, '--config', '.dependency-cruiser.cjs', '--output-type', 'json'))
  const cycles = report.summary.violations.filter((violation) => violation.type === 'cycle')
  const offenders = cycles.map((cycle) => ({ value: 1, file: slash(join('toolkit', cycle.from)), exact: `${cycle.from} -> ${cycle.to}` }))
  return metric(cycles.length, offenders)
}

function readCoverage() {
  if (!existsSync(COVERAGE)) throw new Error(`Missing ${relative(TOOLKIT_ROOT, COVERAGE)}; run pnpm quality:coverage first`)
  const report = JSON.parse(readFileSync(COVERAGE, 'utf8'))
  const names = ['lines', 'branches', 'functions', 'statements']
  return Object.fromEntries(names.map((name) => {
    const offenders = Object.entries(report)
      .filter(([file]) => file !== 'total')
      .map(([file, coverage]) => ({
        value: Number(coverage[name].pct), file: slash(relative(REPO_ROOT, file)),
        exact: `${slash(relative(REPO_ROOT, file))}: ${name} ${coverage[name].pct}%`,
      }))
      .sort((a, b) => a.value - b.value || a.file.localeCompare(b.file))
      .slice(0, 20)
    return [`coverage${name[0].toUpperCase()}${name.slice(1)}`, metric(Number(report.total[name].pct), offenders)]
  }))
}

export async function measure() {
  return {
    ...(await lintMetrics()),
    duplication: readJscpd(),
    knipIssues: readKnip(),
    dependencyCycles: readCycles(),
    ...readCoverage(),
  }
}

export function renderDelta(before, after, touched = []) {
  const touchedSet = new Set(touched.map(slash))
  const rows = ['| Judge | Total before -> after | Delta | Touched files before -> after | Resorbed files |', '|---|---:|---:|---:|---|']
  for (const [key, label, direction] of METRICS) {
    const oldValue = before.metrics[key].value
    const newValue = after[key].value
    const delta = Number((newValue - oldValue).toFixed(2))
    const oldTouched = before.metrics[key].offenders.filter((item) => touchedSet.has(item.file))
    const newByFile = new Map(after[key].offenders.map((item) => [item.file, item.value]))
    const newTouched = after[key].offenders.filter((item) => touchedSet.has(item.file))
    const oldWorst = oldTouched[0]?.value ?? '-'
    const newWorst = newTouched[0]?.value ?? '-'
    const resorbed = oldTouched.filter((item) => {
      const now = newByFile.get(item.file)
      return now !== undefined && (direction === 'min' ? now > item.value : now < item.value)
    }).map((item) => item.file)
    rows.push(`| ${label} | ${oldValue} -> ${newValue} | ${delta > 0 ? '+' : ''}${delta} | ${oldWorst} -> ${newWorst} | ${resorbed.join(', ') || '-'} |`)
  }
  return rows.join('\n')
}

function latestTag() {
  return run('git', ['tag', '--list', 'workflow-toolbox--v*', '--sort=-v:refname'], { cwd: REPO_ROOT }).trim().split('\n')[0]
}

function baselineAt(ref) {
  const result = spawnSync('git', ['show', `${ref}:toolkit/quality-baseline.json`], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.status === 0) return JSON.parse(result.stdout)
  const local = JSON.parse(readFileSync(BASELINE, 'utf8'))
  if (local.releaseTag === ref) return local
  throw new Error(`No quality-baseline.json at ${ref}; run pnpm quality:baseline for that release`)
}

function changedFiles(ref) {
  return run('git', ['diff', '--name-only', `${ref}...HEAD`], { cwd: REPO_ROOT }).trim().split('\n').filter(Boolean)
}

export function debtCards(baseline, top = 5) {
  return METRICS.flatMap(([key, label]) => baseline.metrics[key].offenders.slice(0, top).map((offender) => ({
    id: `${offender.file}:${key}`,
    title: `debt: ${offender.file} — ${label.toLowerCase()} ${offender.value} (ratchet ${baseline.metrics[key].value})`,
    description: offender.exact,
    labels: ['tooling', 'chore'],
    priority: offender.file.startsWith('plugin/bin/') ? 'P1' : 'P2',
  })))
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'baseline') {
    const metrics = await measure()
    const baseline = { releaseTag: latestTag(), metrics }
    writeFileSync(BASELINE, `${JSON.stringify(sortKeys(baseline), null, 2)}\n`)
    console.log(`Wrote ${relative(TOOLKIT_ROOT, BASELINE)}`)
    return
  }
  if (command === 'delta') {
    const sinceIndex = args.indexOf('--since')
    const ref = sinceIndex >= 0 ? args[sinceIndex + 1] : latestTag()
    console.log(renderDelta(baselineAt(ref), await measure(), changedFiles(ref)))
    return
  }
  if (command === 'debt-cards') {
    const formatIndex = args.indexOf('--format')
    const format = formatIndex >= 0 ? args[formatIndex + 1] : 'markdown'
    const topIndex = args.indexOf('--top')
    const cards = debtCards(JSON.parse(readFileSync(BASELINE, 'utf8')), topIndex >= 0 ? Number(args[topIndex + 1]) : 5)
    if (format === 'json') console.log(JSON.stringify(cards, null, 2))
    else for (const card of cards) console.log(`### ${card.title}\n\n${card.description}\n\nLabels: ${card.labels.join(', ')} | Priority: ${card.priority}\n`)
    return
  }
  throw new Error('Usage: quality.mjs baseline | delta [--since <git-ref>] | debt-cards [--top N] [--format markdown|json]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = process.argv[2] === 'delta' ? 0 : 1
  })
}

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RULE_MANIFEST_VERSION = 1
export const RULE_RECIPIENTS = Object.freeze(['pilot', 'orchestrator', 'critic', 'tdd', 'review', 'refutation'])
export const RULE_TRIGGERS = Object.freeze([
  'standing',
  ...['discovery', 'plan', 'critic', 'tdd', 'verify', 'review', 'refutation', 'report'].map((phase) => `phase:${phase}`),
  ...['critic', 'tdd', 'review', 'refutation'].map((role) => `lane:${role}`),
  'critic->plan',
])

const recipientSet = new Set(RULE_RECIPIENTS)
const triggerSet = new Set(RULE_TRIGGERS)
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function entryName(level, index, entry) {
  return `${level} entry ${index + 1}${entry?.source && entry?.heading ? ` (${entry.source} :: ${entry.heading})` : ''}`
}

function fail(name, problem) {
  throw new Error(`rules manifest invalid: ${name}: ${problem}`)
}

function readSection(source, heading, name) {
  const headingLevel = /^(#{1,6}) /.exec(heading)?.[1].length
  if (!headingLevel) fail(name, 'heading must be exact Markdown heading text')
  const lines = [...source.matchAll(/[^\n]*(?:\n|$)/g)].filter((match) => match[0] !== '')
  const start = lines.findIndex((match) => match[0].replace(/\r?\n$/, '') === heading)
  if (start < 0) fail(name, `heading does not exist: ${heading}`)
  let end = source.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const candidate = /^(#{1,6}) /.exec(lines[i][0])
    if (candidate && candidate[1].length <= headingLevel) {
      end = lines[i].index
      break
    }
  }
  return source.slice(lines[start].index, end)
}

export function validateRulesManifest(manifest, { root, level = 'manifest' }) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail(level, 'top level must be an object')
  const keys = Object.keys(manifest)
  if (keys.some((key) => !['$schema', 'version', 'entries'].includes(key))) fail(level, 'unknown top-level property')
  if (manifest.version !== RULE_MANIFEST_VERSION) fail(level, `version must be ${RULE_MANIFEST_VERSION}`)
  if (!Array.isArray(manifest.entries)) fail(level, 'entries must be an array')
  const resolvedRoot = fs.realpathSync(root)
  const seen = new Set()
  return manifest.entries.map((entry, index) => {
    const name = entryName(level, index, entry)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(name, 'entry must be an object')
    const entryKeys = Object.keys(entry)
    if (entryKeys.some((key) => !['source', 'heading', 'recipients', 'triggers'].includes(key))) fail(name, 'unknown entry property')
    if (typeof entry.source !== 'string' || !entry.source || path.posix.isAbsolute(entry.source) || path.win32.isAbsolute(entry.source) || entry.source.includes('\\') || entry.source.split('/').some((part) => part === '.' || part === '..' || !part)) {
      fail(name, 'source must be a portable relative path')
    }
    if (typeof entry.heading !== 'string' || !/^#{1,6} [^\r\n]+$/.test(entry.heading)) fail(name, 'heading must be exact Markdown heading text')
    for (const [field, allowed] of [['recipients', recipientSet], ['triggers', triggerSet]]) {
      if (!Array.isArray(entry[field]) || entry[field].length === 0 || new Set(entry[field]).size !== entry[field].length) fail(name, `${field} must be a non-empty unique array`)
      for (const value of entry[field]) if (typeof value !== 'string' || !allowed.has(value)) fail(name, `unknown ${field === 'recipients' ? 'role' : 'phase/trigger'}: ${String(value)}`)
    }
    const identity = `${entry.source}\0${entry.heading}\0${entry.recipients.join(',')}\0${entry.triggers.join(',')}`
    if (seen.has(identity)) fail(name, 'duplicate entry')
    seen.add(identity)
    const sourcePath = path.resolve(resolvedRoot, ...entry.source.split('/'))
    let realSource
    try { realSource = fs.realpathSync(sourcePath) } catch { fail(name, `source does not exist: ${entry.source}`) }
    const relative = path.relative(resolvedRoot, realSource)
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail(name, `source escapes manifest root: ${entry.source}`)
    let source
    try { source = fs.readFileSync(realSource, 'utf8') } catch { fail(name, `source is not readable: ${entry.source}`) }
    return Object.freeze({ ...entry, level, section: readSection(source, entry.heading, name) })
  })
}

function readManifest(file, root, level, required) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`rules manifest missing: ${file}`)
    return []
  }
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { throw new Error(`rules manifest invalid: ${level}: ${error.message}`) }
  return validateRulesManifest(manifest, { root, level })
}

export function loadRules({ projectRoot, shippedRoot = pluginRoot } = {}) {
  const shipped = readManifest(path.join(shippedRoot, 'rules-manifest.json'), shippedRoot, 'shipped', true)
  const project = projectRoot
    ? readManifest(path.join(projectRoot, '.claude', 'wt-rules-manifest.json'), projectRoot, 'project', false)
    : []
  return Object.freeze([...shipped, ...project])
}

export function composeRules(rules, { recipient, trigger, triggers = [trigger] }) {
  const selected = rules.filter((entry) => entry.recipients.includes(recipient) && triggers.some((candidate) => entry.triggers.includes(candidate)))
  if (selected.length === 0) return ''
  return selected.map((entry) => `<!-- BEGIN authoritative rule: ${entry.level}:${entry.source} :: ${entry.heading} -->\n${entry.section}<!-- END authoritative rule: ${entry.level}:${entry.source} :: ${entry.heading} -->`).join('\n\n')
}

export function composeStandingPrompt(contract, rules) {
  const standing = composeRules(rules, { recipient: 'pilot', trigger: 'standing' })
  return standing ? `${contract}${contract.endsWith('\n') ? '\n' : '\n\n'}## Standing rules (authoritative)\n\n${standing}\n` : contract
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONSENT_KEY = 'WT_EXECUTOR_LANE_CONSENT'

function homeDir(env) {
  return env.HOME || os.homedir()
}

export function resolveConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(homeDir(env), '.claude')
}

function readJsonFile(filePath) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing', filePath }
    }
    return { kind: 'unreadable', filePath, detail: error instanceof Error ? error.message : String(error) }
  }
  try {
    return { kind: 'ok', filePath, value: JSON.parse(raw) }
  } catch (error) {
    return { kind: 'invalid', filePath, detail: error instanceof Error ? error.message : String(error) }
  }
}

function ownEnvValue(json) {
  if (!json || typeof json !== 'object') return { present: false, isTrue: false }
  const envBlock = json.env
  if (!envBlock || typeof envBlock !== 'object') return { present: false, isTrue: false }
  if (!Object.prototype.hasOwnProperty.call(envBlock, CONSENT_KEY)) return { present: false, isTrue: false }
  return { present: true, isTrue: envBlock[CONSENT_KEY] === 'true' }
}

function evaluateSettingsFile(filePath) {
  const read = readJsonFile(filePath)
  if (read.kind === 'missing') return { filePath, state: 'missing', source: 'missing' }
  if (read.kind === 'unreadable') return { filePath, state: 'unknown', source: 'unreadable', detail: read.detail }
  if (read.kind === 'invalid') return { filePath, state: 'unknown', source: 'invalid', detail: read.detail }
  const env = ownEnvValue(read.value)
  if (!env.present) return { filePath, state: 'missing', source: 'missing' }
  return { filePath, state: env.isTrue ? 'true' : 'not_true', source: env.isTrue ? 'true' : 'not_true' }
}

export const LANE_CONSENT_KEY = CONSENT_KEY

export function resolveConsent(projectDir, env = process.env) {
  const configDir = resolveConfigDir(env)
  const account = evaluateSettingsFile(path.join(configDir, 'settings.json'))
  const project = evaluateSettingsFile(path.join(projectDir, '.claude', 'settings.local.json'))

  if (account.state === 'unknown' || project.state === 'unknown') {
    return { outcome: 'unknown', account, project }
  }

  const accountAllows = account.state === 'true'
  const projectNarrows = project.state === 'not_true'
  const consented = accountAllows && !projectNarrows
  return { outcome: consented ? 'true' : 'not_true', account, project }
}

function dirMarkdownFiles(dirPath) {
  let entries
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing', dirPath, files: [] }
    }
    return { kind: 'unreadable', dirPath, files: [], detail: error instanceof Error ? error.message : String(error) }
  }
  return {
    kind: 'ok',
    dirPath,
    files: entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => path.join(dirPath, entry.name)).sort(),
  }
}

function detectLaneDefaultMeaning(text) {
  const reasons = []
  if (/heavy implementation increment[^\n]{0,160}(?:executor lane|cheaper lane)/i.test(text)) {
    reasons.push('heavy-increment routing')
  }
  if (/standing default|by default|default route/i.test(text) && /(executor lane|cheaper lane|cheaper executor)/i.test(text)) {
    reasons.push('default-routing wording')
  }
  if (/heavy mechanical work goes down to a cheaper executor/i.test(text)) {
    reasons.push('heavy-work downrouting')
  }
  const defaultCues = [
    /\bby default\b/gi,
    /\bdefault route\b/gi,
    /\bstanding default\b/gi,
    /\bas a default\b/gi,
    /\bdefaults to\b/gi,
    /\bpar d[eé]faut\b/gi,
  ]
  const laneCues = [
    /\bexecutor lane\b/gi,
    /\bcheaper lane\b/gi,
    /\bcheaper executor\b/gi,
    /\bexternal lane\b/gi,
    /\bGPT lane\b/gi,
    /\blane GPT\b/gi,
    /\blane externe\b/gi,
    /\blane ex[ée]cuteur\b/gi,
    /\bex[ée]cuteur externe\b/gi,
  ]
  const cuePositions = (cues) => cues.flatMap((cue) => [...text.matchAll(cue)].map((match) => match.index))
  const withinDefaultWindow = (positions) => cuePositions(defaultCues).some((defaultPosition) => positions.some((position) => Math.abs(defaultPosition - position) <= 200))
  if (withinDefaultWindow(cuePositions(laneCues)) || withinDefaultWindow(cuePositions([new RegExp(CONSENT_KEY, 'gi')]))) {
    reasons.push('default-routing cues')
  }
  return {
    matches: reasons.includes('heavy-increment routing') || reasons.includes('default-routing wording') || reasons.includes('default-routing cues'),
    reasons,
  }
}

function inspectRuleFile(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    return { filePath, kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) }
  }
  const meaning = detectLaneDefaultMeaning(text)
  return { filePath, kind: 'ok', declaresLaneDefault: meaning.matches, reasons: meaning.reasons }
}

function inspectAutoLoadedRules(projectDir, env) {
  const configDir = resolveConfigDir(env)
  const dirs = [
    path.join(configDir, 'rules'),
    path.join(projectDir, '.claude', 'rules'),
  ]
  const matches = []
  const unknown = []
  for (const dirPath of dirs) {
    const dir = dirMarkdownFiles(dirPath)
    if (dir.kind === 'unreadable') {
      unknown.push({ path: dirPath, kind: 'dir', detail: dir.detail })
      continue
    }
    if (dir.kind === 'missing') continue
    for (const filePath of dir.files) {
      const file = inspectRuleFile(filePath)
      if (file.kind === 'unreadable') {
        unknown.push({ path: filePath, kind: 'file', detail: file.detail })
        continue
      }
      if (file.declaresLaneDefault) matches.push(file)
    }
  }
  return { matches, unknown }
}

function describeSettingsSide(consent) {
  const account =
    consent.account.state === 'unknown'
      ? 'UNKNOWN'
      : consent.account.state === 'true'
        ? 'permits the lane'
        : consent.account.state === 'missing'
          ? 'absent'
          : 'present but non-consenting'
  const project =
    consent.project.state === 'unknown'
      ? 'UNKNOWN'
      : consent.project.state === 'true'
        ? 'permits the lane'
        : consent.project.state === 'missing'
          ? 'absent'
          : 'present but narrowing'
  return [
    `Consent chain for ${CONSENT_KEY}:`,
    `- account settings ${consent.account.filePath}: ${account}`,
    `- project settings ${consent.project.filePath}: ${project}`,
  ].join('\n')
}

export function analyzeLaneConsent(projectDir, env = process.env) {
  const rules = inspectAutoLoadedRules(projectDir, env)
  if (rules.unknown.length > 0) {
    return {
      status: 'unknown',
      exitCode: 2,
      message: [
        'UNKNOWN: could not inspect all auto-loaded rule inputs for the executor-lane default check.',
        ...rules.unknown.map((item) => `- ${item.kind} ${item.path}: unreadable`),
      ].join('\n'),
      rules,
      consent: null,
    }
  }
  if (rules.matches.length === 0) {
    return { status: 'silent', exitCode: 0, message: '', rules, consent: null }
  }

  const consent = resolveConsent(projectDir, env)
  if (consent.outcome === 'unknown') {
    return {
      status: 'unknown',
      exitCode: 2,
      message: [
        `UNKNOWN: auto-loaded rules declare the executor lane as a default route, but the consent chain for ${CONSENT_KEY} could not be resolved.`,
        `Rule side: ${rules.matches.map((match) => match.filePath).join(', ')}`,
        describeSettingsSide(consent),
      ].join('\n'),
      rules,
      consent,
    }
  }
  if (consent.outcome === 'true') {
    return { status: 'silent', exitCode: 0, message: '', rules, consent }
  }
  return {
    status: 'mismatch',
    exitCode: 1,
    message: [
      `DISAGREEMENT: auto-loaded rules declare the executor lane as a default route while ${CONSENT_KEY} is not consented.`,
      `Rule side: ${rules.matches.map((match) => match.filePath).join(', ')}`,
      describeSettingsSide(consent),
      // A warning with no way to end it fires every session and gets switched off, taking its
      // real case with it. Both exits are named because the honest answer is sometimes "no".
      // ⚠ Do NOT write the literal consent value here, even as instructional text: a lock
      // forbids that string in this output as a proxy for "no environment value ever leaks".
      // The proxy is strict on purpose — reword the sentence, never relax the lock.
      `To settle it: set ${CONSENT_KEY} in the settings env block to the consented value if the lane is wanted here, or reword the rule if it is not. Either one silences this.`,
    ].join('\n'),
    rules,
    consent,
  }
}

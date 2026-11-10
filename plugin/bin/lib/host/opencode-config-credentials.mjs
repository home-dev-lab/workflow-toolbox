import { parseJsonc } from './jsonc.mjs'

const CONTENT_KEYS = new Set(['prompt', 'template', 'instructions'])

const skippedLine = (text, start) => /^\s*\/\//.test(text.slice(text.lastIndexOf('\n', start - 1) + 1, start))

const expandConfigEnvironment = (value, env) => typeof value === 'string' ? value.replace(/\{env:([^}]+)\}/g, (_token, name) => env[name] ?? '') : null

function validatedModel(effective, required) {
  if (effective == null) return null
  const resolved = typeof effective === 'string' && !effective.includes('{env:') && /^[^/\s{}]+\/.+/.test(effective)
  if (required && !resolved) throw new Error('effective model is unresolvable with credential file references; pass --model provider/model or use WT_LANE_SANDBOX=off as the only bypass')
  return resolved ? effective : null
}

export function resolveConfigModel(model, env, required = false) {
  if (model == null) return null
  return validatedModel(expandConfigEnvironment(model, env) ?? '', required)
}

function configuredModel(configs, env) {
  let model
  for (const config of configs) {
    const parsed = parseJsonc(expandConfigEnvironment(config.text, env))
    if (parsed === null) model = ''
    else if (Object.hasOwn(parsed, 'model')) model = parsed.model ?? ''
  }
  return model
}

// OpenCode expands env over the whole text, then substitutes files except on //-prefixed
// lines. Keep raw offsets separately: overlays must never contain expanded env values.
function fileTokens(text) {
  const strings = stringRanges(text)
  return [...text.matchAll(/\{file:([^}]+)\}/g)].flatMap((match) => {
    const start = match.index
    if (skippedLine(text, start)) return []
    if (match[1].includes('{env:')) throw new Error('environment-dependent {file:} path is not allowed in a lane')
    return [{ raw: match[1], start, end: start + match[0].length, quoted: strings.some(([from, to]) => start > from && start < to) }]
  })
}

function stringRanges(text) {
  const ranges = []
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text.startsWith('//', cursor)) {
      const end = text.indexOf('\n', cursor + 2)
      cursor = end < 0 ? text.length : end
    } else if (text.startsWith('/*', cursor)) {
      const end = text.indexOf('*/', cursor + 2)
      cursor = end < 0 ? text.length : end + 1
    } else if (text[cursor] === '"') {
      const start = cursor++
      while (cursor < text.length && text[cursor] !== '"') cursor += text[cursor] === '\\' ? 2 : 1
      ranges.push([start, cursor])
    }
  }
  return ranges
}

function replaceTokens(text, references, replacement) {
  let result = ''; let cursor = 0
  for (const reference of references) {
    result += text.slice(cursor, reference.start) + replacement(reference)
    cursor = reference.end
  }
  return result + text.slice(cursor)
}

function valueLocations(value, keys, locations) {
  if (typeof value === 'string') locations.push({ value, keys })
  else if (Array.isArray(value)) {
    const arrayKeys = keys.at(-1) === 'instructions' ? keys : [...keys, null]
    for (const child of value) valueLocations(child, arrayKeys, locations)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) valueLocations(child, [...keys, key], locations)
  }
}

function referenceLocation(reference, locations) {
  const keys = locations.find(({ value }) => value.includes(reference.marker))?.keys ?? []
  const content = CONTENT_KEYS.has(keys.at(-1)) && !keys.some((key) => key === 'provider' || key === 'mcp')
  return { ...reference, kind: content ? 'content' : 'credential', provider: keys[0] === 'provider' ? keys[1] ?? null : null }
}

// Compare against every decoded literal, including values hidden by duplicate keys. Raw
// source alone cannot exclude a marker spelled with JSON Unicode escapes.
function referenceMarkerPrefix(text, references) {
  const blanked = replaceTokens(text, references, (reference) => reference.quoted ? '' : '""')
  const literals = stringRanges(blanked).map(([start, end]) => {
    try { return JSON.parse(blanked.slice(start, end + 1)) }
    catch { return '' }
  })
  let prefix = '__wt_file_reference_'
  while (text.includes(prefix) || literals.some((value) => value.includes(prefix))) prefix += '_'
  return prefix
}

export function classifyConfigReferences(text, env = {}, file = 'global OpenCode config') {
  const rawTokens = fileTokens(text)
  const expanded = expandConfigEnvironment(text, env)
  const tokens = fileTokens(expanded)
  if (rawTokens.length !== tokens.length || rawTokens.some((token, index) => token.raw !== tokens[index].raw)) throw new Error(`environment substitution changes the {file:} references of ${file}`)
  const prefix = referenceMarkerPrefix(expanded, tokens)
  const references = tokens.map((reference, index) => ({ ...reference, marker: `${prefix}${index}__` }))
  const marked = replaceTokens(expanded, references, (reference) => reference.quoted ? reference.marker : JSON.stringify(reference.marker))
  const locations = []
  valueLocations(parseJsonc(marked), [], locations)
  return references.map((reference, index) => ({ ...referenceLocation(reference, locations), ...rawTokens[index] }))
}

/** @knipTestSeam Token-context unit locks in opencode-config-credentials.test.ts. */
export function sanitizeConfigReferences(text, references, remove = () => true) {
  const kept = []
  const sanitized = replaceTokens(text, references, (reference) => {
    if (!remove(reference)) {
      kept.push(reference)
      return text.slice(reference.start, reference.end)
    }
    return reference.quoted ? '' : '""'
  })
  if (parseJsonc(sanitized) === null) throw new Error('sanitized global OpenCode config does not parse as JSONC')
  return { text: sanitized, kept }
}

function credentialPredicate(references) {
  const credentials = references.filter((reference) => reference.kind === 'credential')
  const targets = new Set(credentials.map((reference) => reference.target))
  const identities = new Set(credentials.map((reference) => reference.identity).filter((identity) => identity != null))
  return (reference) => targets.has(reference.target) || (reference.identity != null && identities.has(reference.identity))
}

function refuseOwnProvider(configs, model, isCredential) {
  const provider = model?.slice(0, model.indexOf('/'))
  for (const config of configs) {
    const own = config.references.find((reference) => isCredential(reference) && provider != null && reference.provider === provider)
    if (own) throw new Error(`model ${model} in ${config.file} references credential ${own.target}; a lane never gets an API key file; WT_LANE_SANDBOX=off is the only bypass`)
  }
}

function refuseSanitizedReference(file, raw) {
  throw new Error(`sanitized config ${file} still references ${raw}; a lane never gets an API key file; WT_LANE_SANDBOX=off is the only bypass`)
}

// Removing tokens can join fragments into new substitutions in either consumer view.
function validateSanitizedInventory(text, kept, env, file) {
  for (const view of [text, expandConfigEnvironment(text, env)]) {
    const tokens = fileTokens(view)
    const unexpected = tokens.find((token, index) => token.raw !== kept[index]?.raw)
    if (unexpected) refuseSanitizedReference(file, unexpected.raw)
    if (tokens.length !== kept.length) refuseSanitizedReference(file, kept[tokens.length].raw)
  }
  const credential = classifyConfigReferences(text, env, file).find((reference) => reference.kind !== 'content')
  if (credential) refuseSanitizedReference(file, credential.raw)
}

function sanitizedCopy(config, isCredential, env) {
  if (!config.references.some(isCredential)) return []
  const { text, kept } = sanitizeConfigReferences(config.text, config.references, isCredential)
  validateSanitizedInventory(text, kept, env, config.file)
  return [{ inside: config.file, text }]
}

export function planCredentialReferences(configs, model, env = {}) {
  const references = configs.flatMap((config) => config.references)
  const isCredential = credentialPredicate(references)
  const credentials = references.filter(isCredential)
  const effective = model == null ? validatedModel(configuredModel(configs, env), credentials.length > 0) : resolveConfigModel(model, env, credentials.length > 0)
  refuseOwnProvider(configs, effective, isCredential)
  const withheld = [...new Set(credentials.filter((reference) => reference.exists !== false).map((reference) => reference.target))]
  const missing = [...new Set(credentials.filter((reference) => reference.exists === false).map((reference) => reference.target))]
  const copies = configs.flatMap((config) => sanitizedCopy(config, isCredential, env))
  return { withheld, missing, copies, readable: [...new Set(references.filter((reference) => reference.exists !== false && !isCredential(reference)).map((reference) => reference.expanded))] }
}

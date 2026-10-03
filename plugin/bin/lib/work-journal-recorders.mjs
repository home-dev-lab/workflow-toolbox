import path from 'node:path'
import { commandHeads } from './command-invocation.mjs'
import { parseGitCommands } from './git-push.mjs'
import * as io from './host/work-journal-io.mjs'
import { sha256 } from './work-journal-paths.mjs'
import { resolveBoardPointer } from './board-http-client.mjs'

const GIT_ACTS = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'pull'])
const BUILTIN_KINDS = ['git', 'push', 'release', 'pr', 'done']
const FAMILIES = /^(?:Bash|mcp__.*)$/

// String-only rejection precedes manifests, journal reads and Git spawns.
export function observableTool(input) { return typeof input.tool_name === 'string' && FAMILIES.test(input.tool_name) }
function validateToolPattern(pattern) {
  if (typeof pattern !== 'string') throw new Error('unobservable tool matcher: missing tool regex')
  const branches = pattern.replace(/^\^/, '').replace(/\$$/, '').split('|')
  if (!branches.every((branch) => branch === 'Bash' || /^mcp__[a-zA-Z0-9_.*$^+?\[\]\\-]+$/.test(branch))) throw new Error(`unobservable tool matcher: ${pattern}`)
  return new RegExp(pattern)
}
function validateRecorder(recorder) {
  if (!recorder || !/^[a-z][a-z0-9-]{0,31}$/.test(recorder.id || '')) throw new Error('invalid recorder id')
  if (![...BUILTIN_KINDS, 'tool'].includes(recorder.kind)) throw new Error(`invalid recorder ${recorder.id}`)
  const actors = recorder.actors || ['main']
  if (!Array.isArray(actors) || !actors.length || actors.some((actor) => !['main', 'subagent', 'unknown'].includes(actor))) throw new Error(`invalid actors for ${recorder.id}`)
  if (recorder.kind === 'tool') {
    validateToolPattern(recorder.tool)
    if (recorder.command) new RegExp(recorder.command)
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(recorder.tag || '') || !recorder.sentence || !recorder.link) throw new Error(`invalid tool recorder ${recorder.id}`)
  }
  return { ...recorder, actors }
}
export function loadRecorders(root) {
  const defaults = io.json(new URL('../../config/work-journal-recorders.json', import.meta.url))
  const warnings = []
  let manifest = {}
  try {
    manifest = io.json(path.join(root, '.claude', 'work-journal.json')) || {}
    if (!Array.isArray(manifest.recorders || []) || !Array.isArray(manifest.disable || []) || !Array.isArray(manifest.outward || [])) throw new Error('invalid recorder manifest arrays')
    for (const recorder of manifest.recorders || []) validateRecorder(recorder)
    for (const matcher of manifest.outward || []) validateToolPattern(matcher.tool)
  } catch (error) { warnings.push(`invalid work-journal manifest: ${error.message}; using defaults`); manifest = {} }
  const merged = new Map(defaults.recorders.map((item) => [item.id, validateRecorder(item)]))
  for (const item of manifest.recorders || []) merged.set(item.id, validateRecorder(item))
  const disabled = new Set(manifest.disable || [])
  return { recorders: [...merged.values()].filter((item) => !disabled.has(item.id)), defaults: defaults.recorders, disabled, outward: manifest.outward || [], warnings }
}

export function needsGitFallback(input, commands = parseGitCommands(input.tool_input?.command, input.cwd)) {
  const raw = input.tool_input?.command || ''
  // Plain output/heredoc data remains unmatched; shell wrappers and substitutions can execute Git.
  return !commands.length && /\bgit\b/.test(raw)
    && (commandHeads(raw).some((head) => !/^(?:echo|printf|cat)\b/.test(head)) || /\$\(|`/.test(raw))
}
function matchesRecorder(recorder, input) {
  if (recorder.kind === 'tool') return new RegExp(recorder.tool).test(input.tool_name || '')
    && (!recorder.command || commandHeads(input.tool_input?.command || '').some((head) => new RegExp(recorder.command).test(head)))
  if (recorder.kind === 'done') return input.tool_name === 'mcp__planka__move_card'
  if (input.tool_name !== 'Bash') return false
  const heads = commandHeads(input.tool_input?.command || '')
  if (recorder.kind === 'git') {
    const commands = parseGitCommands(input.tool_input?.command, input.cwd)
    return commands.some((item) => GIT_ACTS.has(item.action))
      || needsGitFallback(input, commands)
  }
  if (recorder.kind === 'push') return parseGitCommands(input.tool_input?.command, input.cwd).some((item) => item.action === 'push')
  if (recorder.kind === 'release') return parseGitCommands(input.tool_input?.command, input.cwd).some((item) => item.action === 'tag')
    || heads.some((head) => /^(?:npm|pnpm)\s+publish\b|^gh\s+release\s+create\b/.test(head))
  return heads.some((head) => /^gh\s+pr\s+(?:create|merge)\b/.test(head))
}
export function hasRecorderCandidate(input, root) {
  if (!observableTool(input)) return false
  if (BUILTIN_KINDS.some((kind) => matchesRecorder({ kind }, input))) return true
  return io.exists(path.join(root, '.claude', 'work-journal.json'))
}
export function matchedRecorders(config, input, ctx) {
  const matches = config.recorders.filter((recorder) => matchesRecorder(recorder, input))
  if (!ctx || !matches.some((recorder) => recorder.kind === 'done')) return matches
  const cache = io.json(path.join(ctx.store, 'board.json'))
  if (!cache?.doneId || cache.boardId !== resolveBoardPointer(ctx.root)?.boardId) return matches
  return matches.filter((recorder) => recorder.kind !== 'done' || !cache?.doneId || String(input.tool_input?.listId) === String(cache.doneId))
}
export function outwardRecorders(config, input, ctx) {
  return matchedRecorders({ recorders: config.defaults }, input, ctx).map((item) => item.id)
}
export function matchesOutward(config, input) {
  return config.outward.some((item) => new RegExp(item.tool).test(input.tool_name || '')
    && (!item.command || commandHeads(input.tool_input?.command || '').some((head) => new RegExp(item.command).test(head))))
}
export function sourceKey(input) { return sha256(`${input.session_id || ''}\n${input.tool_use_id || ''}`).slice(0, 24) }
export function actorOf(ctx, input) {
  if (input.agent_id) return 'subagent'
  const main = io.json(path.join(ctx.store, 'sessions', `${sha256(input.session_id || '')}.json`))
  return main?.transcript && input.transcript_path && io.canonical(main.transcript) === io.canonical(input.transcript_path) ? 'main' : 'unknown'
}
export function subjectOf(ctx, text, branch = '') {
  const card = /card[ /:#-]?(\d{8,})/i.exec(`${branch} ${text}`)
  return card ? `card:${card[1]}` : branch.replace(/^card\//, '') || path.basename(ctx.root)
}
function scalar(input, key) {
  const parts = key.split('.')
  if (!['tool_input', 'tool_response'].includes(parts[0])) return ''
  let value = input
  for (const part of parts) {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) return ''
    value = value?.[part]
  }
  return ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : ''
}
export function template(text, input) { return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key) => scalar(input, key)) }
export function responseObject(response) {
  if (!response || typeof response !== 'object' || response.isError === true || response.error) return null
  if (response.content?.[0]?.text) {
    try { return JSON.parse(response.content[0].text) } catch { return null }
  }
  return response.card || response
}

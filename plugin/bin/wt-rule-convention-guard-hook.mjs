#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

const SELF = 'wt-rule-convention-guard-hook.mjs'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const ALLOW_MARKER = '<!-- rule-lint: allow -->'

// A DATE has a valid DAY and a valid MONTH. That is what separates it from a ratio.
const DMY = /\b(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])(?:\/\d{2,4})?\b/g
const ISO = /\b\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g
const PEOPLE = ['Frederic', 'Frédéric']
const NARRATIVE = ['standing instruction from', 'stated by', 'his own preference',
  'that evening', 'one evening', 'the night of']

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// Accept BOTH slash styles for the leading `~` regardless of host platform: a payload's
// file_path is produced by the tool call, not typed at a platform-native shell, so a
// forward-slash tilde path can legitimately reach us even on Windows.
function normalizeFile(file, cwd) {
  const expanded = file === '~'
    ? os.homedir()
    : file.startsWith('~/') || file.startsWith('~\\')
      ? path.join(os.homedir(), file.slice(2))
      : file
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : typeof cwd === 'string' && cwd
      ? path.resolve(cwd, expanded)
      : null
}

function fileFromPayload(payload) {
  if (payload?.hook_event_name !== 'PreToolUse' || !EDIT_TOOLS.has(payload?.tool_name)) return null
  const input = payload?.tool_input
  if (typeof input?.file_path === 'string' && input.file_path) return input.file_path
  const firstEdit = Array.isArray(input?.edits) ? input.edits[0] : null
  return typeof firstEdit?.file_path === 'string' && firstEdit.file_path
    ? firstEdit.file_path
    : null
}

function isRuleFile(file) {
  if (!file.endsWith('.md')) return false
  const segments = file.split(/[\\/]+/).filter(Boolean)
  const rulesIndex = segments.lastIndexOf('rules')
  if (rulesIndex === -1) return false
  const tailLength = segments.length - rulesIndex - 1
  return tailLength === 1 || tailLength === 2
}

function isAgentDefinition(file) {
  if (!file.endsWith('.md')) return false
  const segments = file.split(/[\\/]+/).filter(Boolean)
  const parent = segments.at(-2)
  return parent === 'agents' || parent === 'agent-templates'
}

function addedTexts(payload) {
  const input = payload?.tool_input
  switch (payload?.tool_name) {
    case 'Edit':
      return typeof input?.new_string === 'string' ? [input.new_string] : []
    case 'Write':
      return typeof input?.content === 'string' ? [input.content] : []
    case 'MultiEdit':
      return Array.isArray(input?.edits)
        ? input.edits
          .map((edit) => (typeof edit?.new_string === 'string' ? edit.new_string : null))
          .filter((text) => text !== null)
        : []
    default:
      return []
  }
}

function lineSnippet(line) {
  return line.slice(0, 90)
}

function pushRegexViolations(violations, detector, regex, line, lineNumber) {
  regex.lastIndex = 0
  for (const match of line.matchAll(regex)) {
    violations.push({
      detector,
      match: match[0],
      lineNumber,
      snippet: lineSnippet(line),
    })
  }
}

function pushPhraseViolations(violations, detector, phrases, line, lineNumber) {
  for (const phrase of phrases) {
    let start = 0
    while (start < line.length) {
      const index = line.indexOf(phrase, start)
      if (index === -1) break
      violations.push({
        detector,
        match: phrase,
        lineNumber,
        snippet: lineSnippet(line),
      })
      start = index + phrase.length
    }
  }
}

function isWordChar(char) {
  return typeof char === 'string' && /[\p{L}\p{N}_]/u.test(char)
}

function pushWordViolations(violations, detector, phrases, line, lineNumber) {
  for (const phrase of phrases) {
    let start = 0
    while (start < line.length) {
      const index = line.indexOf(phrase, start)
      if (index === -1) break
      const before = index === 0 ? '' : line[index - 1]
      const after = index + phrase.length >= line.length ? '' : line[index + phrase.length]
      if (!isWordChar(before) && !isWordChar(after)) {
        violations.push({
          detector,
          match: phrase,
          lineNumber,
          snippet: lineSnippet(line),
        })
      }
      start = index + phrase.length
    }
  }
}

function detectViolations(text) {
  const violations = []
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (!line || line.includes(ALLOW_MARKER)) continue
    const lineNumber = index + 1
    pushRegexViolations(violations, 'DATE (DMY)', DMY, line, lineNumber)
    pushRegexViolations(violations, 'DATE (ISO)', ISO, line, lineNumber)
    pushWordViolations(violations, 'PEOPLE', PEOPLE, line, lineNumber)
    pushPhraseViolations(violations, 'NARRATIVE', NARRATIVE, line, lineNumber)
  }
  return violations
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
}

function main() {
  const payload = readInput()
  if (!payload) return

  const sourceFile = fileFromPayload(payload)
  if (!sourceFile) return
  const file = normalizeFile(sourceFile, payload.cwd)
  if (!file) return
  if (!isRuleFile(file) && !isAgentDefinition(file)) return

  const violations = addedTexts(payload).flatMap(detectViolations)
  if (violations.length === 0) return

  const details = violations
    .map((violation) => `${violation.detector}: "${violation.match}" on line ${violation.lineNumber}: ${violation.snippet}`)
    .join('\n')

  deny(
    `${details}\nA rule states what to DO plus the invariant that makes it right. ` +
    `Move the date, the name and the story to a note, and keep the directive.`,
  )
}

runFailOpenHook(SELF, main)

#!/usr/bin/env node
// wt-shipped-twin-check-hook.mjs — a PostToolUse advisory that asks whether a local Claude
// config file just edited has a shipped counterpart that needs the same fix. The pairing is not
// automatable: twins routinely do not share a filename, so this hook raises the question once per
// session per directory and never answers it.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

const EXTENSIONS = new Set(['.mjs', '.js', '.ts', '.cjs', '.py', '.sh', '.md'])

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function normalizePath(filePath) {
  return typeof filePath === 'string' ? filePath.replace(/\\/g, '/') : ''
}

function hasAllowedExtension(normalizedPath) {
  return EXTENSIONS.has(path.posix.extname(normalizedPath).toLowerCase())
}

function isInScope(filePath) {
  const normalized = normalizePath(filePath)
  if (!normalized || !hasAllowedExtension(normalized)) return false
  // Case-insensitive: Windows filesystems are case-insensitive, so a path segment can read
  // "Plugin/" or "NODE_MODULES/" after separator normalization and still be the same directory.
  if (/(^|\/)plugin\//i.test(normalized)) return false
  if (/(^|\/)node_modules\//i.test(normalized)) return false
  if (/(^|\/)memory\/[^/]+\.md$/i.test(normalized)) return false
  if (/(^|\/)MEMORY\.md$/i.test(normalized)) return false
  return /(^|\/)\.claude\/(scripts|hooks|rules)\//i.test(normalized)
}

function looksLikeProjectDir(candidate, cwd = process.cwd()) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  try {
    if (candidate === cwd) return true
    const withSep = candidate.endsWith(path.sep) ? candidate : candidate + path.sep
    return cwd.startsWith(withSep)
  } catch {
    return false
  }
}

function safeTmpDir() {
  const candidate = os.tmpdir()
  if (looksLikeProjectDir(candidate)) {
    return process.platform === 'win32'
      ? (process.env['SystemRoot'] ? path.join(process.env['SystemRoot'], 'Temp') : 'C:\\Windows\\Temp')
      : '/tmp'
  }
  return candidate
}

function stateDir() {
  return process.env['WT_SHIPPED_TWIN_GUARD_DIR'] || safeTmpDir()
}

function throttleKey(input) {
  const raw = typeof input?.session_id === 'string' && input.session_id
    ? input.session_id
    : (typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd())
  return crypto.createHash('sha1').update(String(raw)).digest('hex')
}

function stateFileFor(input) {
  return path.join(stateDir(), `shipped-twin-seen-${throttleKey(input)}.json`)
}

function readSeen(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed?.seen) ? parsed.seen.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function markSeen(filePath, seen) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({ seen }), 'utf8')
  } catch {
    // Best effort only: never break Write/Edit if the reminder state cannot be persisted.
  }
}

function main() {
  const input = readInput()
  if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return
  if (input.tool_name && !/^(Write|Edit)$/.test(input.tool_name)) return

  const filePath = input?.tool_input?.file_path
  if (!isInScope(filePath)) return

  const normalizedFile = normalizePath(filePath)
  const parentDir = path.posix.dirname(normalizedFile)
  const stateFile = stateFileFor(input)
  const seen = readSeen(stateFile)
  if (seen.includes(parentDir)) return

  const nextSeen = [...seen, parentDir]
  markSeen(stateFile, nextSeen)

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `SHIPPED-TWIN CHECK for ${normalizedFile} — this hook cannot tell whether a shipped ` +
          `counterpart exists, because twins routinely do not share a filename and the pairing ` +
          `cannot be automated here. Ask now: does this file have a shipped counterpart, and ` +
          `does this fix belong there too in the same pass? This reminder fires at most once ` +
          `per session for ${parentDir}, so later silence means only that the question was ` +
          `already raised for this directory, not that no twin exists.`,
      },
    }),
  )
}

runFailOpenHook('wt-shipped-twin-check-hook.mjs', main)

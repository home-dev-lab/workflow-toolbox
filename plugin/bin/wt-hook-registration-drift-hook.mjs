#!/usr/bin/env node
// wt-hook-registration-drift-hook.mjs — capture what THIS session registered at start, then
// cheaply re-check those exact paths on every prompt so a stale in-memory hook table becomes one
// attributed notice instead of anonymous loader noise.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { declaredHookPaths } from './lib/hook-manifest.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const MANIFEST = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
const STATE_DIR = process.env.WT_HOOK_DRIFT_DIR
  || join(homedir(), '.local', 'state', 'wt-hook-drift')
// The declared-hooks set only changes when the plugin manifest is reloaded (a plugin update or
// reinstall), never between two SessionStart calls against the same manifest on disk. Caching it
// keyed on the manifest's own mtime+size turns a repeat SessionStart's JSON.parse + regex sweep
// over the whole manifest into a single stat() call — the parse re-runs only when the manifest
// itself has actually changed since the cache was written.
const MANIFEST_CACHE_FILE = join(STATE_DIR, 'manifest-cache.json')

function readInput() {
  try {
    const raw = readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function stateFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-')
  return join(STATE_DIR, `${safe}.json`)
}

function readSnapshot(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeSnapshot(file, snapshot) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(snapshot, null, 2))
}

function manifestFingerprint() {
  try {
    const stat = statSync(MANIFEST)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

function readCachedHooks(fingerprint) {
  if (!fingerprint) return null
  const cached = readSnapshot(MANIFEST_CACHE_FILE)
  if (!cached) return null
  if (cached.mtimeMs !== fingerprint.mtimeMs || cached.size !== fingerprint.size) return null
  return cached.hooks ?? null
}

function writeCachedHooks(fingerprint, hooks) {
  if (!fingerprint) return
  writeSnapshot(MANIFEST_CACHE_FILE, { ...fingerprint, hooks })
}

function declaredHooksResolved() {
  const fingerprint = manifestFingerprint()
  const cached = readCachedHooks(fingerprint)
  if (cached) return cached
  const hooks = declaredHookPaths(MANIFEST).map(({ event, rel }) => ({
    event,
    rel,
    abs: resolve(PLUGIN_ROOT, `.${rel}`),
  }))
  writeCachedHooks(fingerprint, hooks)
  return hooks
}

function handleSessionStart(sessionId) {
  const hooks = declaredHooksResolved()
  writeSnapshot(stateFile(sessionId), { hooks, reportedAt: null })
}

function handleUserPromptSubmit(sessionId) {
  const file = stateFile(sessionId)
  const snapshot = readSnapshot(file)
  if (!snapshot || snapshot.reportedAt !== null) return

  const missing = (snapshot.hooks ?? []).filter((entry) => !existsSync(entry.abs))
  if (missing.length === 0) return

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        'HOOK REGISTRATION DRIFT — this session is still invoking hook paths it registered at '
        + 'session start, and some of those files no longer exist on disk. This session\'s own '
        + 'hook registration is stale and cannot self-repair; restart the session to pick up the '
        + 'corrected manifest. Missing hook paths:\n'
        + missing.map(({ event, abs }) => `- ${event}: ${basename(abs)}`).join('\n'),
    },
  }))

  writeSnapshot(file, { ...snapshot, reportedAt: new Date().toISOString() })
}

function main() {
  const input = readInput()
  const event = input?.hook_event_name
  const sessionId = input?.session_id
  if (event === 'SessionStart') {
    handleSessionStart(sessionId)
    return
  }
  if (event === 'UserPromptSubmit') handleUserPromptSubmit(sessionId)
}

runFailOpenHook('wt-hook-registration-drift-hook.mjs', main)

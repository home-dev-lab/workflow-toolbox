#!/usr/bin/env node
// deep-search ask — what the WebSearch hook WOULD answer, without needing the model to search.
//
// Why this exists: measured 2026-09-20 21:44 +01:00, a headless session told to "search the web"
// answered from memory and emitted ZERO WebSearch tool calls, and across all 58,351 transcripts on
// this machine WebSearch reduces to 7 distinct queries. The hook is correct and rarely exercised,
// so the deterministic way to see its answer is to ask for it directly.
//
//   node bin/ask.mjs "how do I register a PostToolUse hook"
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { register } from '../hooks/hooks.js'

const question = process.argv.slice(2).join(' ').trim()
if (!question) { console.error('usage: ask.mjs "<question>"'); process.exit(2) }

// The same engine surface the harness gives a hooks module, backed by node here.
const $ = {
  env: { get: async (n) => process.env[n] ?? (n === 'HOME' ? homedir() : undefined) },
  fs: { exists: async (p) => existsSync(p), read: async (p) => readFileSync(p, 'utf8'), list: async () => [] },
  process: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) },
}

let hook = null
register((event, matcher, fn) => { if (event === 'tool.call') hook = fn }, {})
if (!hook) { console.error('the plugin registered no tool.call hook'); process.exit(1) }

const answer = await hook($, { tool: 'WebSearch', query: question }, async () => ({ fellThrough: true }))
if (answer.fellThrough) {
  console.log('FELL THROUGH — this question goes to the ordinary web search.')
  process.exit(3)
}
console.log(answer.result.results[0])

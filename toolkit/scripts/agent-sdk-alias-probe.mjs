#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveAgentSdkRequire } from '../../plugin/bin/lib/sdk-resolution.mjs'

if (!process.env.CLAUDE_CONFIG_DIR || process.env.WT_ALIAS_PROBE_ALLOW_REAL_CALL !== '1') {
  throw new Error('refusing a real model call: set CLAUDE_CONFIG_DIR to an isolated test profile and WT_ALIAS_PROBE_ALLOW_REAL_CALL=1')
}

const require = resolveAgentSdkRequire({ projectDir: process.cwd(), env: process.env })
const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
const version = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')).version
const { query } = require('@anthropic-ai/claude-agent-sdk')
let resolved = null

const stream = query({
  prompt: 'Reply with exactly: alias probe complete',
  options: {
    model: 'opus',
    effort: 'high',
    tools: [],
    settingSources: [],
    maxTurns: 1,
  },
})

for await (const message of stream) {
  if (message.type === 'system' && message.subtype === 'init' && message.model) resolved = message.model
  if (!resolved && message.type === 'assistant' && message.message?.model) resolved = message.message.model
}

if (!resolved) throw new Error('the SDK stream ended without reporting its resolved model')
process.stdout.write(`sdk=${version} opus -> ${resolved}\n`)

#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const USAGE = 'usage: run-agent.mjs <agent.md> <input.md> <output.json>'

export function parseRunnerArgs(argv) {
  if (argv.length !== 3 || argv.some((arg) => !arg || arg.startsWith('-'))) throw new Error(USAGE)
  const [agentPath, inputPath, outputPath] = argv
  return { agentPath, inputPath, outputPath }
}

export function parseAgentFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source)
  if (match === null) throw new Error('agent definition must start with YAML frontmatter')
  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.indexOf(':')
    if (separator === -1) throw new Error(`invalid frontmatter line: ${line}`)
    const key = line.slice(0, separator).trim()
    if (Object.hasOwn(frontmatter, key)) throw new Error(`duplicate frontmatter field: ${key}`)
    frontmatter[key] = line.slice(separator + 1).trim()
  }
  return { frontmatter, body: match[2].trim() }
}

export function requireString(frontmatter, field) {
  const value = frontmatter[field]
  if (!value) throw new Error(`agent frontmatter requires ${field}`)
  return value
}

export function serializeRun(agentPath, model, effort, transcript) {
  const result = transcript.at(-1) ?? null
  if (result?.type !== 'result') throw new Error('agent query did not end with a result message')
  return { agent: { path: agentPath, model, effort }, transcript, usage: result?.usage ?? null }
}

async function loadSdk() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const toolkitRequire = createRequire(resolve(repoRoot, 'toolkit/package.json'))
  const sdkPath = toolkitRequire.resolve('@anthropic-ai/claude-agent-sdk')
  return import(pathToFileURL(sdkPath).href)
}

async function main() {
  const { agentPath, inputPath, outputPath } = parseRunnerArgs(process.argv.slice(2))
  const { frontmatter, body } = parseAgentFrontmatter(readFileSync(agentPath, 'utf8'))
  const model = requireString(frontmatter, 'model')
  const effort = requireString(frontmatter, 'effort')
  if (requireString(frontmatter, 'sdk-only') !== 'true') throw new Error('agent frontmatter requires sdk-only: true')
  const { query } = await loadSdk()
  const transcript = []

  // Function hooks interfere with plain Agent SDK query() sessions.
  delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
  for await (const message of query({
    prompt: readFileSync(inputPath, 'utf8'),
    options: { cwd: process.cwd(), effort, model, settingSources: [], systemPrompt: body, tools: [] },
  })) {
    transcript.push(message)
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(serializeRun(agentPath, model, effort, transcript), null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}

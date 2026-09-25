#!/usr/bin/env node
// wt-envelope-intercept-hook.mjs — Path-B PreToolUse(Agent) port of the archived envelope
// interception shape: run the external opencode call HERE, write its node artefacts HERE, then
// rewrite the spawned prompt so the Claude envelope never sees the real task and can only relay the
// result. Installed only in plugin/launch-agents/, because delegated (server-launched) sessions are
// the Path B surface that actually loads plugin agentTypes via the SDK `plugins` option.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { runFailOpenHookAsync } from './lib/fail-open-trace.mjs'
import { effectiveSkillDiscoveryRefusal, opencodeChildEnv, opencodeSkillFenceRefusal, spawnOpencode, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from './lib/opencode-skill-fence.mjs'
import { providerCredentialNames } from './lib/external-model-env.mjs'
import {
  laneTextFromOutput,
  laneUsageFromOutput,
  runDirForSessionTranscript,
  verifierStreamDirForEnv,
  writeLaneArtefacts,
} from './wt-verifier-cli-guard-hook.mjs'

const HOOK = 'wt-envelope-intercept-hook.mjs'
const OPENCODE_TYPE = 'workflow-toolbox:opencode-verifier'
const RELAY_TYPE = 'workflow-toolbox:leaf'
const DEFAULT_MODEL = 'openai/gpt-5.4'
const RUN_TIMEOUT_MS = 600_000

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function directive(prompt, key) {
  if (typeof prompt !== 'string') return null
  const m = prompt.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return m === null ? null : (m[1] ?? null)?.trim() ?? null
}

function safeWorkdir(input, prompt) {
  const fromPrompt = directive(prompt, 'OPENCODE_WORKDIR')
  if (typeof fromPrompt === 'string' && path.isAbsolute(fromPrompt)) return fromPrompt
  return typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd()
}

function chosenModel(prompt) {
  const fromPrompt = directive(prompt, 'OPENCODE_MODEL')
  return typeof fromPrompt === 'string' && fromPrompt.length > 0 ? fromPrompt : DEFAULT_MODEL
}

function chosenVariant(prompt) {
  const fromPrompt = directive(prompt, 'OPENCODE_VARIANT')
  return typeof fromPrompt === 'string' && fromPrompt.length > 0 ? fromPrompt : null
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function relayPrompt(text, schema) {
  if (schema !== undefined) {
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return [
        'Call StructuredOutput exactly once with this JSON object and nothing else:',
        JSON.stringify(parsed),
      ].join('\n\n')
    }
  }
  return [
    'Return exactly the following text and nothing else.',
    'BEGIN RESULT',
    text,
    'END RESULT',
  ].join('\n')
}

function fakeLaneId(parentAgentId, toolUseId) {
  const key = typeof toolUseId === 'string' && toolUseId.length > 0
    ? crypto.createHash('sha1').update(toolUseId).digest('hex').slice(0, 6)
    : crypto.randomUUID().replace(/-/g, '').slice(0, 6)
  return `${parentAgentId}-lane-${key}`
}

function testRun(prompt, model) {
  const stdout = process.env['WT_ENVELOPE_INTERCEPT_TEST_STDOUT']
  if (stdout === undefined) return null
  return {
    stdout,
    stderr: '',
    model: process.env['WT_ENVELOPE_INTERCEPT_TEST_MODEL'] || model,
    durationMs: 1,
  }
}

function runScriptedOpencodeCall(prompt, workdir, model, variant) {
  const test = testRun(prompt, model)
  if (test !== null) return test

  const fence = verifyOpencodeSkillFence('opencode', { platform: process.platform })
  if (!fence.ok) return { stdout: opencodeSkillFenceRefusal(fence.reason), stderr: '', model, durationMs: 0 }
  const binary = fence.binary ?? 'opencode'
  const credentialNames = providerCredentialNames(model)
  const childEnv = opencodeChildEnv(undefined, credentialNames)
  const discovery = verifyEffectiveOpencodeSkillDiscovery(binary, { cwd: workdir, env: childEnv, platform: process.platform, extraNames: credentialNames })
  if (!discovery.ok) return { stdout: effectiveSkillDiscoveryRefusal(discovery, 'wt-envelope-intercept'), stderr: '', model, durationMs: discovery.durationMs }

  const taskFile = path.join(workdir, `.wt-envelope-intercept-${process.pid}-${crypto.randomUUID().slice(0, 8)}.md`)
  const streamDir = ensureDir(verifierStreamDirForEnv(process.env, os.homedir(), process.platform))
  const streamFile = path.join(streamDir, `wt-opencode-json-stream-${process.pid}-${crypto.randomUUID().slice(0, 8)}.jsonl`)
  fs.writeFileSync(taskFile, prompt, 'utf8')
  const args = [
    'run',
    '--agent', 'plan',
    '--model', model,
    ...(variant === null ? [] : ['--variant', variant]),
    '--format', 'json',
    '-f', taskFile,
  ]
  const startedAt = Date.now()
  try {
    const res = spawnOpencode(spawnSync, binary, args, {
      cwd: workdir,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      input: '',
      env: childEnv,
    }, process.platform)
    const stdout = typeof res.stdout === 'string' ? res.stdout : ''
    const stderr = typeof res.stderr === 'string' ? res.stderr : ''
    if (stdout.length > 0) fs.writeFileSync(streamFile, stdout, 'utf8')
    const text = stdout.length > 0 ? stdout : (stderr.length > 0 ? stderr : `opencode exited ${res.status ?? 'unknown'}`)
    return {
      stdout: text,
      stderr,
      model,
      durationMs: Date.now() - startedAt,
      streamFile,
      taskFile,
    }
  } catch (error) {
    return {
      stdout: `OPENCODE_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
      stderr: '',
      model,
      durationMs: Date.now() - startedAt,
      streamFile,
      taskFile,
    }
  } finally {
    try { fs.rmSync(taskFile, { force: true }) } catch {}
  }
}

async function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Agent') return

  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  if (ti.subagent_type !== OPENCODE_TYPE) return
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : ''
  if (prompt.length === 0) return

  const workdir = safeWorkdir(input, prompt)
  const model = chosenModel(prompt)
  const variant = chosenVariant(prompt)
  const run = runScriptedOpencodeCall(prompt, workdir, model, variant)
  const answerText = laneTextFromOutput(run.stdout) ?? run.stdout
  const usage = laneUsageFromOutput(run.stdout)

  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : null
  const parentAgentId = typeof input.agent_id === 'string' && input.agent_id.length > 0 ? input.agent_id : null
  const runDir = transcriptPath === null ? null : runDirForSessionTranscript(transcriptPath)
  if (runDir !== null && parentAgentId !== null && answerText.length > 0) {
    writeLaneArtefacts({
      runDir,
      laneId: fakeLaneId(parentAgentId, input.tool_use_id),
      askedContent: prompt,
      answerContent: answerText,
      rawStreamText: run.stdout,
      sig: 'opencode',
      parentAgentId,
      model: run.model,
      durationMs: run.durationMs,
      usage,
    })
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...ti,
        subagent_type: RELAY_TYPE,
        prompt: relayPrompt(answerText, ti.schema),
      },
    },
  }))
}

await runFailOpenHookAsync(HOOK, main)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const EXIT_MARKER = '__WT_OBSERVER_EXIT__='
const OBSERVER_INSTRUCTION = 'Read the attached observer task and return its requested JSON verdict.'

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function extractJson(raw) {
  const trimmed = String(raw || '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

function parseJsonEvents(raw) {
  const events = []
  for (const line of String(raw || '').split('\n')) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed)
    } catch {
      // Default-format output and shell markers are handled by the existing parser.
    }
  }
  return events
}

function verdictBody(body) {
  const text = parseJsonEvents(body)
    .filter((event) => event.type === 'text' && typeof event.part?.text === 'string')
    .map((event) => event.part.text)
    .join('\n')
  return text || body
}

export function parseObserverLaneUsage(stdout) {
  const totals = { input: 0, output: 0, reasoning: 0, total: 0, cacheRead: 0, cacheWrite: 0 }
  let reported = false
  for (const event of parseJsonEvents(stdout)) {
    if (event.type !== 'step_finish' || !event.part?.tokens || typeof event.part.tokens !== 'object') continue
    const tokens = event.part.tokens
    const values = {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      total: tokens.total,
      cacheRead: tokens.cache?.read,
      cacheWrite: tokens.cache?.write,
    }
    for (const [key, value] of Object.entries(values)) {
      if (!Number.isFinite(Number(value))) continue
      totals[key] += Number(value)
      reported = true
    }
  }
  return reported ? totals : null
}

export function parseObserverLaneOutput(stdout, stderr) {
  const lines = String(stdout || '').split('\n')
  const exitLine = [...lines].reverse().find((line) => line.startsWith(EXIT_MARKER))
  if (!exitLine) return { kind: 'error', reason: 'observer lane exited without an exit marker' }

  const exitCode = Number(exitLine.slice(EXIT_MARKER.length))
  if (!Number.isInteger(exitCode)) return { kind: 'error', reason: 'observer lane exit marker was malformed' }

  const body = lines.filter((line) => !line.startsWith(EXIT_MARKER)).join('\n').trim()
  if (exitCode === 124) return { kind: 'error', reason: 'observer lane timed out' }
  if (exitCode !== 0) {
    const detail = String(stderr || body || `exit ${exitCode}`).trim()
    return { kind: 'error', reason: `observer lane failed (${detail})` }
  }

  const parsed = extractJson(verdictBody(body))
  if (!parsed || typeof parsed !== 'object') return { kind: 'error', reason: 'observer lane returned no parseable JSON verdict' }
  const status = parsed.status
  if (status === 'clean') return { kind: 'clean' }
  if (status !== 'finding') return { kind: 'error', reason: 'observer lane returned an unknown status' }

  const fiche = typeof parsed.fiche === 'string' ? parsed.fiche.trim() : ''
  const evidence = typeof parsed.evidence === 'string' ? parsed.evidence.trim() : ''
  const observation = typeof parsed.observation === 'string' ? parsed.observation.trim() : ''
  if (!fiche || !observation) return { kind: 'error', reason: 'observer lane finding was incomplete' }
  if (!evidence) return { kind: 'error', reason: `observer lane named fiche ${fiche} without an evidence line` }
  return { kind: 'finding', fiche, evidence, observation }
}

export function buildObserverPrompt({ indexText, deltaText }) {
  return [
    'You are a read-only lesson observer for one Claude Code session.',
    'Decide only whether anything the session just did in the supplied delta matches a lesson already recorded in the knowledge-base index.',
    'Use only the index summaries below. Never open, request, infer, or summarize a fiche body.',
    'If no recorded lesson matches, return exactly one JSON object: {"status":"clean"}.',
    'If a match IS established, return exactly one JSON object with this shape and nothing else:',
    '{"status":"finding","observation":"<one short line describing what was observed>","fiche":"<fiche slug exactly as it appears in the index>","evidence":"<one exact evidence line from the delta>"}',
    'Return one match and one pointer only. Never invent evidence. Never mention tool outputs.',
    '',
    '## Knowledge-base index',
    indexText,
    '',
    '## Transcript delta',
    deltaText,
  ].join('\n')
}

export function observerLaneInputBytes(prompt) {
  return Buffer.byteLength(OBSERVER_INSTRUCTION, 'utf8') + Buffer.byteLength(prompt, 'utf8')
}

export function runObserverLane({ projectDir, prompt, timeoutSeconds, model, binPath }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wt-observer-'))
  const taskFile = path.join(root, 'observer-task.md')
  writeFileSync(taskFile, prompt, 'utf8')

  const command = `timeout ${Number(timeoutSeconds)} ${quote(binPath)} run ${quote(OBSERVER_INSTRUCTION)} --format json --auto --dir ${quote(projectDir)} --model ${quote(model)} -f ${quote(taskFile)} < /dev/null; exit_code=$?; printf '\n${EXIT_MARKER}%s\n' "$exit_code"`
  const result = spawnSync('zsh', ['-lc', command], {
    encoding: 'utf8',
    timeout: (Number(timeoutSeconds) + 5) * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let taskText = ''
  try {
    taskText = readFileSync(taskFile, 'utf8')
  } catch {
    taskText = ''
  }

  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only.
  }

  if (result.error) return { outcome: { kind: 'error', reason: result.error.message }, taskText }
  return {
    outcome: parseObserverLaneOutput(result.stdout || '', result.stderr || ''),
    usage: parseObserverLaneUsage(result.stdout || ''),
    taskText,
  }
}

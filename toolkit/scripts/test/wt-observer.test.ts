import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildObserverPrompt, observerLaneInputBytes, parseObserverLaneOutput, parseObserverLaneUsage } from '../../../plugin/bin/lib/observer-lane.mjs'
import { queueSnapshotFileName, resolveQueueSnapshotPath } from '../../../plugin/bin/lib/queue-snapshot-path.mjs'
import { boundDeltaLines, readTranscriptDelta, summarizeTranscriptRecords } from '../../../plugin/bin/lib/transcript-delta.mjs'

const observerScript = fileURLToPath(new URL('../../../plugin/bin/wt-observer.mjs', import.meta.url))
const children: ChildProcessWithoutNullStreams[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM')
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(prefix: string) {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(root)
  return root
}

function writeExecutable(filePath: string, body: string) {
  writeFileSync(filePath, body, 'utf8')
  chmodSync(filePath, 0o755)
}

function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for observer condition'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function writeTranscript(filePath: string, records: unknown[]) {
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

function setupSession(root: string, sessionId = 'sess-1') {
  const projectDir = path.join(root, 'project')
  const configDir = path.join(root, 'config')
  const spoolDir = path.join(root, 'spool')
  const stateDir = path.join(root, 'state')
  const sessionRoot = path.join(configDir, 'projects', projectDir.replace(/[^A-Za-z0-9-]/g, '-'))
  const transcriptPath = path.join(sessionRoot, `${sessionId}.jsonl`)
  const subagentsDir = path.join(sessionRoot, sessionId, 'subagents')
  const lessonIndexPath = path.join(sessionRoot, 'memory', 'MEMORY.md')
  mkdirSync(path.join(projectDir, 'plugin', 'rules'), { recursive: true })
  mkdirSync(path.dirname(transcriptPath), { recursive: true })
  mkdirSync(subagentsDir, { recursive: true })
  mkdirSync(path.dirname(lessonIndexPath), { recursive: true })
  mkdirSync(spoolDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(path.join(projectDir, 'plugin', 'rules', 'sample.md'), '# sample\nFollow the rule.', 'utf8')
  writeFileSync(lessonIndexPath, 'sample-lesson - Check repository inspection against the recorded lesson.\n', 'utf8')
  return { projectDir, configDir, spoolDir, stateDir, transcriptPath, subagentsDir, sessionRoot, sessionId, lessonIndexPath }
}

function spawnObserver(env: Record<string, string>, args: string[] = ['--once']) {
  const child = spawn(process.execPath, [observerScript, ...args], {
    env: {
      ...process.env,
      WT_OBSERVER_COST_LOG: path.join(path.dirname(env.WT_WAKE_SPOOL), 'lane-cost.jsonl'),
      WT_OBSERVER_STATE_DIR: path.join(path.dirname(env.WT_WAKE_SPOOL), 'observer-state'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  return { child, stdout: () => stdout, stderr: () => stderr }
}

describe('wt-observer helpers', () => {
  it('keeps only session text plus tool names and drops tool outputs', () => {
    const summary = summarizeTranscriptRecords([
      {
        type: 'user',
        message: { content: [{ type: 'text', text: 'check the queue' }] },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will inspect it.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'huge output' },
          ],
        },
      },
      { type: 'observer-ref', timestamp: '2026-08-10T12:00:00.000Z' },
    ])

    expect(summary.filteredLines).toEqual([
      'user: check the queue',
      'assistant: I will inspect it.',
      'assistant: [tool Bash]',
    ])
    expect(summary.lastRealRecordType).toBe('assistant')
  })

  it('bounds deltas to the most recent lines that fit and marks truncation', () => {
    const bounded = boundDeltaLines(['user: one', 'assistant: two', 'assistant: three'], 22)
    expect(bounded.truncated).toBe(true)
    expect(bounded.text).toBe('assistant: three')
    expect(Buffer.byteLength(boundDeltaLines([`user: ${'x'.repeat(100)}`], 20).text, 'utf8')).toBeLessThanOrEqual(20)
  })

  it('resolves the nearest ancestor queue snapshot path', () => {
    const root = tempRoot('wt-observer-queue-')
    const stateDir = path.join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const projectRoot = path.join(root, 'repo')
    const nested = path.join(projectRoot, 'toolkit', 'pkg')
    mkdirSync(nested, { recursive: true })
    const snapshot = path.join(stateDir, queueSnapshotFileName(projectRoot))
    writeFileSync(snapshot, '{}', 'utf8')

    expect(resolveQueueSnapshotPath(stateDir, nested)).toEqual({ path: snapshot, ancestor: projectRoot })
  })

  it('builds the lane prompt from the lesson index and not the rules corpus', () => {
    const prompt = buildObserverPrompt({
      indexText: 'sample-lesson - Existing lesson summary.',
      rulesText: 'RULE CORPUS SENTINEL',
      deltaText: 'assistant: inspected the repository',
    })

    expect(prompt).toContain('## Knowledge-base index\nsample-lesson - Existing lesson summary.')
    expect(prompt).toContain('## Transcript delta\nassistant: inspected the repository')
    expect(prompt).not.toContain('RULE CORPUS SENTINEL')
    expect(prompt).not.toContain('## Rules corpus')
  })

  it('rejects a model finding that names a fiche without evidence', () => {
    expect(parseObserverLaneOutput('{"status":"finding","observation":"match","fiche":"sample-lesson"}\n__WT_OBSERVER_EXIT__=0\n', '')).toEqual({
      kind: 'error',
      reason: 'observer lane named fiche sample-lesson without an evidence line',
    })
  })

  it('reads the last record type from a bounded transcript tail and reports an indeterminate tail', () => {
    const root = tempRoot('wt-observer-tail-')
    const transcript = path.join(root, 'transcript.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', padding: 'x'.repeat(70_000) })}\n${JSON.stringify({ type: 'user' })}\n`, 'utf8')
    expect(readTranscriptDelta(transcript, 0, 100).lastRealRecordType).toBe('user')

    writeFileSync(transcript, JSON.stringify({ type: 'assistant', padding: 'x'.repeat(70_000) }), 'utf8')
    expect(readTranscriptDelta(transcript, 0, 100).lastRecordDegradedReason).toBe('bounded transcript tail contains no complete record')
  })

  it('extracts token counts reported by JSON lane events', () => {
    const stdout = `${JSON.stringify({ type: 'step_finish', part: { tokens: { input: 10, output: 4, reasoning: 2, total: 16, cache: { read: 20, write: 3 } } } })}\n`
    expect(parseObserverLaneUsage(stdout)).toEqual({ input: 10, output: 4, reasoning: 2, total: 16, cacheRead: 20, cacheWrite: 3 })
  })
})

describe('wt-observer CLI', () => {
  it('does not report a premature stop while the transcript is freshly written', async () => {
    const root = tempRoot('wt-observer-active-')
    const session = setupSession(root)
    const fakeBin = path.join(root, 'fake-opencode.sh')
    writeExecutable(fakeBin, `#!/bin/sh\nprintf '%s\\n' '{"status":"clean"}'\n`)

    writeTranscript(session.transcriptPath, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
    ])
    writeFileSync(path.join(session.stateDir, `engine-${session.projectDir.replace(/[^A-Za-z0-9-]/g, '-')}.json`), JSON.stringify({ declaredAtMs: Date.now(), sessionId: session.sessionId }), 'utf8')
    writeFileSync(
      path.join(session.stateDir, queueSnapshotFileName(session.projectDir)),
      JSON.stringify({ open: 3, at: Date.now(), next: 'Card 42' }),
      'utf8',
    )

    const run = spawnObserver({
      CLAUDE_CODE_SESSION_ID: session.sessionId,
      CLAUDE_CONFIG_DIR: session.configDir,
      WT_QUEUE_GATE_DIR: session.stateDir,
      WT_AUTONOMY_WATCH_MANDATE_DIR: session.stateDir,
      WT_WAKE_SPOOL: session.spoolDir,
      WT_OBSERVER_BIN: fakeBin,
      WT_OBSERVER_IDLE_MINUTES: '0',
    }, ['--project', session.projectDir, '--once'])

    await waitFor(() => run.child.exitCode !== null)
    expect(readdirSync(session.spoolDir).filter((name) => name.endsWith('.txt'))).toEqual([])
  })

  it('does not call the model lane twice inside the configured interval', async () => {
    const root = tempRoot('wt-observer-rate-')
    const session = setupSession(root)
    const calls = path.join(root, 'lane-calls')
    const capture = path.join(root, 'last-task.md')
    const fakeBin = path.join(root, 'fake-opencode.sh')
    writeExecutable(fakeBin, `#!/bin/sh
task=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-f" ]; then
    shift
    task="$1"
  fi
  shift
done
cp "$task" ${JSON.stringify(capture)}
printf 'call\\n' >> ${JSON.stringify(calls)}
printf '%s\\n' '{"status":"clean"}'
`)
    writeTranscript(session.transcriptPath, [
      { type: 'user', message: { content: [{ type: 'text', text: 'first change' }] } },
    ])

    spawnObserver({
      CLAUDE_CODE_SESSION_ID: session.sessionId,
      CLAUDE_CONFIG_DIR: session.configDir,
      WT_QUEUE_GATE_DIR: session.stateDir,
      WT_AUTONOMY_WATCH_MANDATE_DIR: session.stateDir,
      WT_WAKE_SPOOL: session.spoolDir,
      WT_OBSERVER_BIN: fakeBin,
      WT_OBSERVER_LANE_INTERVAL_MINUTES: '0.01',
    }, ['--project', session.projectDir, '--poll', '1'])

    await waitFor(() => existsSync(calls) && readFileSync(calls, 'utf8').trim().split('\n').length === 1)
    const secondRecord = `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'second change' }] } })}\n`
    const splitAt = Math.floor(secondRecord.length / 2)
    appendFileSync(session.transcriptPath, secondRecord.slice(0, splitAt))
    await new Promise((resolve) => setTimeout(resolve, 50))
    appendFileSync(session.transcriptPath, secondRecord.slice(splitAt))
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['call'])
    await waitFor(() => readFileSync(calls, 'utf8').trim().split('\n').length === 2)
    expect(readFileSync(capture, 'utf8')).toContain('user: second change')
  })

  it('shares the lane interval across observer processes for the same session', async () => {
    const root = tempRoot('wt-observer-shared-rate-')
    const session = setupSession(root)
    const calls = path.join(root, 'lane-calls')
    const fakeBin = path.join(root, 'fake-opencode.sh')
    writeExecutable(fakeBin, `#!/bin/sh\nprintf 'call\\n' >> ${JSON.stringify(calls)}\nprintf '%s\\n' '{"status":"clean"}'\n`)
    writeTranscript(session.transcriptPath, [
      { type: 'user', message: { content: [{ type: 'text', text: 'shared interval' }] } },
    ])
    const env = {
      CLAUDE_CODE_SESSION_ID: session.sessionId,
      CLAUDE_CONFIG_DIR: session.configDir,
      WT_QUEUE_GATE_DIR: session.stateDir,
      WT_AUTONOMY_WATCH_MANDATE_DIR: session.stateDir,
      WT_WAKE_SPOOL: session.spoolDir,
      WT_OBSERVER_BIN: fakeBin,
      WT_OBSERVER_LANE_INTERVAL_MINUTES: '30',
    }

    const first = spawnObserver({ ...env, WT_OBSERVER_COST_LOG: path.join(root, 'cost-a.jsonl') }, ['--project', session.projectDir, '--once'])
    const second = spawnObserver({ ...env, WT_OBSERVER_COST_LOG: path.join(root, 'cost-b.jsonl') }, ['--project', session.projectDir, '--once'])
    await waitFor(() => first.child.exitCode !== null && second.child.exitCode !== null)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['call'])
  })

  it('emits a premature-stop spool message without consulting the model lane', async () => {
    const root = tempRoot('wt-observer-stop-')
    const session = setupSession(root)
    const touched = path.join(root, 'lane-touched')
    const fakeBin = path.join(root, 'fake-opencode.sh')
    writeExecutable(fakeBin, `#!/bin/sh\nprintf x > ${JSON.stringify(touched)}\nexit 0\n`)

    writeTranscript(session.transcriptPath, [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done with this batch' }] } },
    ])
    const quietAt = new Date(Date.now() - 6 * 60_000)
    utimesSync(session.transcriptPath, quietAt, quietAt)
    writeFileSync(path.join(session.stateDir, `engine-${session.projectDir.replace(/[^A-Za-z0-9-]/g, '-')}.json`), JSON.stringify({ declaredAtMs: Date.now(), sessionId: session.sessionId }), 'utf8')
    writeFileSync(
      path.join(session.stateDir, queueSnapshotFileName(session.projectDir)),
      JSON.stringify({ open: 3, at: Date.now(), next: 'Card 42' }),
      'utf8',
    )

    const run = spawnObserver({
      CLAUDE_CODE_SESSION_ID: session.sessionId,
      CLAUDE_CONFIG_DIR: session.configDir,
      WT_QUEUE_GATE_DIR: session.stateDir,
      WT_AUTONOMY_WATCH_MANDATE_DIR: session.stateDir,
      WT_WAKE_SPOOL: session.spoolDir,
      WT_OBSERVER_BIN: fakeBin,
    }, ['--project', session.projectDir, '--once'])

    await waitFor(() => run.child.exitCode !== null)
    const names = readFileSync(path.join(session.spoolDir, readdirSync(session.spoolDir).find((name) => name.endsWith('.txt')) || ''), 'utf8')
    expect(names.trim()).toBe('Observer: possible premature stop while open work remains.\nCard: Card 42')
    expect(existsSync(touched)).toBe(false)
    expect(run.stderr()).toBe('')
  })

  it('writes stderr when the external lane cannot be measured cleanly', async () => {
    const root = tempRoot('wt-observer-degraded-')
    const session = setupSession(root)
    writeTranscript(session.transcriptPath, [
      { type: 'user', message: { content: [{ type: 'text', text: 'please review this' }] } },
    ])

    const run = spawnObserver({
      CLAUDE_CODE_SESSION_ID: session.sessionId,
      CLAUDE_CONFIG_DIR: session.configDir,
      WT_QUEUE_GATE_DIR: session.stateDir,
      WT_AUTONOMY_WATCH_MANDATE_DIR: session.stateDir,
      WT_WAKE_SPOOL: session.spoolDir,
      WT_OBSERVER_BIN: path.join(root, 'missing-opencode'),
    }, ['--project', session.projectDir, '--once'])

    await waitFor(() => run.child.exitCode !== null)
    expect(run.stderr()).toContain('WT_OBSERVER DEGRADED: observer lane failed')
  })

  it('reports a degraded pass and emits no spool message when the lesson index is absent', async () => {
    const root = tempRoot('wt-observer-no-index-')
    const session = setupSession(root)
    const touched = path.join(root, 'lane-touched')
    const fakeBin = path.join(root, 'fake-opencode.sh')
    writeExecutable(fakeBin, `#!/bin/sh\nprintf x > ${JSON.stringify(touched)}\nprintf '%s\\n' '{"status":"clean"}'\n`)
    rmSync(session.lessonIndexPath, { force: true })
    writeTranscript(session.transcriptPath, [
      { type: 'user', message: { content: [{ type: 'text', text: 'inspect the repo' }] } },
    ])

    const run = spawnObserver({
      CLAUDE_CODE_SESSION_ID: session.sessionId,
      CLAUDE_CONFIG_DIR: session.configDir,
      WT_QUEUE_GATE_DIR: session.stateDir,
      WT_AUTONOMY_WATCH_MANDATE_DIR: session.stateDir,
      WT_WAKE_SPOOL: session.spoolDir,
      WT_OBSERVER_BIN: fakeBin,
    }, ['--project', session.projectDir, '--once'])

    await waitFor(() => run.child.exitCode !== null)
    expect(run.stderr()).toContain(`WT_OBSERVER DEGRADED: lesson index unreadable at ${session.lessonIndexPath}`)
    expect(readdirSync(session.spoolDir).filter((name) => name.endsWith('.txt'))).toEqual([])
    expect(existsSync(touched)).toBe(false)
  })

  it('emits a lesson finding, includes evidence, and passes only the index plus tool names into the lane task', async () => {
    const root = tempRoot('wt-observer-finding-')
    const session = setupSession(root)
    const capture = path.join(root, 'task.md')
    const fakeBin = path.join(root, 'fake-opencode.sh')
    writeExecutable(fakeBin, `#!/bin/sh
task=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-f" ]; then
    shift
    task="$1"
  fi
  shift
done
cp "$task" ${JSON.stringify(capture)}
printf '%s\n' '{"type":"text","part":{"text":"{\\"status\\":\\"finding\\",\\"observation\\":\\"recorded lesson matched\\",\\"fiche\\":\\"sample-lesson\\",\\"evidence\\":\\"assistant: [tool Bash]\\"}"}}'
printf '%s\n' '{"type":"step_finish","part":{"tokens":{"input":100,"output":20,"reasoning":5,"total":125,"cache":{"read":80,"write":10}}}}'
`)

    writeTranscript(session.transcriptPath, [
      { type: 'user', message: { content: [{ type: 'text', text: 'inspect the repo' }] } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I inspected it.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'SECRET TOOL OUTPUT' },
          ],
        },
      },
    ])

    const run = spawnObserver({
      CLAUDE_CODE_SESSION_ID: session.sessionId,
      CLAUDE_CONFIG_DIR: session.configDir,
      WT_QUEUE_GATE_DIR: session.stateDir,
      WT_AUTONOMY_WATCH_MANDATE_DIR: session.stateDir,
      WT_WAKE_SPOOL: session.spoolDir,
      WT_OBSERVER_BIN: fakeBin,
      WT_OBSERVER_MAX_DELTA_BYTES: '30',
    }, ['--project', session.projectDir, '--once'])

    await waitFor(() => run.child.exitCode !== null)
    const spoolFile = readdirSync(session.spoolDir).find((name) => name.endsWith('.txt'))
    expect(spoolFile).toBeTruthy()
    const body = readFileSync(path.join(session.spoolDir, String(spoolFile)), 'utf8').trim().split('\n')
    expect(body).toEqual([
      'Observer: recorded lesson matched',
      'Fiche: sample-lesson',
      'Evidence: assistant: [tool Bash] [delta truncated]',
    ])
    const task = readFileSync(capture, 'utf8')
    expect(task).toContain('assistant: [tool Bash]')
    expect(task).toContain('sample-lesson - Check repository inspection against the recorded lesson.')
    expect(task).not.toContain('Follow the rule.')
    expect(task).not.toContain('## Rules corpus')
    expect(task).not.toContain('SECRET TOOL OUTPUT')
    const cost = JSON.parse(readFileSync(path.join(root, 'lane-cost.jsonl'), 'utf8').trim())
    expect(cost).toMatchObject({
      inputBytes: observerLaneInputBytes(task),
      tokens: { input: 100, output: 20, reasoning: 5, total: 125, cacheRead: 80, cacheWrite: 10 },
      outcome: 'finding',
      trigger: 'once',
    })
    expect(run.stderr()).toBe('')
  })
})

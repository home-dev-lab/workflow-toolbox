import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { journalFixture } from './fixtures/work-journal.js'

// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import * as api from '../../../../plugin/bin/lib/work-journal.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { sourceKey } from '../../../../plugin/bin/lib/work-journal-recorders.mjs'
const fixtures: ReturnType<typeof journalFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup() })
function fixture() { const f = journalFixture(); fixtures.push(f); return f }
function context(f: ReturnType<typeof fixture>) { return api.resolveJournal({}, f.env) }
function entries(f: ReturnType<typeof fixture>) { return api.verifyJournal(context(f)).lines }
function call(f: ReturnType<typeof fixture>, command: string, id = 'call') { return { cwd: f.project, tool_name: 'Bash', tool_use_id: id, tool_input: { command } } }
function pre(f: ReturnType<typeof fixture>, command: string, id = 'call') { expect(f.hook('PreToolUse', call(f, command, id)).status).toBe(0) }
function post(f: ReturnType<typeof fixture>, command: string, id = 'call', extra = {}) { const result = f.hook('PostToolUse', { ...call(f, command, id), ...extra }); expect(result.status).toBe(0); return result }
function outcomes(f: ReturnType<typeof fixture>) {
  const dir = join(context(f).store, 'outcomes')
  return readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
}

describe('work journal hook ledgers and pairing', () => {
  it('fails visible, with no session failure, on an internal store refusal', () => {
    const f = fixture()
    f.env.WT_WORK_JOURNAL_DIR = join(f.project, 'forbidden')
    const result = f.hook('SessionStart')
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).toContain('inside a repository')
  })
  it('ignores unmatched tools and quoted command mentions without touching storage', () => {
    const f = fixture()
    for (const payload of [{ tool_name: 'Read' }, call(f, 'echo "git commit"'), call(f, 'ls')]) {
      const result = f.hook('PostToolUse', payload)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
    }
    expect(existsSync(f.env.WT_WORK_JOURNAL_DIR)).toBe(false)
  })
  it('records two commits, even when the command resets HEAD back afterwards', () => {
    const f = fixture(); f.init(); f.hook('SessionStart')
    const command = 'git commit --allow-empty -m one; git commit --allow-empty -m two; git reset --hard HEAD~1'
    pre(f, command)
    f.git('commit', '--allow-empty', '-m', 'one'); f.git('commit', '--allow-empty', '-m', 'two'); f.git('reset', '--hard', 'HEAD~1')
    post(f, command)
    expect(entries(f).map((line: { kind: string }) => line.kind)).toEqual(['commit', 'commit'])
    expect(outcomes(f).filter((item) => item.outcome === 'recorded')).toHaveLength(2)
    expect(new Set(outcomes(f).map((item) => item.actId)).size).toBe(2)
  })
  it('deduplicates repeated PostToolUse delivery and amended commits remain separate acts', () => {
    const f = fixture(); f.init(); f.hook('SessionStart')
    pre(f, 'git commit --allow-empty -m first'); f.git('commit', '--allow-empty', '-m', 'first'); post(f, 'git commit --allow-empty -m first')
    post(f, 'git commit --allow-empty -m first')
    pre(f, 'git commit --amend --allow-empty -m amended', 'amend'); f.git('commit', '--amend', '--allow-empty', '-m', 'amended'); post(f, 'git commit --amend --allow-empty -m amended', 'amend')
    expect(entries(f)).toHaveLength(2)
  })
  it('records a fast-forward as one merge act, not its old commits again', () => {
    const f = fixture(); f.init(); f.hook('SessionStart')
    f.git('commit', '--allow-empty', '-m', 'base'); f.git('checkout', '-b', 'topic'); f.git('commit', '--allow-empty', '-m', 'topic'); f.git('checkout', 'feature')
    pre(f, 'git merge topic'); f.git('merge', 'topic'); post(f, 'git merge topic')
    expect(entries(f).map((line: { kind: string }) => line.kind)).toEqual(['merge'])
  })
  it('records a merge commit from its reflog entry', () => {
    const f = fixture(); f.init(); f.hook('SessionStart')
    f.git('commit', '--allow-empty', '-m', 'base'); f.git('checkout', '-b', 'topic'); f.git('commit', '--allow-empty', '-m', 'topic'); f.git('checkout', 'feature'); f.git('commit', '--allow-empty', '-m', 'other')
    pre(f, 'git merge topic'); f.git('merge', 'topic', '-m', 'merge'); post(f, 'git merge topic')
    expect(entries(f)[0].kind).toBe('merge')
  })
  it('does not guess a commit without PreToolUse or when the ledger did not change', () => {
    const f = fixture(); f.init(); f.hook('SessionStart')
    post(f, 'git commit -m missed')
    pre(f, 'git commit -m failed', 'failed'); post(f, 'git commit -m failed', 'failed')
    expect(entries(f)).toHaveLength(0)
    expect(outcomes(f).map((item) => item.outcome)).toEqual(['failed:no-pre-snapshot', 'nothing-new'])
  })
  it('records accepted pushes from tracking-ref movement; rejection is unknown', () => {
    const f = fixture(); f.init(); f.hook('SessionStart')
    const remote = join(f.root, 'remote.git')
    expect(spawnSync('git', ['init', '--bare', remote], { encoding: 'utf8', env: f.env }).status).toBe(0)
    f.git('remote', 'add', 'origin', remote); f.git('commit', '--allow-empty', '-m', 'base'); f.git('push', '-u', 'origin', 'feature'); f.git('commit', '--allow-empty', '-m', 'next')
    pre(f, 'git push origin feature'); f.git('push', 'origin', 'feature'); post(f, 'git push origin feature')
    pre(f, 'git push origin feature', 'rejected'); post(f, 'git push origin feature', 'rejected')
    expect(entries(f).map((line: { kind: string }) => line.kind)).toEqual(['push'])
    expect(outcomes(f).at(-1).outcome).toBe('unknown')
  })
  it('records tag deltas, never the pre-existing tag mentioned by a failed command', () => {
    const f = fixture(); f.init(); f.hook('SessionStart'); f.git('commit', '--allow-empty', '-m', 'base'); f.git('tag', 'old')
    pre(f, 'git tag old'); post(f, 'git tag old')
    pre(f, 'git tag new', 'new'); f.git('tag', 'new'); post(f, 'git tag new', 'new')
    expect(entries(f)).toHaveLength(1)
    expect(entries(f)[0].text).toContain('new')
  })
  it.each(['pnpm publish', 'npm publish', 'gh release create v1'])('treats %s as unknown without a captured success marker', (command) => {
    const f = fixture(); f.hook('SessionStart')
    post(f, command, 'publish', { tool_response: { success: true, exitCode: 0, stdout: 'published' } })
    expect(entries(f)).toHaveLength(0)
    expect(outcomes(f)[0].outcome).toBe('unknown')
  })
  it('records Done only from a card response, including a subagent move', () => {
    const f = fixture(); f.board(); f.hook('SessionStart')
    writeFileSync(join(context(f).store, 'board.json'), JSON.stringify({ boardId: 'board', doneId: 'done', baseUrl: 'https://boards.example.test' }))
    const move = { tool_name: 'mcp__planka__move_card', tool_use_id: 'move', agent_id: 'pilot', tool_input: { cardId: '1234567890', listId: 'done' } }
    expect(f.hook('PostToolUse', { ...move, tool_response: { id: '1234567890', listId: 'done', name: 'Completed task' } }).status).toBe(0)
    f.hook('PostToolUse', { ...move, tool_use_id: 'bad', tool_response: { isError: true, content: [{ text: 'failed' }] } })
    expect(entries(f)).toHaveLength(1)
    expect(entries(f)[0].actor).toBe('subagent')
    expect(outcomes(f).at(-1).outcome).toMatch(/^failed:/)
    writeFileSync(join(f.project, '.claude', 'planka.json'), JSON.stringify({ boardId: 'other-board' }))
    f.hook('PostToolUse', { ...move, tool_use_id: 'stale-cache', tool_input: { cardId: '1234567890', listId: 'other-done' }, tool_response: { id: '1234567890', listId: 'other-done' } })
    expect(outcomes(f).at(-1).outcome).toBe('failed:no-board-cache')
    expect(entries(f)).toHaveLength(1)
  })
  it('applies generic scalar templates and rejects tools outside registered families loudly', () => {
    const f = fixture(); mkdirSync(join(f.project, '.claude'))
    writeFileSync(join(f.project, '.claude', 'work-journal.json'), JSON.stringify({ recorders: [{ id: 'send', kind: 'tool', tag: 'message', tool: '^mcp__chat__send$', sentence: 'Sent {{tool_input.channel}}', link: '{{tool_response.url}}', subject: 'chat', actors: ['unknown'] }] }))
    f.hook('PostToolUse', { tool_name: 'mcp__chat__send', tool_use_id: 'send', tool_input: { channel: 'team' }, tool_response: { url: 'https://example.test/message' } })
    expect(entries(f)[0].text).toBe('Sent team')
    writeFileSync(join(f.project, '.claude', 'work-journal.json'), JSON.stringify({ recorders: [{ id: 'unobservable', kind: 'tool', tag: 'message', tool: 'Read', sentence: 'Read', link: 'file' }] }))
    const result = f.hook('SessionStart')
    expect(result.stdout + result.stderr).toContain('unobservable')
    const url = 'https://code.example.test/org/repo/pull/7'
    post(f, 'gh pr create', 'pr-created', { tool_response: { stdout: url } })
    expect(entries(f).filter((line: { kind: string }) => line.kind === 'pr').map((line: { link: string }) => line.link)).toEqual([url])
    post(f, 'gh pr merge 7', 'pr-unknown', { tool_response: { stdout: 'No URL' } })
    expect(outcomes(f).at(-1).outcome).toBe('unknown')
    post(f, 'gh pr merge 7', 'pr-error', { tool_response: { stdout: url, isError: true } })
    expect(entries(f).filter((line: { kind: string }) => line.kind === 'pr')).toHaveLength(1)
  })
  it('warns at Stop for disabled outward recorders, unknown outcomes and missing per-act outcomes', () => {
    const f = fixture(); mkdirSync(join(f.project, '.claude'))
    writeFileSync(join(f.project, '.claude', 'work-journal.json'), JSON.stringify({ disable: ['git'] }))
    writeFileSync(f.transcript, `${JSON.stringify({ type: 'user', message: { content: 'Do the work' } })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'git commit -m change' } }] } })}\n`)
    const stop = f.hook('Stop')
    expect(stop.status).toBe(0)
    expect(stop.stdout).toContain('recorder disabled by project')
    expect(stop.stdout).not.toContain('"decision":"block"')
    writeFileSync(join(f.project, '.claude', 'work-journal.json'), '{}')
    f.hook('SessionStart')
    post(f, 'pnpm publish', 'publish')
    writeFileSync(f.transcript, [
      { type: 'user', message: { content: 'Publish' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'publish', name: 'Bash', input: { command: 'pnpm publish' } }] } },
    ].map((record) => JSON.stringify(record)).join('\n'))
    expect(f.hook('Stop').stdout).toContain('unknown')

    const ids = ['0000000000000001', '0000000000000002', '0000000000000003']
    const key = sourceKey({ session_id: 'session', tool_use_id: 'partial' })
    writeFileSync(join(context(f).store, 'detections', `${key}-git.json`), JSON.stringify(ids.map((id) => ({ id }))))
    const completed = ids.slice(0, 2).map((actId) => JSON.stringify({ src: 'partial', rec: 'git', actId, outcome: 'recorded', hashes: [] }))
    const outcomeFile = join(context(f).store, 'outcomes', '2026-06-02.ndjson')
    writeFileSync(outcomeFile, `${completed.join('\n')}\n`)
    writeFileSync(f.transcript, [
      { type: 'user', message: { content: 'Commit three changes' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'partial', name: 'Bash', input: { command: 'git commit -m one; git commit -m two; git commit -m three' } }] } },
    ].map((record) => JSON.stringify(record)).join('\n'))
    expect(f.hook('Stop').stdout).toContain(`${ids[2]}: missing outcome`)
    writeFileSync(outcomeFile, `${completed.join('\n')}\n${JSON.stringify({ src: 'partial', rec: 'git', actId: ids[2], outcome: 'recorded', hashes: [] })}\n`)
    expect(f.hook('Stop').stdout).toBe('')
  })
  it('does not count calls before the last real user turn or a nothing-new outcome as missing', () => {
    const f = fixture(); f.init(); f.hook('SessionStart')
    pre(f, 'git commit -m no-change'); post(f, 'git commit -m no-change')
    writeFileSync(f.transcript, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old', name: 'Bash', input: { command: 'pnpm publish' } }] } },
      { type: 'user', message: { content: 'New turn' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'git commit -m no-change' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'no change' }] } },
    ].map((record) => JSON.stringify(record)).join('\n'))
    expect(f.hook('Stop').stdout).toBe('')
  })
})

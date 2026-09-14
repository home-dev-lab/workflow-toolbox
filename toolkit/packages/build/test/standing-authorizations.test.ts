import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error shipped JavaScript module
import { findAuthorization, parseAuthorizations } from '../../../../plugin/bin/lib/standing-authorizations.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-escalation-journal-hook.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(tag: string) {
  const value = mkdtempSync(join(tmpdir(), `wt-standing-auth-${tag}-`))
  roots.push(value)
  return value
}

function runHook(cwd: string, message: string, journal: string) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', cwd, session_id: 'standing-auth-test', last_assistant_message: message }),
    encoding: 'utf8',
    env: { ...process.env, WT_GUARD_JOURNAL_DIR: journal },
  })
}

function journalClass(dir: string) {
  const [file] = readdirSync(dir)
  if (!file) throw new Error('expected a guard-journal event')
  return JSON.parse(readFileSync(join(dir, file), 'utf8').trim()).class
}

describe('standing authorizations', () => {
  const line = '- commit completed work — when required gates pass — never publish or force-push — given 2026-09-09, Atrium/signed owner message'

  it('parses only complete owner-granted lines and refuses missing provenance', () => {
    expect(parseAuthorizations(`${line}\n- commit completed work — when gates pass — never publish`)).toEqual([
      { act: 'commit completed work', condition: 'required gates pass', exclusion: 'publish or force-push', given: '2026-09-09, Atrium/signed owner message', raw: line },
    ])
  })

  it('requires every act word in the description, case-insensitively', () => {
    const list = parseAuthorizations(line)
    expect(findAuthorization(list, 'I authorize COMMIT completed work now.')).toEqual(list[0])
    expect(findAuthorization(list, 'I authorize commit now.')).toBeNull()
  })

  it('warns and journals a covered fenced escalation with the quoted authorization', () => {
    const cwd = root('covered')
    const journal = join(cwd, 'journal')
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'AUTHORIZATIONS.md'), `${line}\n`)

    const result = runHook(cwd, 'Need approval:\n\n```\nI authorize commit completed work now.\n```', journal)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`This escalation was already authorized: ${line}`)
    expect(journalClass(journal)).toBe('escalation:covered')
  })

  it('journals an uncovered escalation without denying or emitting a prompt', () => {
    const cwd = root('uncovered')
    const journal = join(cwd, 'journal')
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'AUTHORIZATIONS.md'), '- publish release — when requested — never skip review\n')

    const result = runHook(cwd, '```\nJ\'autorise commit completed work now.\n```', journal)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(journalClass(journal)).toBe('escalation:uncovered')
  })
})

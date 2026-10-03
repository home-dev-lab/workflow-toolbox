#!/usr/bin/env node
import * as io from './lib/host/work-journal-io.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { dayOf, digestJournal, resolveJournal, restoreJournal, verifyJournal } from './lib/work-journal.mjs'
import { addUnsynced, exportClosed, openUnsynced, resolveUnsynced, retireProgress, setupBoard, unsyncedDetail } from './lib/work-journal-commands.mjs'
import path from 'node:path'

const HELP = `Work journal — mechanical, hash-linked index of project acts.
Usage: wt-work-journal.mjs <command>
  show [--date YYYY-MM-DD | --days N] [--subject TAG] [--grep TEXT]
  digest | verify | setup-board | unlock
  unsynced "sentence" [--detail-file FILE]   (otherwise full detail on stdin)
  unsynced --list | resolve HASH
  retire-progress [--archive-only]
  export-closed --to ABSOLUTE_DIRECTORY | restore YYYY-MM-DD
All commands require CLAUDECODE=1 (harness provenance, not main-session authentication).
verify: 0 intact, 1 broken, 2 unreadable. Overrides: WT_WORK_JOURNAL_DIR and
WT_WORK_JOURNAL_ARCHIVE_DIR; both still refuse repository-local storage.
`
function option(args, name) { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] }
function show(ctx, args) {
  const verified = verifyJournal(ctx)
  if (!verified.ok) throw new Error('show refused: journal did not verify')
  const date = option(args, '--date')
  const days = Number(option(args, '--days') || 30)
  if (!Number.isInteger(days) || days < 1 || days > 36600 || (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('invalid show date or days')
  const since = new Date(ctx.now); since.setDate(since.getDate() - days + 1)
  const subject = option(args, '--subject')
  const grep = option(args, '--grep')?.toLowerCase()
  return verified.lines.filter((line) => (date ? line.day === date : line.day >= dayOf(since)) && (!subject || line.subject === subject)
    && (!grep || `${line.subject} ${line.text} ${line.link}`.toLowerCase().includes(grep)))
    .map((line) => `${line.ts} [${line.subject}] ${line.text} — ${line.link} (${line.hash})`).join('\n')
}
export async function runJournalCli(args, { env = process.env, print = console.log, error = console.error, boardClient, stdin = () => io.read(0) } = {}) {
  if (args.includes('--help') || args.includes('-h')) { print(HELP); return 0 }
  if (env.CLAUDECODE !== '1') { error('journal CLI refused: CLAUDECODE=1 required'); return 2 }
  const command = args[0]
  if (!['show', 'digest', 'verify', 'setup-board', 'unlock', 'unsynced', 'resolve', 'retire-progress', 'export-closed', 'restore'].includes(command)) { error(HELP); return 2 }
  try {
    const ctx = resolveJournal({}, env)
    if (command === 'verify') {
      const result = verifyJournal(ctx)
      print(result.ok ? 'Journal intact.' : result.errors.join('\n'))
      return result.ok ? 0 : 1
    }
    if (command === 'show') print(show(ctx, args))
    else if (command === 'digest') print(digestJournal(ctx))
    else if (command === 'setup-board') print(JSON.stringify(await setupBoard(ctx, boardClient)))
    else if (command === 'unlock') { io.unlockDead(path.join(ctx.store, 'lock')); print('Dead journal lock removed; start a session to recover pending acts.') }
    else if (command === 'retire-progress') print(JSON.stringify(retireProgress(ctx, { archiveOnly: args.includes('--archive-only') })))
    else if (command === 'export-closed') print(exportClosed(ctx, option(args, '--to')).join('\n'))
    else if (command === 'restore') { restoreJournal(ctx, args[1]); print(`Restored ${args[1]}.`) }
    else if (command === 'unsynced' && args.includes('--list')) {
      for (const line of openUnsynced(ctx)) print(`${line.hash} [${line.subject}] ${line.text}\n${unsyncedDetail(ctx, line)}`)
    } else {
      const result = command === 'resolve' ? resolveUnsynced(ctx, args[1]) : addUnsynced(ctx, args[1], option(args, '--detail-file') ? io.read(option(args, '--detail-file')) : stdin())
      print(result.outcome === 'recorded' ? result.line.hash : `queued, not yet recorded: ${result.error}`)
      return result.outcome === 'recorded' ? 0 : 1
    }
    return 0
  } catch (failure) { error(failure.message); return command === 'verify' ? 2 : 1 }
}
if (isInvokedDirectly(import.meta.url)) process.exitCode = await runJournalCli(process.argv.slice(2))

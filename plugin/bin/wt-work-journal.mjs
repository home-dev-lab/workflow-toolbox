#!/usr/bin/env node
import * as io from './lib/host/work-journal-io.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { dayOf, digestJournal, resolveJournal, restoreJournal, verifyJournal } from './lib/work-journal.mjs'
import { addUnsynced, exportClosed, openUnsynced, resolveUnsynced, retireProgress, setupBoard, unsyncedDetail } from './lib/work-journal-commands.mjs'
import path from 'node:path'

const HELP = `Work journal (RETIRED) — mechanical, hash-linked index of project acts.
Retired: no hook records new acts any more. Use show, digest, verify, restore,
unlock and export-closed to read, check and export an existing journal.
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
function printVerification(ctx, _args, print) {
  const result = verifyJournal(ctx)
  print(result.ok ? 'Journal intact.' : result.errors.join('\n'))
  return result.ok ? 0 : 1
}
function printActResult(result, print) {
  print(result.outcome === 'recorded' ? result.line.hash : `queued, not yet recorded: ${result.error}`)
  return result.outcome === 'recorded' ? 0 : 1
}
function verifiedQuietly(ctx) {
  // A verifier that cannot even read its state (a truncated head.json) is a failed verification, not a crash.
  try { return verifyJournal(ctx).ok } catch { return false }
}
function printDigest(ctx, _args, print) {
  if (!verifiedQuietly(ctx)) print('LOUD: work journal: journal did not verify; run wt-work-journal.mjs verify')
  print(digestJournal(ctx))
  return 0
}
function recordUnsynced(ctx, args, print, stdin) {
  if (args.includes('--list')) {
    for (const line of openUnsynced(ctx)) print(`${line.hash} [${line.subject}] ${line.text}\n${unsyncedDetail(ctx, line)}`)
    return 0
  }
  const result = addUnsynced(ctx, args[1], option(args, '--detail-file') ? io.read(option(args, '--detail-file')) : stdin())
  return printActResult(result, print)
}
const COMMANDS = new Map([
  ['verify', printVerification],
  ['show', (ctx, args, print) => { print(show(ctx, args)); return 0 }],
  ['digest', printDigest],
  ['setup-board', null],
  ['unlock', (ctx, _args, print) => { io.unlockDead(path.join(ctx.store, 'lock')); print('Dead journal lock removed; the next journal write recovers pending acts.'); return 0 }],
  ['retire-progress', (ctx, args, print) => { print(JSON.stringify(retireProgress(ctx, { archiveOnly: args.includes('--archive-only') }))); return 0 }],
  ['export-closed', (ctx, args, print) => { print(exportClosed(ctx, option(args, '--to')).join('\n')); return 0 }],
  ['restore', (ctx, args, print) => { restoreJournal(ctx, args[1]); print(`Restored ${args[1]}.`); return 0 }],
  ['unsynced', recordUnsynced],
  ['resolve', (ctx, args, print) => { const result = resolveUnsynced(ctx, args[1]); return printActResult(result, print) }],
])
const isHelp = (arg) => arg === '--help' || arg === '-h'
// Help is a request only in a command position: first, or right after a known command. Anywhere else the token is an
// option value or follows an unknown option, and printing the usage there would hide the refusal.
const helpRequested = (args) => isHelp(args[0]) || (COMMANDS.has(args[0]) && isHelp(args[1]))
function cliAdmission(args, env, print, error) {
  if (helpRequested(args)) { print(HELP); return { status: 0 } }
  if (env.CLAUDECODE !== '1') { error('journal CLI refused: CLAUDECODE=1 required'); return { status: 2 } }
  const command = args[0]
  if (!COMMANDS.has(command)) { error(HELP); return { status: 2 } }
  return { command }
}
export async function runJournalCli(args, { env = process.env, print = console.log, error = console.error, boardClient, stdin = () => io.read(0) } = {}) {
  const admitted = cliAdmission(args, env, print, error)
  if (admitted.status !== undefined) return admitted.status
  const command = admitted.command
  try {
    const ctx = resolveJournal({}, env)
    if (command !== 'setup-board') {
      const handler = COMMANDS.get(command)
      return handler(ctx, args, print, stdin)
    }
    print(JSON.stringify(await setupBoard(ctx, boardClient)))
    return 0
  } catch (failure) { error(failure.message); return command === 'verify' ? 2 : 1 }
}
if (isInvokedDirectly(import.meta.url)) process.exitCode = await runJournalCli(process.argv.slice(2))

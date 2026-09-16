#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, index, all) => arg.startsWith('--') ? [...acc, [arg.slice(2), all[index + 1]]] : acc, []))
const pluginDir = path.resolve(args['plugin-dir'])
const cwdA = path.resolve(args['cwd-a'])
const cwdB = path.resolve(args['cwd-b'])
const out = path.resolve(args.out)
const expect = args.expect ?? 'isolated'
const prefix = `wir-state-${process.pid}-${Date.now()}`
const sessions = [`${prefix}-a`, `${prefix}-b`]
const sleep = (ms) => execFileSync('sleep', [String(ms / 1000)])
const tmux = (...tmuxArgs) => execFileSync('tmux', tmuxArgs, { encoding: 'utf8' })
const capture = (session) => tmux('capture-pane', '-p', '-t', session)
const paneOpen = (text) => text.split('\n').some((line) => line.includes('What is running'))

function launch(session, cwd) {
  tmux('new-session', '-d', '-s', session, '-c', cwd, '-x', '160', '-y', '50', `env -u ATRIUM_IDENTITY claude --model haiku --setting-sources '' --tools '' --strict-mcp-config --plugin-dir "${pluginDir}"`)
}

function awaitPrompt(session) {
  let trusted = false
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const text = capture(session)
    if (!trusted && text.includes('Yes, I trust this folder')) {
      tmux('send-keys', '-t', session, 'Down', 'Enter')
      trusted = true
    } else if (text.includes('❯')) return
    sleep(500)
  }
  throw new Error(`${session} never reached a prompt`)
}

fs.mkdirSync(out, { recursive: true })
let exit = 0
try {
  launch(sessions[0], cwdA)
  awaitPrompt(sessions[0])
  tmux('send-keys', '-t', sessions[0], '/wir', 'Enter')
  for (let attempt = 0; attempt < 120 && !paneOpen(capture(sessions[0])); attempt += 1) sleep(500)
  const first = capture(sessions[0])
  if (!paneOpen(first)) {
    fs.writeFileSync(path.join(out, 'session-a-failed.txt'), first)
    throw new Error('first session did not open the pane')
  }

  launch(sessions[1], cwdB)
  awaitPrompt(sessions[1])
  sleep(3000)
  const second = capture(sessions[1])
  fs.writeFileSync(path.join(out, 'session-a-open.txt'), first)
  fs.writeFileSync(path.join(out, 'session-b-after-a-open.txt'), second)
  const shared = paneOpen(second)
  console.log(`session A pane: open`)
  console.log(`session B pane: ${shared ? 'open' : 'closed'}`)
  console.log(`captures: ${out}`)
  exit = expect === 'shared' ? (shared ? 0 : 1) : (shared ? 1 : 0)
} catch (error) {
  console.log(`ERROR ${error.message}`)
  exit = 2
} finally {
  for (const session of sessions) {
    try { tmux('kill-session', '-t', session) } catch {}
  }
}
console.log(`EXIT=${exit}`)
process.exit(exit)

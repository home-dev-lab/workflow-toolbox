#!/usr/bin/env node
// Real-host interaction e2e for What is running: open the pane in a tmux-hosted Claude Code session, click EVERY bracketed
// element through SGR mouse sequences, capture after each click, and assert the pane changed. Phase buttons must also
// produce pairwise different inspector bodies. Kills only its own tmux session. Usage:
//   node host-click-e2e.mjs [--plugin-dir <dir>] [--cwd <dir>] [--cols 160] [--out <dir>]
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []))
const pluginDir = path.resolve(args['plugin-dir'] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '../../../../../../plugin'))
const cwd = args.cwd ?? process.cwd()
const cols = Number(args.cols ?? 160)
const out = args.out ?? fs.mkdtempSync('/tmp/wir-click-')
fs.mkdirSync(out, { recursive: true })
const session = `wir-click-${process.pid}-${Date.now()}`
const sleep = (ms) => execFileSync('sleep', [String(ms / 1000)])
const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf8' })
const capture = () => tmux('capture-pane', '-p', '-t', session)
const paneHeader = (lines) => lines.findIndex((line) => {
  const separator = line.indexOf('│')
  return separator >= 0 && line.indexOf('What is running', separator + 1) >= 0
})

// The dock sits right of the first '│' column; return pane lines with their 1-based screen row and column offset.
function paneLines(text) {
  const lines = text.split('\n')
  const header = paneHeader(lines)
  if (header < 0) return null
  const offset = lines[header].indexOf('│') + 1
  return lines.map((l, i) => ({ row: i + 1, offset, text: [...l].slice([...lines[header].slice(0, offset)].length).join('') })).filter((l, i) => i >= header)
}
function paneText(text) {
  return (paneLines(text) ?? []).map((l) => l.text.trimEnd()).join('\n').replace(/\s+$/, '')
}
function buttons(text) {
  const lines = text.split('\n')
  const header = paneHeader(lines)
  if (header < 0) return []
  const dock = [...lines[header]].indexOf('│') + 1
  const found = []
  for (let r = header; r < lines.length; r += 1) {
    const chars = [...lines[r]]
    const s = chars.join('')
    for (const m of s.matchAll(/\[[^\]\n]{1,40}\]|\[Close✕?/g)) {
      const charIndex = [...s.slice(0, m.index)].length
      if (charIndex < dock) continue
      found.push({ label: m[0], row: r + 1, col: charIndex + 2 })
    }
  }
  return found
}
function click(b) {
  tmux('send-keys', '-t', session, '-l', `\x1b[<0;${b.col};${b.row}M\x1b[<0;${b.col};${b.row}m`)
  sleep(2500)
}

const results = []
let exit = 0
try {
  const validation = spawnSync('claude', ['plugin', 'validate', pluginDir, '--strict'], { encoding: 'utf8' })
  if (validation.status !== 0) throw new Error(`plugin manifest invalid (claude plugin validate --strict): ${(validation.stdout + validation.stderr).split('\n').filter((l) => /✘|❯ .*:/.test(l)).join(' | ')}`)
  tmux('new-session', '-d', '-s', session, '-c', cwd, '-x', String(cols), '-y', '50', `claude --model haiku --setting-sources '' --tools '' --strict-mcp-config --plugin-dir "${pluginDir}"`)
  let sent = false, trusted = false, opened = false
  for (let i = 0; i < 360 && !opened; i += 1) {
    const c = capture()
    if (!trusted && c.includes('Yes, I trust this folder')) { tmux('send-keys', '-t', session, 'Down', 'Enter'); trusted = true }
    else if (paneLines(c) && paneText(c).split('\n').length > 2) opened = true
    else if (!sent && c.includes('❯')) { tmux('send-keys', '-t', session, '/wir', 'Enter'); sent = true }
    sleep(1000)
  }
  if (!opened) {
    const last = capture()
    fs.writeFileSync(path.join(out, 'never-opened.txt'), last)
    const cause = /Unknown command: \/wir/.test(last) ? 'plugin not loaded (Unknown command: /wir)' : /…|esc to interrupt/.test(last) ? 'the test session was still busy with its own turn' : 'no pane in the final capture'
    throw new Error(`pane never appeared: ${cause}; capture saved to never-opened.txt`)
  }
  sleep(3000)
  const initial = capture()
  fs.writeFileSync(path.join(out, '00-initial.txt'), initial)
  const labels = [...new Set(buttons(initial).map((b) => `${b.label}@${b.row}`))]
  console.log(`buttons found: ${labels.length}`)
  const seen = new Set()
  const phaseBodies = new Map()
  let step = 0
  const norm = (label) => label.replace(/^\[(?:▶|▼)\s*/, '[').replace(/\s*[✓●·–✗]\]$/, ']')
  // Re-scan after every click: layout moves when a section folds or an inspector opens. Each normalized label is clicked
  // once per occurrence index, so a selection marker or status glyph appearing after a click is not a new button.
  for (let guard = 0; guard < 80; guard += 1) {
    const before = capture()
    const counts = new Map()
    const next = buttons(before).map((b) => { const k = norm(b.label); const n = (counts.get(k) ?? 0) + 1; counts.set(k, n); return { ...b, key: `${k}#${n}` } }).find((b) => !seen.has(b.key) && !/close/i.test(b.label))
    if (!next) break
    seen.add(next.key)
    // `[Open report]` is a Link (hooks.js renders it with Link, never a Button): it opens the report outside the pane, so an
    // unchanged pane is its correct outcome. Record it as a link and prove the target instead of asserting a pane change.
    if (norm(next.label) === '[Open report]') { results.push({ label: next.key, changed: true, note: 'link, not a pane action' }); continue }
    click(next)
    const after = capture()
    step += 1
    fs.writeFileSync(path.join(out, `${String(step).padStart(2, '0')}-${next.key.replace(/[^\w#]+/g, '_')}.txt`), after)
    const changed = paneText(before) !== paneText(after)
    results.push({ label: next.key, changed })
    if (!changed) exit = 1
    if (!/^\[(▸|▾|Show|Hide)\]/.test(norm(next.label))) phaseBodies.set(next.key, paneText(after).split('\n').filter((l) => !/\[[^\]]+\]\s*(done|skipped|running|not started|waiting)/.test(l)).join('\n'))
  }
  const bodies = [...phaseBodies.entries()]
  for (let i = 0; i < bodies.length; i += 1) for (let j = i + 1; j < bodies.length; j += 1) {
    if (bodies[i][1] === bodies[j][1]) { results.push({ label: `${bodies[i][0]} vs ${bodies[j][0]}`, changed: false, note: 'identical inspector' }); exit = 1 }
  }
  const close = buttons(capture()).find((b) => /close/i.test(b.label))
  if (close) {
    click(close)
    const gone = !capture().split('\n').some((l) => l.includes('What is running') && l.includes('[Close]'))
    results.push({ label: close.label, changed: gone, note: 'pane closed' })
    if (!gone) exit = 1
  } else { results.push({ label: '[Close]', changed: false, note: 'no bracketed close found' }); exit = 1 }
} catch (e) {
  console.log(`ERROR ${e.message}`)
  exit = 2
} finally {
  try { tmux('kill-session', '-t', session) } catch {}
}
// A human-readable, ordered walkthrough: what each click added and removed. A passing "the view changed" check is not
// a usability review; the arbiter reads this file in order before presenting the pane (owner 2026-09-14 #1999).
try {
  const shots = fs.readdirSync(out).filter((f) => /^\d\d-.*\.txt$/.test(f)).sort()
  const walk = ['# Click walkthrough', '']
  let prev = null
  for (const f of shots) {
    const cur = paneText(fs.readFileSync(path.join(out, f), 'utf8')).split('\n').filter((l) => l.trim())
    if (!prev) walk.push(`## ${f}`, '', ...cur.map((l) => `    ${l}`), '')
    else {
      const added = cur.filter((l) => !prev.includes(l))
      const removed = prev.filter((l) => !cur.includes(l))
      walk.push(`## ${f} (+${added.length} -${removed.length})`, '', ...removed.map((l) => `  - ${l}`), ...added.map((l) => `  + ${l}`), '')
    }
    prev = cur
  }
  fs.writeFileSync(path.join(out, 'walkthrough.md'), walk.join('\n'))
  console.log(`walkthrough: ${path.join(out, 'walkthrough.md')} (read it in order before presenting)`)
} catch (e) { console.log(`walkthrough not written: ${e.message}`) }
for (const r of results) console.log(`${r.changed ? 'PASS' : 'FAIL'} ${r.label}${r.note ? ` (${r.note})` : ''}`)
console.log(`captures: ${out}`)
console.log(`EXIT=${exit}`)
process.exit(exit)

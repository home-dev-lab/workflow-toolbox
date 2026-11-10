#!/usr/bin/env node
// wt-live-config-tree-guard-hook.mjs — PreToolUse/Bash guard against a git command that
// SWITCHES THE WORKING TREE of a LIVE ambient rules directory (a `<config-dir>/rules`
// checkout that Claude Code reads at every session start and every compaction).
//
// GENERALIZED from a private, machine-specific hook that matched a hard-coded
// `<home>/.claude*/rules` glob. This version resolves the live rules directory the same
// way wt-rule-edit-horizon-hook.mjs's isAmbientRule does: an explicit CLAUDE_CONFIG_DIR
// wins; otherwise any ancestor segment literally named `.claude` or `.claude-*` whose
// direct child is `rules`. Two hooks defining "the live rules directory" independently
// would drift the day one of them changes — this mirrors that definition on purpose
// rather than reinventing a narrower one.
//
// WHY. `git checkout <branch>` / `git switch` / `git reset --hard` inside a versioned
// rules directory rewrites the standing instructions every session on the machine reads —
// including sessions mid-arc, and including the one issuing the command, at its next
// compaction. Measured 2026-08-05: a pilot-orchestrator was one command away from checking
// out a working branch directly inside its live rules directory. It caught itself and used
// a worktree instead — nothing mechanical would have caught it otherwise. This is that
// mechanism, generalized for adoption.
//
// ⚠ THE CORRECT PATTERN, and it is what makes a denial cheap: work on rules happens in a
// WORKTREE, never by switching the live tree.
//     git -C <rules-dir> worktree add <path-outside-the-config-dir> -b <branch>
// That command is NOT matched here, deliberately — it is the remedy this guard names.
//
// ⚠ POSTURE — this is a NEW, unmeasured guard; the convention for one is to WARN until its
// false-positive rate has been measured on material it did not choose. It DEFAULTS TO WARN.
// An adopter who has confirmed (as the originating machine has, by field incident) that
// checkout/switch/reset --hard have no legitimate use on their live rules tree can opt into
// DENY with an env var in their OWN settings.json `env` block — never hard-coded here:
//     WT_LIVE_CONFIG_TREE_GUARD_MODE=deny   (default: warn; also accepts: off)
//
// ⚠⚠ SCOPE, stated so its silence is never mistaken for coverage:
//   · Only GIT commands are seen. A direct Edit/Write/rm/mv inside the live rules directory
//     is INVISIBLE to this guard — that is the LARGER half of the hazard surface, and it is
//     not mechanised here.
//   · A target reached through a shell variable, a glob, a symlink, or a script FILE that `cd`s
//     inside itself is unresolvable and is never guessed at — no verdict follows. A
//     `sh|bash|zsh -c '<script>'` is walked with its own `cd`s, three levels deep.
//   · INERT (no denial, no warning, ever) when the resolved rules directory is not itself a
//     git working tree (no `.git`) — nothing to switch means nothing to protect. Run this
//     file directly with `--diagnose` to see, for the CURRENT environment, whether the
//     guard is active — so inertness is a legible, checkable fact rather than a silent
//     no-op that looks identical to "installed and protecting".

import { existsSync, readFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'

const CLAUDE_DIR_SEGMENT = /^\.claude(-.*)?$/

/** Is `dirPath` (already absolute) the live ambient rules directory for this environment?
 *  Mirrors wt-rule-edit-horizon-hook.mjs's isAmbientRule, applied to a directory rather
 *  than a file path. */
function isLiveRulesDir(dirPath) {
  if (!dirPath) return false
  const segments = dirPath.split(sep).filter(Boolean)
  if (segments[segments.length - 1] !== 'rules') return false
  const parent = segments[segments.length - 2]
  if (parent && CLAUDE_DIR_SEGMENT.test(parent)) return true
  const configDir = process.env.CLAUDE_CONFIG_DIR
  if (!configDir) return false
  try {
    return resolve(configDir, 'rules') === dirPath
  } catch {
    return false
  }
}

/** Only a directory that both (a) matches the live-rules definition above AND (b) is
 *  itself a git working tree is a guard target — a non-git match is INERT by design. */
function isGuardedDir(dirPath) {
  if (!isLiveRulesDir(dirPath)) return false
  try {
    return existsSync(resolve(dirPath, '.git'))
  } catch {
    return false
  }
}

function resolveMode() {
  const raw = (process.env.WT_LIVE_CONFIG_TREE_GUARD_MODE || '').trim().toLowerCase()
  return raw === 'deny' || raw === 'off' ? raw : 'warn'
}

function readInput() {
  try {
    const raw = readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const GIT_WORD = /(?:^|\W)git$/
const UNRESOLVABLE = /[$*?`]/
// git's global options that take the NEXT word as their value (`git -c k=v switch` must not read
// `k=v` as the subcommand). Every other leading `-…` word is a flag without a value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source'])
// PATH_MAX on Linux: a RESOLVED directory longer than this cannot be opened, so it is no target.
const MAX_PATH_CHARS = 4096
const CHECKOUT_SWITCHES = /^(?:-[bB]|--orphan|--detach|-t$|--track)/
const CHECKOUT_PATHS_ONLY = /^(?:-p$|--patch$|--pathspec-from-file)/
const SHORT_FLAGS = /^-[a-zA-Z]+$/
const isCheckoutForce = (arg) => arg === '--force' || (SHORT_FLAGS.test(arg) && arg.includes('f'))

/** The whitespace words of one segment with their offsets, in one linear pass. */
function wordsOf(seg) {
  return Array.from(seg.matchAll(/\S+/g), (m) => ({ text: m[0], at: m.index }))
}

/** One quoted piece at `text[i]`: its unquoted text and the offset after it. An unclosed quote
 *  runs to the end of the text. */
function quotedPiece(text, i) {
  if (text[i] === "'") {
    const close = text.indexOf("'", i + 1)
    const end = close === -1 ? text.length : close
    return { piece: text.slice(i + 1, end), next: end + 1 }
  }
  const end = doubleQuoteEnd(text, i)
  return { piece: text.slice(i + 1, end).replace(/\\([\\"$`\n])/g, '$1'), next: end + 1 }
}

/** One shell WORD read from `text` at offset `at`, as the shell hands it to git: quotes removed,
 *  adjacent quoted and bare pieces joined, whitespace inside quotes kept. */
function lexWord(text, at) {
  let word = ''
  let i = at
  while (i < text.length && !BLANK.test(text[i])) {
    if (text[i] === "'" || text[i] === '"') {
      const { piece, next } = quotedPiece(text, i)
      word += piece
      i = next
    } else if (text[i] === '\\') {
      // A backslash-newline is a line continuation; any other escaped character is literal.
      if (text[i + 1] !== '\n') word += text[i + 1] ?? ''
      i += 2
    } else word += text[i++]
  }
  return { value: word, end: Math.min(i, text.length) }
}

/** The index of the first word that starts at or after `offset` (words are in offset order). */
function wordIndexAt(list, offset) {
  let low = 0
  let high = list.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (list[mid].at < offset) low = mid + 1
    else high = mid
  }
  return low
}

/** A global option's name and the offset (inside the word) of an attached value, or -1:
 *  `--work-tree=<v>`, `-C<v>`, or a bare name whose value is the next word. */
function optionSpelling(word) {
  const eq = word.startsWith('--') ? word.indexOf('=') : -1
  if (eq !== -1) return { name: word.slice(0, eq), attached: eq + 1 }
  if (word.startsWith('-C') && word.length > 2) return { name: '-C', attached: 2 }
  return { name: word, attached: -1 }
}

function recordOption(inv, name, value) {
  if (name === '-C') inv.dirs.push(value)
  if (name === '--work-tree') inv.workTree = value
  if (name === '--git-dir') inv.gitDir = value
}

/** Record one global option of `git` and return the index of the word after it. A value is read
 *  from the segment text as a shell word, so `-C "a  b"` and `--work-tree="x"` reach git's spelling. */
function globalOption(list, i, inv, seg) {
  const { name, attached } = optionSpelling(list[i].text)
  if (!GIT_VALUE_OPTIONS.has(name)) return i + 1
  if (attached === -1 && i + 1 >= list.length) return i + 1
  const start = attached === -1 ? list[i + 1].at : list[i].at + attached
  const { value, end } = lexWord(seg, start)
  recordOption(inv, name, value)
  return Math.max(i + 1, wordIndexAt(list, end))
}

/** `git [global options] <subcommand>` starting at the git word `list[at]`. */
function gitInvocation(list, at, seg) {
  const inv = { dirs: [], workTree: null, gitDir: null, subIndex: at + 1 }
  let i = at + 1
  while (i < list.length && list[i].text.startsWith('-')) i = globalOption(list, i, inv, seg)
  inv.subIndex = i
  return inv
}

/** A checkout moves HEAD unless it only restores paths (`--`, `-p`, a pathspec file). An option-led
 *  form (`--detach <ref>`, `-f <ref>`, `-q <ref>`) switches as surely as a bare `checkout <ref>`. */
function checkoutVerdict(list, from, shape) {
  if (shape.pathspec) return null
  let force = false
  for (let j = from; j < list.length; j++) {
    const arg = list[j].text
    if (arg === '--' || CHECKOUT_PATHS_ONLY.test(arg)) return null
    if (CHECKOUT_SWITCHES.test(arg) || !arg.startsWith('-')) return 'deny'
    force ||= isCheckoutForce(arg)
  }
  return force ? 'deny' : null
}

/** 'deny' | 'warn' | null for the subcommand of one git invocation. `shape` holds what is read
 *  from the whole segment (the offset of its last `--hard`, whether it has a ` -- ` pathspec
 *  separator), computed once so a long segment is scanned once, not once per git word. */
function subcommandVerdict(list, inv, shape) {
  const sub = list[inv.subIndex]
  if (!sub) return null
  if (/^checkout\b/.test(sub.text)) return checkoutVerdict(list, inv.subIndex + 1, shape)
  if (/^switch\b/.test(sub.text)) return 'deny'
  if (/^reset\b/.test(sub.text)) return shape.hardAt >= sub.at + 5 ? 'deny' : null
  // Ambiguous: these can be legitimate maintenance on the live tree. Never escalated past warn.
  return /^(?:merge|rebase|stash|cherry-pick)\b/.test(sub.text) ? 'warn' : null
}

function lastHardAt(seg) {
  let at = -1
  for (const m of seg.matchAll(/--hard\b/g)) at = m.index
  return at
}

/** The directories a git invocation acts on: its cumulative `-C` chain (else a `cd <path>` that
 *  opens the segment, else the shell's cwd), plus any `--work-tree` or `.git` `--git-dir` it names.
 *  An unresolvable spelling yields no directory: guessing produces false denials. */
function invocationDirs(inv, seg, cwd) {
  const base = inv.dirs.length > 0 ? chainedDir(inv.dirs, cwd) : spelledDir(segmentCd(seg) ?? cwd, cwd)
  if (!base) return []
  const dirs = [base]
  if (inv.workTree !== null) dirs.push(spelledDir(inv.workTree, base))
  if (inv.gitDir !== null && /(?:^|\/)\.git\/?$/.test(inv.gitDir)) {
    dirs.push(spelledDir(inv.gitDir.replace(/\/?\.git\/?$/, '') || '.', base))
  }
  return dirs.filter(Boolean)
}

/** One spelled path resolved against `cwd`; null for a variable, a glob or a substitution. */
function spelledDir(raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0 || UNRESOLVABLE.test(raw)) return null
  return resolveTarget(raw, cwd)
}

/** `resolve(dir, ...chunk)`, or null when the RESOLVED directory is longer than any that can be
 *  opened. The bound is on resolve's output, never on the spelling: `cd .` repeated stays short. */
function resolveChunk(dir, chunk) {
  try {
    const next = resolve(dir || '/', ...chunk)
    return next.length > MAX_PATH_CHARS ? null : next
  } catch {
    return null
  }
}

/** Resolve `values` one after another from `base`, as git's `-C` chain does, in chunks of at most
 *  about MAX_PATH_CHARS of spelling, so each `resolve` reads a bounded directory plus a bounded
 *  chunk: linear in the input. null when a step's directory grows past the bound. */
function resolveChain(base, values) {
  let dir = base
  let chunk = []
  let size = 0
  for (const value of values) {
    chunk.push(value)
    size += value.length + 1
    if (size < MAX_PATH_CHARS) continue
    dir = resolveChunk(dir, chunk)
    if (dir === null) return null
    chunk = []
    size = 0
  }
  return chunk.length > 0 ? resolveChunk(dir, chunk) : dir
}

// The cwd a chain of `cd`s has reached. Relative `cd`s are collected and resolved a chunk at a
// time (resolving after every `cd` re-reads an ever longer path, and a long `cd a && cd a …` chain
// turns quadratic). A `cd` that cannot be resolved leaves the cwd where it was; so does a chunk
// whose resolved directory would be longer than any that can be opened.
function cwdTrail(cwd) {
  return { base: cwd, pending: [], size: 0 }
}

function flushTrail(trail) {
  if (trail.pending.length > 0) trail.base = resolveChunk(trail.base, trail.pending) ?? trail.base
  trail.pending = []
  trail.size = 0
}

function trailCd(trail, raw) {
  if (typeof raw !== 'string' || raw.length === 0 || UNRESOLVABLE.test(raw)) return
  const expanded = raw.startsWith('~') ? homedir() + raw.slice(1) : raw
  if (expanded.startsWith('/')) {
    const absolute = resolveChunk('/', [expanded])
    if (absolute !== null) Object.assign(trail, cwdTrail(absolute))
    return
  }
  trail.pending.push(expanded)
  trail.size += expanded.length + 1
  if (trail.size >= MAX_PATH_CHARS) flushTrail(trail)
}

function trailDir(trail) {
  flushTrail(trail)
  return trail.base
}

/** `git -C a -C b` acts on `a/b`, as git resolves it: each `-C` is relative to the one before, and
 *  an empty `-C ''` is a no-op. */
function chainedDir(values, cwd) {
  const spelled = values.filter((value) => value.length > 0)
  if (spelled.some((value) => UNRESOLVABLE.test(value))) return null
  const expanded = spelled.map((value) => (value.startsWith('~') ? homedir() + value.slice(1) : value))
  return resolveChain(cwd || '/', expanded)
}

/** The raw target of a `cd <path>` that opens the segment, or null. */
function segmentCd(seg) {
  const cd = seg.match(/^cd\s+("([^"]+)"|'([^']+)'|(\S+))/)
  return cd ? (cd[2] ?? cd[3] ?? cd[4]) : null
}

function resolveTarget(raw, cwd) {
  const expanded = raw.startsWith('~') ? homedir() + raw.slice(1) : raw
  try {
    return resolve(cwd && !expanded.startsWith('/') ? cwd : '/', expanded)
  } catch {
    return null
  }
}

/** Split on shell separators so one dangerous segment is not hidden behind a harmless one. */
function segments(cmd) {
  return cmd.split(/(?:\|\||&&|[;|&\n])/g).map((s) => s.trim()).filter(Boolean)
}

const RANK = { deny: 2, warn: 1 }
function worse(a, b) {
  return (RANK[b?.verdict] ?? 0) > (RANK[a?.verdict] ?? 0) ? b : a
}

/** The worst guarded git invocation in ONE segment, as { verdict, dir }, or null. Every git word
 *  is read once; the scan resumes after an invocation's global options, so the segment is walked
 *  in linear time whatever it repeats. */
function segmentHit(seg, trail) {
  if (!seg.includes('git')) return null
  const list = wordsOf(seg)
  const shape = { hardAt: lastHardAt(seg), pathspec: /\s--\s/.test(seg) }
  let best = null
  let i = 0
  while (i < list.length - 1 && best?.verdict !== 'deny') {
    if (!GIT_WORD.test(list[i].text)) {
      i += 1
      continue
    }
    const inv = gitInvocation(list, i, seg)
    const verdict = subcommandVerdict(list, inv, shape)
    const dir = verdict ? invocationDirs(inv, seg, trailDir(trail)).find(isGuardedDir) : undefined
    if (dir) best = worse(best, { verdict, dir })
    i = Math.max(i + 1, inv.subIndex)
  }
  return best
}

function diagnose() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || null
  const rulesDir = configDir ? resolve(configDir, 'rules') : resolve(homedir(), '.claude', 'rules')
  const mode = resolveMode()
  const active = isGuardedDir(rulesDir)
  writeSync(
    1,
    JSON.stringify(
      {
        configDir: configDir ?? `${homedir()} (via .claude*-named ancestor heuristic, no CLAUDE_CONFIG_DIR set)`,
        rulesDir,
        isGitRepo: existsSync(resolve(rulesDir, '.git')),
        mode,
        active,
        note: active
          ? 'guard is ACTIVE for this environment: matched git commands targeting this directory will be warned or denied per mode'
          : 'guard is INERT for this environment: the resolved rules directory is not a git working tree, so nothing is protected',
      },
      null,
      2,
    ) + '\n',
  )
}

function commandInput(input) {
  const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (!cmd) return null
  const cwd = typeof input.cwd === 'string' ? input.cwd : ''
  return { cmd, cwd }
}

function effectiveVerdict(mode, verdict) {
  return mode === 'warn' && verdict === 'deny' ? 'warn' : verdict
}

// ---- `sh|bash|zsh -c '<script>'`: the script runs in a child shell with its own `cd`s ------------
// The segment pass above splits on separators without reading quotes, so the `cd` inside
// `bash -c 'cd <dir> && git reset --hard'` lands in the shell's segment and the git one keeps the
// outer cwd. This pass reads quotes, finds each shell `-c` script at command position, and walks the
// script as a command of its own, from the cwd in force at that point, to a bounded depth.
const SEPARATOR = /[;&|\n]/
const BLANK = /\s/
const SHELLS = new Set(['sh', 'bash', 'zsh'])
const LAUNCHER_WORD = /^(?:setsid|nohup|env|sudo|time|exec|command|nice|timeout|stdbuf)$|^[A-Za-z_]\w*=|^-|^\d+$/
const SHELL_OPTION_WITH_VALUE = /^[-+][oO]$|^--(?:rcfile|init-file)$/
const MAX_SCRIPT_DEPTH = 3

function appendWord(state, text) {
  state.word = (state.word ?? '') + text
}

function endWord(state) {
  if (state.word !== null) state.commands[state.commands.length - 1].push(state.word)
  state.word = null
}

function doubleQuoteEnd(script, i) {
  let j = i + 1
  while (j < script.length && script[j] !== '"') j += script[j] === '\\' ? 2 : 1
  return Math.min(j, script.length)
}

function quotedSpan(script, i, state) {
  const { piece, next } = quotedPiece(script, i)
  appendWord(state, piece)
  return next
}

/** One step of the quote-aware scan; returns the next index. */
function shellStep(script, i, state) {
  const ch = script[i]
  if (ch === "'" || ch === '"') return quotedSpan(script, i, state)
  if (ch === '$' && script[i + 1] === "'") return i + 1 // ANSI-C quoting: the body is kept raw
  if (ch === '\\') {
    // A backslash-newline is a line continuation; any other escaped character is literal.
    if (script[i + 1] !== '\n') appendWord(state, script[i + 1] ?? '')
    return i + 2
  }
  plainChar(ch, state)
  return i + 1
}

function plainChar(ch, state) {
  const separator = SEPARATOR.test(ch)
  const blank = !separator && BLANK.test(ch)
  if (separator || blank) endWord(state)
  if (separator) state.commands.push([])
  else if (!blank) appendWord(state, ch)
}

/** The simple commands of a script, quote-aware, quotes removed. One linear pass; `$( … )`,
 *  subshells and heredocs are not modelled here (the segment pass still reads their text). */
function shellCommands(script) {
  const state = { commands: [[]], word: null }
  for (let i = 0; i < script.length; ) i = shellStep(script, i, state)
  endWord(state)
  return state.commands.filter((words) => words.length > 0)
}

function isShellWord(word) {
  return SHELLS.has(word.slice(word.lastIndexOf('/') + 1))
}

/** The script of `[launchers] sh|bash|zsh [options] -c <script>`, or null. */
function shellScript(words) {
  const head = words.findIndex(isShellWord)
  if (head === -1 || !words.slice(0, head).every((word) => LAUNCHER_WORD.test(word))) return null
  let runsScript = false
  for (let i = head + 1; i < words.length; i++) {
    const word = words[i]
    if (SHELL_OPTION_WITH_VALUE.test(word)) i++
    else if (/^[-+]/.test(word)) runsScript ||= /^-[A-Za-z]+$/.test(word) && word.includes('c')
    else return runsScript ? word : null
  }
  return null
}

/** The worst finding among the shell `-c` scripts of `cmd`, each walked from the cwd its outer
 *  chain has reached; a `cd` inside a script never moves the outer chain. */
function scriptChange(cmd, cwd, mode, depth) {
  if (depth >= MAX_SCRIPT_DEPTH) return null
  if (!/sh\b/.test(cmd)) return null // no shell word: nothing to walk
  const trail = cwdTrail(cwd)
  let found = null
  for (const words of shellCommands(cmd)) {
    if (words[0] === 'cd' && words.length === 2) {
      trailCd(trail, words[1])
      continue
    }
    const script = shellScript(words)
    if (script === null) continue
    const inner = findLiveChange(script, trailDir(trail), mode, depth + 1)
    if (inner.worst === 'deny') return inner
    found ??= inner.worst ? inner : null
  }
  return found
}

/** The segment pass: every separator-split segment, with the cwd carried across `cd`s. */
function segmentChange(cmd, cwd, mode) {
  let found = { worst: null, hitSeg: '', hitDir: '' }
  // The shell's cwd CARRIES ACROSS segments: `cd <dir> && git switch x` splits into two
  // segments, and the git one alone looks harmless. Tracking the cd is what makes the split
  // safe — without it, `cd <live-dir> && git reset --hard` passed silently.
  const trail = cwdTrail(cwd)
  for (const seg of segments(cmd)) {
    if (/^cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*$/.test(seg)) {
      trailCd(trail, segmentCd(seg))
      continue
    }
    const hit = segmentHit(seg, trail)
    if (!hit) continue
    const worst = effectiveVerdict(mode, hit.verdict)
    if (worst === 'deny') return { worst, hitSeg: seg, hitDir: hit.dir }
    if (!found.worst) found = { worst, hitSeg: seg, hitDir: hit.dir }
  }
  return found
}

/** The segment pass first; a deny inside a shell `-c` script outranks a warn from it. */
function findLiveChange(cmd, cwd, mode, depth = 0) {
  const found = segmentChange(cmd, cwd, mode)
  if (found.worst === 'deny') return found
  const inner = scriptChange(cmd, cwd, mode, depth)
  if (inner?.worst === 'deny' || !found.worst) return inner ?? found
  return found
}

function liveChangeReason(hitDir) {
  return [
    `This targets a LIVE ambient rules directory (${hitDir}) — read by every session on this`,
    `machine at session start AND at every compaction. Switching it changes the standing`,
    `instructions of sessions that are mid-arc, silently, including this one at its next`,
    `compaction.`,
    ``,
    `The correct pattern, and it is NOT matched by this guard:`,
    `    git -C ${hitDir} worktree add <path-outside-the-config-dir> -b <branch>`,
    `then edit inside that worktree and merge back to main when the work is done.`,
    ``,
    `If the git text is DATA (text being written into a file, a commit message, or a`,
    `replacement string), write that file with the Edit or Write tool instead of a shell command.`,
    `This guard only reads Bash commands, so that route is never refused.`,
    ``,
    `⚠ This guard only sees GIT commands. A direct Edit/Write/rm inside the live rules dir is`,
    `  invisible to it — that half is not mechanised. Run this hook with --diagnose to check`,
    `  whether it is active for your environment.`,
  ].join('\n')
}

function denyLiveChange(input, hitSeg, hitDir, why) {
  recordGuardEvent({
    guard: 'wt-live-config-tree-guard-hook.mjs',
    decision: 'blocked',
    session: input.session_id,
    agent: input.agent_id,
    class: 'live-config-tree',
    reason: hitSeg,
    cwd: hitDir,
  })
  writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `LIVE CONFIG TREE — refused: ${hitSeg}\n\n${why}`,
      },
    }),
  )
}

function warnLiveChange(input, hitSeg, hitDir, why) {
  recordGuardEvent({
    guard: 'wt-live-config-tree-guard-hook.mjs',
    decision: 'warned',
    session: input.session_id,
    agent: input.agent_id,
    class: 'live-config-tree',
    reason: hitSeg,
    cwd: hitDir,
  })
  emitGuardNotice({
    payload: input,
    stdoutJson: {
      systemMessage: `⚠ LIVE CONFIG TREE — this changes the running rules for every session:\n    ${hitSeg}\n\n${why}`,
    },
  })
}

function main() {
  if (process.argv.includes('--diagnose')) return diagnose()
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return
  const command = commandInput(input)
  if (!command) return
  const { cmd, cwd } = command
  const mode = resolveMode()
  if (mode === 'off') return
  const { worst, hitSeg, hitDir } = findLiveChange(cmd, cwd, mode)
  if (!worst) return
  const why = liveChangeReason(hitDir)
  if (worst === 'deny') {
    denyLiveChange(input, hitSeg, hitDir, why)
    return
  }
  warnLiveChange(input, hitSeg, hitDir, why)
}

try {
  main()
} catch {
  /* a hook that throws is a hook that gets disabled */
}
process.exit(0)

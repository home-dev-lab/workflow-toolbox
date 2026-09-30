// rm-critical-path-core.mjs — predicts which `rm`/`rmdir` invocations Claude Code's built-in
// critical-path removal check will stop for a permission prompt, and builds the rewrite that
// avoids it.
//
// WHY A PREDICTION. Claude Code never lets an allow rule or a PreToolUse hook "allow" approve an
// `rm`/`rmdir` whose target it classifies as a critical path, and it ASKS in bypassPermissions
// mode too (permission-modes.md, "Critical paths"). A background agent that meets that prompt
// waits on a console nobody may be watching. A PreToolUse refusal returns at once and tells the
// agent what to write instead, so the only way to spare the prompt is to recognise the shape
// before the harness does.
//
// Shapes recognised, each from the documented rule or the harness's own refusal wording:
//   glob-under-variable   a glob, a trailing slash, a second `/` or a `$` directly after a
//                         variable: `$D/*`, `"$D"/`, `$D/$x`. Empty D makes it a removal from
//                         `/`. The escape is the `${D:?}` form, which the check does not treat
//                         as possibly empty.
//   variable-root-child   `$D/usr` (a known top-level name) where D is not assigned here and not set in the
//                         inherited environment: empty D removes `/name`, a top-level directory.
//   substitution-target   a recursive `rm` whose target is only command substitutions (`$(cat f)`, `"$(…)"/`).
//   positional-glob       a glob or further segment under a positional parameter (`$1/*`).
//   derived-directory     the target is a variable this command set from the working directory
//                         (`$PWD`, `$(pwd)`, `$(git rev-parse …)`, `$(dirname $x)`, `$(cd … )`)
//                         or from `$X/name` or `$X/$Y` with a possibly empty prefix. A `${D:?}` guard does not help
//                         because D is not empty: only a literal path avoids the prompt.
//   literal-critical-path `/`, a top-level directory, the home directory, the working directory
//                         or one of its parents, written literally.
//
// What it cannot see, so its silence is never read as coverage: a variable assigned in an
// EARLIER Bash call (it treats it as unset unless the inherited environment has it — which is
// what the harness does too); a target built by `eval`, a function body, or a script file; any
// rule the harness adds after the version this was written against. The PermissionRequest half
// of the hook covers what this prediction misses.

const NAME = '[A-Za-z_][A-Za-z0-9_]*'
// A variable reference as the first thing in a word: `$D`, `${D}`, `${D-}`, `${D:-}`, `${D:-""}`,
// `${D:-$E}` — every form that can still expand to empty. `${D:?}` is deliberately absent.
const EMPTYABLE_REF = String.raw`\$(?:\{(${NAME})(?::?-(?:["']{2}|"?\$\{?${NAME}\}?"?)?)?\}|(${NAME}))`
const GLOB_UNDER_VAR = new RegExp(String.raw`^["']*${EMPTYABLE_REF}["']*\\?\/(?:[*?[{]|\$|\/|["']|$)`)
const GLOB_UNDER_POSITIONAL = /^["']*\$(?:\{([0-9]+|[@*!])(?::?-(?:["']{2}|"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?)?)?\}|([0-9@*!]))["']*\\?\/(?:[*?[{]|\$|\/|["']|$)/
const FUNCTION_DEFINITION = /(?:^|[;&|(\n])[ \t]*(?:function[ \t]+[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\))/
const NONEMPTY_POSITIONALS = /(?:^|[;&|(\n])[ \t]*set[ \t]+--[ \t]+(?!["']{2}(?:[\s;&|]|$)|["']?\$)[^\s;&|]/
// The top-level directory names the harness knows (it only reads `$D/name` as a critical path for these).
const TOP_LEVEL_NAMES = 'bin|boot|dev|etc|home|lib|lib32|lib64|libx32|media|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var|snap|nix|lost\\+found|private|cores|Applications|Library|System|Users|Volumes|Windows|ProgramData|cygdrive'
const ROOT_CHILD = new RegExp(String.raw`^["']*\$(?:\{(${NAME})\}|(${NAME}))["']*\/+(${TOP_LEVEL_NAMES})(?:\/+\*+)*\/*["']*$`, 'i')
// Retain the existing PWD/HOME whole-variable critical-path check.
const WHOLE_VAR = new RegExp(String.raw`^["']*\$(?:\{(${NAME})(?::?[?-][^}]*)?\}|(${NAME}))["']*[/*.]*$`)
const NON_LITERAL = /[$`*?[{~]/
const NORMALLY_SET =new Set(['HOME', 'PWD', 'OLDPWD', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'USERPROFILE'])
const PREFIX_WORDS = new Set([
  'sudo', 'doas', 'exec', 'command', 'env', 'nice', 'nohup', 'time', 'timeout', 'stdbuf', 'setsid',
  'ionice', 'xargs', 'busybox', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(',
])
const SHELL_RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const DECLARE_WORDS = new Set(['export', 'local', 'declare', 'typeset', 'readonly'])

/** Blank the bodies of heredocs, so prose written into a file or a commit message is not read as
 * a command. The delimiter line itself is kept. */
export function blankHeredocBodies(text) {
  return heredocSource(text).text
}

function heredocSource(text) {
  const lines = String(text ?? '').split('\n')
  const pending = []
  const nested = []
  let offset = 0
  const out = lines.map((line) => {
    const start = offset
    offset += line.length + 1
    if (pending.length) {
      const first = pending[0]
      const probe = first.tabs ? line.replace(/^\t+/, '') : line
      if (probe === first.delim) { pending.shift(); return ' '.repeat(line.length) }
      if (!first.quoted) {
        for (const sub of parseStatements(line).nested) nested.push({ ...sub, start: start + sub.start, reparsed: true })
      }
      return ' '.repeat(line.length)
    }
    let quote = null
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i]
      if (c === '\\') { i += 1; continue }
      if (quote) {
        if (c === quote) quote = null
        continue
      }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break
      if (c === '"' || c === "'") {
        quote = c
        continue
      }
      if (c !== '<' || line[i + 1] !== '<' || line[i + 2] === '<') continue
      let j = i + 2
      const tabs = line[j] === '-'
      if (tabs) j += 1
      while (line[j] === ' ' || line[j] === '\t') j += 1
      const match = /^(?:\\.|[^\s;|&<>])+/u.exec(line.slice(j))
      if (!match) continue
      const raw = match[0]
      pending.push({ delim: shellUnquote(raw), tabs, quoted: /["'\\]/.test(raw) })
      // The cursor intentionally skips the delimiter word after consuming it.
      // eslint-disable-next-line sonarjs/updated-loop-counter
      i = j + raw.length - 1
    }
    return line
  })
  return { text: out.join('\n'), nested }
}

/** Splits a command into statements and words, quote-aware. Command substitutions, backtick spans
 * and `bash -c` scripts are returned separately as nested scripts to scan in their own right. */
export function parseStatements(text) {
  const src = String(text ?? '')
  const statements = []
  const nested = []
  let words = []
  let word = ''
  let inWord = false
  let quote = null
  let start = 0
  let positions = []
  let statementStart = 0
  const endWord = () => {
    if (inWord) { words.push(word); positions.push({ start, end: current }) }
    word = ''
    inWord = false
  }
  const endStatement = (sep) => {
    endWord()
    if (words.length > 0) statements.push({ words, positions, sep, start: statementStart, end: current })
    words = []
    positions = []
    statementStart = current + 1
  }
  let current = 0
  for (let i = 0; i < src.length; i += 1) {
    current = i
    const c = src[i]
    if (quote === "'") {
      word += c
      if (c === "'") quote = null
      continue
    }
    if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] === '\n') { i += 1; continue }
      if (!inWord) start = i
      word += c + src[i + 1]
      inWord = true
      i += 1
      continue
    }
    if (quote === '"') {
      word += c
      if (c === '"') quote = null
      else if (c === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
        // eslint-disable-next-line sonarjs/updated-loop-counter
        i = captureParen(src, i + 1, nested, (s) => { word += s })
      } else if (c === '`') {
        // eslint-disable-next-line sonarjs/updated-loop-counter
        i = captureBacktick(src, i, nested, (s) => { word += s })
      }
      continue
    }
    if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i += 1
      endStatement('\n')
      continue
    }
    if (c === "'" || c === '"') {
      if (!inWord) start = i
      quote = c
      word += c
      inWord = true
      continue
    }
    if (c === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
      if (!inWord) start = i
      word += '$'
      inWord = true
      // eslint-disable-next-line sonarjs/updated-loop-counter
      i = captureParen(src, i + 1, nested, (s) => { word += s })
      continue
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      endWord()
      // eslint-disable-next-line sonarjs/updated-loop-counter
      i = captureParen(src, i + 1, nested, () => {})
      continue
    }
    if (c === '`') {
      if (!inWord) start = i
      inWord = true
      // eslint-disable-next-line sonarjs/updated-loop-counter
      i = captureBacktick(src, i, nested, (s) => { word += s })
      continue
    }
    if (c === '<' || c === '>') {
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false }
      else endWord()
      start = i
      let op = c
      if (src[i + 1] === c || src[i + 1] === '&') op += src[++i]
      words.push(op)
      positions.push({ start, end: i + 1 })
      continue
    }
    if (c === '&' && src[i + 1] === '>') {
      endWord()
      words.push('&>')
      positions.push({ start: i, end: i + 2 })
      i += 1
      continue
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')') {
      let sep = c
      if ((c === '|' || c === '&') && src[i + 1] === c) {
        sep = c + c
        i += 1
      }
      if (c === '(' || c === ')') {
        endStatement(c)
        statements.push({ words: [], positions: [], sep: c, start: i, end: i + 1 })
        continue
      }
      endStatement(sep)
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      continue
    }
    word += c
    if (!inWord) start = i
    inWord = true
  }
  current = src.length
  endStatement('')
  return { statements, nested }
}

function captureParen(src, open, nested, emit) {
  let depth = 0
  let quote = null
  for (let j = open; j < src.length; j += 1) {
    const c = src[j]
    if (quote) {
      if (c === '\\' && quote === '"') { j += 1; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '\\') { j += 1; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) {
        const body = src.slice(open + 1, j)
        nested.push({ body, start: open - 1 })
        emit(`(${body})`)
        return j
      }
    }
  }
  const body = src.slice(open + 1)
  nested.push({ body, start: open - 1 })
  emit(`(${body}`)
  return src.length
}

function captureBacktick(src, start, nested, emit) {
  let end = start + 1
  for (; end < src.length; end += 1) {
    if (src[end] === '\\') { end += 1; continue }
    if (src[end] === '`') break
  }
  if (end === src.length) end = -1
  const body = end === -1 ? src.slice(start + 1) : src.slice(start + 1, end)
  nested.push({ body, start })
  emit(`\`${body}\``)
  return end === -1 ? src.length : end
}

function shellUnquote(word) {
  let quote = null
  let result = ''
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i]
    if (c === quote) { quote = null; continue }
    if (!quote && (c === "'" || c === '"')) { quote = c; continue }
    if (c === '\\' && quote !== "'" && i + 1 < word.length) { result += word[++i]; continue }
    result += c
  }
  return result
}

const unquoteWhole = shellUnquote

/** Classify an assignment's value the way the harness does: does the variable end up possibly
 * empty, set, or derived from the working directory? */
function classifyValue(rawValue, vars, mayBeUnset) {
  if (rawValue === "''") return { kind: 'empty' }
  if (/^'[^']*'$/.test(rawValue)) return { kind: 'literal', value: shellUnquote(rawValue) }
  const v = unquoteWhole(rawValue)
  if (v === '' || /^(?:""|''|\(\s*\))$/.test(v)) return { kind: 'empty' }
  if (!/[$`]/.test(v)) return { kind: 'literal', value: v }
  const sub = /^\$\((.*)\)$/s.exec(v)?.[1] ?? /^`(.*)`$/s.exec(v)?.[1]
  if (sub !== undefined) {
    const s = sub.trim()
    if (/^pwd(?:\s|$)/.test(s)) return { kind: 'derived', becomes: 'prints the current directory', value: rawValue }
    if (/^git\s+rev-parse\b/.test(s)) return { kind: 'derived', becomes: 'prints a git value such as the repository root', value: rawValue }
    if (/^cd\b/.test(s)) return { kind: 'derived', becomes: 'prints the current directory when its input is empty', value: rawValue }
    if (/^dirname\b/.test(s)) {
      const arg = /^dirname\s+(?:-\S+\s+)*(\S+)/.exec(s)?.[1]
      if (arg === undefined || /[$`]/.test(arg) || /^(?:""|'')$/.test(arg)) {
        return { kind: 'derived', becomes: 'prints the current directory when its input is empty', value: rawValue }
      }
    }
    return { kind: 'set' }
  }
  // The harness checks `$X/<top-level-name>` and `$VAR/` followed by `$`, a glob, `/`, a quote or the end
  // BEFORE its whole-variable-copy rule, so a trailing-slash value (`A=$W/`) is judged here first.
  const child = ROOT_CHILD.exec(v)
  if (child) {
    const name = child[1] ?? child[2]
    if (mayBeUnset(name) && child[3] !== '.' && child[3] !== '..') {
      return { kind: 'derived', becomes: `is /${child[3]} when the variable in it is empty`, value: rawValue }
    }
  }
  if ((!/[$`]/.test(rawValue) || /^"?\$\{?[A-Za-z_]/.test(rawValue)) && GLOB_UNDER_VAR.test(rawValue)) {
    return { kind: 'derived', becomes: 'is the filesystem root when the variable in it is empty', value: rawValue }
  }
  const whole = /^\$\{?([A-Za-z_]\w*)\}?\/*$/.exec(v)?.[1]
  if (whole === 'PWD') return { kind: 'derived', becomes: 'is the current directory', value: rawValue }
  if (whole !== undefined) {
    const prev = vars.get(whole)
    if (prev?.kind === 'derived') return { ...prev, value: rawValue }
    if (mayBeUnset(whole)) return { kind: 'empty' }
    return { kind: 'set' }
  }
  const last = /\/([^\s/$`"')}]+)"?$/.exec(v)?.[1]
  if (last !== undefined && !/^[.?*[\]{}]+$/.test(last)) return { kind: 'set' }
  return { kind: 'empty' }
}

function findCommandWord(words) {
  let i = 0
  while (i < words.length) {
    const w = unquoteWhole(words[i])
    if (/^[A-Za-z_]\w*\+?=/.test(words[i])) { i += 1; continue }
    if (PREFIX_WORDS.has(w)) {
      i += 1
      while (i < words.length && (unquoteWhole(words[i]).startsWith('-') || /^\d+[smhd]?$/.test(words[i]))) {
        const option = unquoteWhole(words[i++])
        if (option.startsWith('-') && i < words.length && !words[i].startsWith('-') &&
          !/^[A-Za-z_]\w*=/.test(words[i]) &&
          !['rm', 'rmdir'].includes(commandName(words[i])) && !PREFIX_WORDS.has(unquoteWhole(words[i]))) i += 1
      }
      continue
    }
    if (/^(?:[<>]|&>)/.test(w)) { i += 2; continue }
    return i
  }
  return -1
}

function commandName(word) {
  return unquoteWhole(word).replace(/^\\/, '').replace(/^.*\//, '')
}

function targetsOf(words, start) {
  const targets = []
  let endOfOptions = false
  for (let i = start; i < words.length; i += 1) {
    const w = words[i]
    if (!endOfOptions && w === '--') { endOfOptions = true; continue }
    if (!endOfOptions && w.startsWith('-') && w.length > 1) continue
    if (/^(?:[<>]|&>)/.test(w)) {
      i += 1
      continue
    }
    targets.push(i)
  }
  return targets
}

/** Does `rm` carry a recursive flag before `--` (`-r`, `-rf`, `-fR`, `--recursive`)? */
function isRecursiveRm(words, start) {
  for (let i = start; i < words.length; i += 1) {
    if (words[i] === '--') return false
    const w = shellUnquote(words[i])
    if (/^--r/.test(w) || /^-[a-zA-Z]*[rR]/.test(w)) return true
  }
  return false
}

/** Replace actual command substitutions, recording whether any were present. Quotes and escapes are
 * removed too, unless `keepQuoting` is set: then only the substitutions change and every other
 * character (quotes, backslashes) stays as written. */
function stripSubstitutions(word, replacement = '\0', keepQuoting = false) {
  let out = ''
  let quote = null
  let found = false
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i]
    if (quote === "'") { if (c === "'") quote = null; if (c !== "'" || keepQuoting) out += c; continue }
    if (c === '\\' && i + 1 < word.length) { out += keepQuoting ? c + word[i + 1] : word[i + 1]; i += 1; continue }
    if (c === '"') { quote = quote === '"' ? null : '"'; if (keepQuoting) out += c; continue }
    if (c === "'" && quote === null) { quote = "'"; if (keepQuoting) out += c; continue }
    if (c === '$' && word[i + 1] === '(' && word[i + 2] !== '(') {
      const nested = []
      const end = captureParen(word, i + 1, nested, () => {})
      out += replacement
      found = true
      i = end
      continue
    }
    if (c === '`') {
      const end = captureBacktick(word, i, [], () => {})
      out += replacement
      found = true
      i = end
      continue
    }
    out += c
  }
  return { text: out, found }
}

/** Is the word, once quotes are removed, only command substitutions optionally followed by `/`, `*` or `.`?
 * The harness cannot resolve such a target before it runs, so it asks — but only when no other `$`
 * expansion is left anywhere in the rm statement (measured: `rm -rf $(cat $T/f) $T/dn` runs unasked). */
function isSubstitutionTarget(word, statementWords) {
  const stripped = stripSubstitutions(word)
  if (!stripped.found || !/^(?:\0[/*.]*)+$/.test(stripped.text)) return false
  return !statementWords.some((w) => stripSubstitutions(w).text.includes('$'))
}

function isAncestorOrSelf(dir, cwd) {
  if (!cwd || !dir.startsWith('/')) return false
  const d = trimSlashes(dir)
  const c = trimSlashes(cwd)
  return d === '/' || c === d || c.startsWith(`${d}/`)
}

function trimSlashes(path) {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') end -= 1
  return path.slice(0, end) || '/'
}

function resolveLiteral(target, cwd, home, tilde = true) {
  let t = target
  if (tilde && (t === '~' || t.startsWith('~/'))) t = `${home ?? '~'}${t.slice(1)}`
  if (!t.startsWith('/')) {
    if (!cwd) return null
    t = `${trimSlashes(cwd)}/${t}`
  }
  const parts = []
  for (const p of t.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return `/${parts.join('/')}`
}

function literalVerdict(rawTarget, ctx) {
  const t = unquoteWhole(rawTarget)
  if (!t) return null
  if (/[$`]/.test(t) && !/^'/.test(rawTarget)) return null
  const tilde = rawTarget[0] === '~'
  if (/[*?[]/.test(t)) {
    // a glob directly under the root or a top-level directory
    const slash = t.lastIndexOf('/')
    const dir = slash < 0 ? '.' : t.slice(0, slash) || '/'
    const resolved = resolveLiteral(dir, ctx.cwd, ctx.home, tilde)
    if (resolved === '/' || (resolved && ctx.home && resolved === trimSlashes(ctx.home))) return resolved
    return null
  }
  // A bare `~` is the home directory whatever its spelled form, known or not.
  if (tilde && (t === '~' || t === '~/')) return ctx.home ? trimSlashes(ctx.home) : '~'
  const resolved = resolveLiteral(t, ctx.cwd, ctx.home, tilde)
  if (resolved === null) return null
  if (resolved === '/') return resolved
  if (/^\/[^/]+$/.test(resolved)) return resolved
  if (ctx.home && resolved === trimSlashes(ctx.home)) return resolved
  if (isAncestorOrSelf(resolved, ctx.cwd)) return resolved
  return null
}

function guardedRewrite(target, name) {
  const ref = String.raw`\$(?:\{${name}\}|${name}(?![A-Za-z0-9_]))`
  for (const [pattern, output] of [
    [new RegExp(`^${ref}(/[^"'\\\\$]*)$`), (m) => `"\${${name}:?}"${m[1]}`],
    [new RegExp(`^"${ref}"(/[^"'\\\\$]*)$`), (m) => `"\${${name}:?}"${m[1]}`],
    [new RegExp(`^"${ref}(/[^"'\\\\$]*)"$`), (m) => `"\${${name}:?}${m[1]}"`],
  ]) {
    const match = pattern.exec(target)
    if (match) return output(match)
  }
  return null
}

function firstDollarIsQuoted(word) {
  let quote = null
  for (let i = 0; i < word.length; i += 1) {
    if (word[i] === '$') return quote === "'"
    if (word[i] === '\\') { i += 1; continue }
    if (word[i] === quote) quote = null
    else if (!quote && (word[i] === '"' || word[i] === "'")) quote = word[i]
  }
  return false
}

// Claude Code 2.1.285's Ajt: discard trailing quotes and a terminal slash/dot/star suffix.
function trimDerivedSuffix(target) {
  let n = target.length
  while (n > 0 && /["']/.test(target[n - 1])) n -= 1
  let r = n
  while (r > 0 && /[/*.]/.test(target[r - 1])) r -= 1
  return r < n && target[r] === '/' ? target.slice(0, r) : target
}

// Claude Code 2.1.285's Njt: accept only a whole variable after Ajt.
function derivedTargetName(target) {
  const match = /^["']*\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?[?-][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))["']*$/.exec(target)
  return match === null ? undefined : match[1] ?? match[2]
}

function judgeTarget(target, ctx, vars, mayBeUnset, positionals) {
  if (firstDollarIsQuoted(target)) {
    const resolved = literalVerdict(target, ctx)
    return resolved === null ? null : { rule: 'literal-critical-path', target, rewrite: null, resolved }
  }
  const positional = positionals && GLOB_UNDER_POSITIONAL.exec(stripSubstitutions(target, '', true).text)
  if (positional) return { rule: 'positional-glob', target, variable: positional[1] ?? positional[2], rewrite: null }
  const glob = GLOB_UNDER_VAR.exec(target)
  if (glob) {
    const name = glob[1] ?? glob[2]
    const derived = vars.get(name)?.kind === 'derived' ? vars.get(name) : null
    const rewritten = guardedRewrite(target, name)
    const literalOnly = NORMALLY_SET.has(name) || derived !== null
    return { rule: 'glob-under-variable', target, variable: name, rewrite: literalOnly ? null : rewritten, derived }
  }
  const child = ROOT_CHILD.exec(target)
  if (child && child[3] !== '.' && child[3] !== '..') {
    const name = child[1] ?? child[2]
    if (mayBeUnset(name)) {
      return { rule: 'variable-root-child', target, variable: name, rewrite: guardedRewrite(target, name), rootChild: child[3] }
    }
  }
  const whole = WHOLE_VAR.exec(target)
  if (whole && (whole[1] ?? whole[2]) === 'PWD' && ctx.cwd) {
    return { rule: 'literal-critical-path', target, rewrite: null, resolved: ctx.cwd }
  }
  if (whole && (whole[1] ?? whole[2]) === 'HOME' && ctx.home) {
    return { rule: 'literal-critical-path', target, rewrite: null, resolved: ctx.home }
  }
  const name = derivedTargetName(trimDerivedSuffix(target))
  const info = vars.get(name)
  if (info?.kind === 'derived') {
    return { rule: 'derived-directory', target, variable: name, rewrite: null, derived: info }
  }
  const critical = literalVerdict(target, ctx)
  if (critical !== null) return { rule: 'literal-critical-path', target, rewrite: null, resolved: critical }
  return null
}

function scanScript(text, ctx, depth, hits, reparsed = false, inherited = new Map(), invocations = null) {
  if (depth > 8) return
  const source = heredocSource(text)
  const { statements, nested } = parseStatements(source.text)
  nested.push(...source.nested)
  const vars = new Map(inherited)
  const scopes = []
  let cwd = ctx.cwd
  const positionals = !reparsed && depth === 0 &&
    !FUNCTION_DEFINITION.test(source.text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')) &&
    !NONEMPTY_POSITIONALS.test(source.text)
  let previousSep = ''
  let nestedIndex = 0
  nested.sort((a, b) => a.start - b.start)
  const mayBeUnset = (name) => {
    const info = vars.get(name)
    if (info) return info.kind === 'empty'
    if (name === 'HOME' || name === 'PWD') return false
    return !Object.prototype.hasOwnProperty.call(ctx.env, name) || ctx.env[name] === ''
  }
  const scanNested = (until) => {
    while (nestedIndex < nested.length && nested[nestedIndex].start < until) {
      const sub = nested[nestedIndex++]
      scanScript(sub.body, { ...ctx, cwd }, depth + 1, hits, true, new Map(vars), invocations)
    }
  }
  for (const { words, positions, sep, end } of statements) {
    if (words.length === 0) {
      if (sep === '(') scopes.push({ vars: new Map(vars), cwd })
      if (sep === ')' && scopes.length) {
        const previous = scopes.pop()
        vars.clear()
        for (const [key, value] of previous.vars) vars.set(key, value)
        cwd = previous.cwd
      }
      previousSep = sep
      continue
    }
    let i = 0
    while (i < words.length && DECLARE_WORDS.has(words[i])) i += 1
    const declaration = i > 0
    let onlyAssignments = true
    const pending = []
    for (let j = i; j < words.length; j += 1) {
      const m = /^([A-Za-z_]\w*)\+?=(.*)$/s.exec(words[j])
      if (m) pending.push([m[1], m[2]])
      else if (!(declaration && (words[j].startsWith('-') || /^[A-Za-z_]\w*$/.test(words[j])))) { onlyAssignments = false; break }
    }
    if (onlyAssignments && pending.length > 0) {
      if (previousSep !== '||') for (const [name, value] of pending) vars.set(name, classifyValue(value, vars, mayBeUnset))
      scanNested(end)
      previousSep = sep
      continue
    }
    const unset = words[0] === 'unset' ? words.slice(1).filter((w) => !w.startsWith('-')) : []
    for (const name of unset) vars.set(name, { kind: 'empty' })
    if (words[0] === 'for' && words[2] === 'in' && words.length > 3) vars.set(words[1], { kind: 'set' })

    const c = findCommandWord(words)
    if (c < 0) { scanNested(end); previousSep = sep; continue }
    const name = commandName(words[c])
    if (name === 'rm' || name === 'rmdir') {
      if (invocations) invocations.found = true
      const isRecursive = name === 'rm' && isRecursiveRm(words, c + 1)
      for (const j of targetsOf(words, c + 1)) {
        const target = words[j]
        if (invocations && (reparsed || NON_LITERAL.test(target))) invocations.nonLiteral = true
        const hit = name === 'rm' && isRecursive && isSubstitutionTarget(target, words.slice(c))
          ? { rule: 'substitution-target', target, rewrite: null }
          : judgeTarget(target, { ...ctx, cwd }, vars, mayBeUnset, positionals)
        if (hit) hits.push({ ...hit, rewrite: reparsed ? null : hit.rewrite, reparsed, command: name, statement: words.join(' '), ...(reparsed ? {} : { start: positions[j].start, end: positions[j].end }) })
      }
    }
    // A `cd` inside the command does not move the directory the check compares literal targets
    // with: it reads the directory the Bash call starts in (six real `cd X … rm -rf X` commands
    // raised no prompt). So `cwd` is not updated here.
    if (SHELL_RUNNERS.has(name)) {
      for (let j = c + 1; j < words.length - 1; j += 1) {
        if (words[j].startsWith('-') && words[j].slice(1).includes('c') && /^-[A-Za-z]+$/.test(words[j])) {
          scanScript(unquoteWhole(words[j + 1]), { ...ctx, cwd }, depth + 1, hits, true, new Map(vars), invocations)
          break
        }
      }
    }
    if (name === 'eval' || name === 'trap') {
      const body = words[c + 1]
      if (body) scanScript(unquoteWhole(body), { ...ctx, cwd }, depth + 1, hits, true, new Map(vars), invocations)
    }
    scanNested(end)
    previousSep = sep
  }
  scanNested(Infinity)
}

/** Every rm/rmdir target in `command` that the critical-path check would stop on. */
export function scanRmCriticalPath(command, { cwd = null, home = null, env = {} } = {}) {
  const text = String(command ?? '')
  if (!/\brm(?:dir)?\b/.test(text)) return []
  const hits = []
  scanScript(text, { cwd: gitBashPath(cwd), home: gitBashPath(home), env: env ?? {} }, 0, hits)
  return hits
}

/**
 * The hook's cwd and home come from the host: on win32 they read `C:\Users\x`. The Bash commands
 * it judges run in Git Bash, which spells the same directory `/c/Users/x`. Comparing the two
 * forms would miss every home or working-directory target, so a drive-letter path is rewritten
 * to the Git Bash form. A POSIX path is returned unchanged.
 */
function gitBashPath(path) {
  if (typeof path !== 'string') return path
  const drive = /^([A-Za-z]):(?:[\\/]|$)/.exec(path)
  if (!drive) return path
  return `/${drive[1].toLowerCase()}/${path.slice(2).replace(/\\/g, '/').replace(/^\/+/, '')}`
}

/** Does `command` invoke rm/rmdir with a target the critical-path check could stop on? A target
 * written as a plain literal path cannot be what an unpredicted prompt was about (a literal
 * critical path is predicted); a variable, a glob, a substitution or a target inside a script the
 * shell reads a second time can be. */
export function hasNonLiteralRmInvocation(command) {
  const seen = { found: false, nonLiteral: false }
  scanScript(command, { cwd: null, home: null, env: {} }, 0, [], false, new Map(), seen)
  return seen.found && seen.nonLiteral
}

function rewriteFailureReason(hit) {
  if (hit.derived) return `$${hit.variable} is set in this command from a value that ${hit.derived.becomes}, so a \`\${${hit.variable}:?}\` guard would not stop it`
  if (hit.reparsed) return 'this target sits in a script the shell parses a second time (`bash -c "…"` or a nested substitution), so a pasted guard may not protect it'
  if (NORMALLY_SET.has(hit.variable)) return `$${hit.variable} is normally set, so a \`\${${hit.variable}:?}\` guard would not stop it`
  return 'part of this target cannot be guarded'
}

/** One line of advice per hit, plus a rewritten command when every hit has a mechanical rewrite. */
export function describeRemedy(command, hits) {
  const lines = []
  let rewritten = String(command)
  let complete = true
  const changes = []
  for (const h of hits) {
    if (h.rule === 'glob-under-variable' || h.rule === 'variable-root-child') {
      if (h.rewrite) {
        lines.push(`\`${h.target}\` → \`${h.rewrite}\` (the shell stops with an error when $${h.variable} is empty instead of removing from /)`)
        if (h.start !== undefined && h.end !== undefined) changes.push(h)
        else complete = false
      } else {
        complete = false
        lines.push(`\`${h.target}\`: use a literal absolute path — ${rewriteFailureReason(h)}`)
      }
    } else if (h.rule === 'substitution-target') {
      complete = false
      lines.push(`\`${h.target}\`: the target is the output of a command substitution and cannot be checked before it runs — run the substitution on its own first, then remove the literal paths it prints (or use the literal path)`)
    } else if (h.rule === 'positional-glob') {
      complete = false
      lines.push(`\`${h.target}\`: use a literal absolute path, or bind $${h.variable} and write \`\${${h.variable}:?}\``)
    } else if (h.rule === 'derived-directory') {
      complete = false
      lines.push(`\`${h.target}\`: use a literal absolute path you type yourself — $${h.variable} is set in this command from a value that ${h.derived.becomes}, and a \`\${${h.variable}:?}\` guard does not help because it is not empty; if that path is the working directory or one of its parents it stays critical in any spelling — change to its parent directory first and remove it by its literal path`)
    } else {
      complete = false
      lines.push(`\`${h.target}\` resolves to ${h.resolved}, a critical path (the filesystem root, a top-level directory, the home directory, or the working directory or one of its parents): remove only the specific children you mean, by literal path`)
    }
  }
  changes.sort((a, b) => b.start - a.start)
  if (complete && !safeToSplice(String(command), changes)) complete = false
  for (const h of changes) rewritten = rewritten.slice(0, h.start) + h.rewrite + rewritten.slice(h.end)
  return { lines, rewritten: complete && hits.length > 0 ? rewritten : null }
}

// A full rewrite is offered only where the parser's reading of the command is not in doubt: no
// heredoc or here-string, and no parameter expansion outside the targets being replaced. In those
// constructs a misread boundary would put the edit inside written data or default-value text; the
// per-target advice lines still say what to change.
function safeToSplice(command, changes) {
  let rest = command
  for (const h of changes) rest = rest.slice(0, h.start) + rest.slice(h.end)
  return !rest.includes('<<') && !rest.includes('${')
}

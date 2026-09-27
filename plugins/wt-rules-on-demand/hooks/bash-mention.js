// A `bash` trigger fires on what a command RUNS, never on text it only reads or prints.
// `grep "opencode run" notes.md`, `cat brief.md`, `echo "pnpm test"` and a heredoc body handed to a non-interpreter
// (`git commit -F - <<EOF`, `cat > brief.md <<EOF`) mention a governed command without running it; each was refused
// A read-only mention should not cost a model round trip.
//
// maskReadOnlyMentions(command) returns the command with those spans blanked (same length, newlines kept), so a
// trigger regex tested on the result keeps its anchors and separators. It fails TOWARD firing: whatever it cannot
// prove read-only stays visible — a segment carrying a command substitution, a write redirection, `sed -i`, a
// pipeline that feeds an interpreter, a heredoc read by an interpreter.
const READ_ONLY = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'cat', 'echo', 'printf', 'head', 'tail',
  'less', 'more', 'bat', 'wc', 'nl', 'sort', 'uniq', 'cut', 'tr', 'column', 'jq', 'diff', 'ls', 'file', 'stat', 'strings',
  'pgrep', 'ps']);
// `git <sub>` that only reads: `git -C $W diff vitest.config.ts` names a governed tool in a path, it runs nothing.
const READ_ONLY_GIT = new Set(['diff', 'log', 'show', 'status', 'grep', 'blame', 'ls-files', 'rev-parse', 'cat-file', 'shortlog', 'describe']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'bun', 'deno',
  'perl', 'ruby', 'ssh', 'eval', 'source', '.', 'xargs', 'sudo', 'su', 'parallel', 'watch', 'tmux', 'screen']);
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', '(', 'time']);
const WRAPPERS = new Set(['env', 'timeout', 'nohup', 'setsid', 'exec', 'command', 'builtin', 'nice', 'stdbuf']);

// One pass over the text: segments split on unquoted ; & | newline ( ), each with its words, whether it holds a
// command substitution, its heredoc bodies, and the separator that ends it.
function scan(command) {
  const segments = [];
  let seg = null;
  let word = null;
  const pendingHeredocs = [];
  const open = (at) => { seg = { start: at, end: at, words: [], subst: false, heredocs: [], sep: '' }; };
  const flushWord = () => { if (word !== null) { seg.words.push(word); word = null; } };
  const close = (at, sep) => { flushWord(); seg.end = at; seg.sep = sep; segments.push(seg); open(at + sep.length); };
  open(0);
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === '\\' && i + 1 < n) { word = (word ?? '') + command[i + 1]; i += 2; continue; }
    if (c === "'") {
      const endQuote = command.indexOf("'", i + 1);
      const stop = endQuote === -1 ? n : endQuote;
      word = (word ?? '') + command.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < n && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < n) { text += command[j + 1]; j += 2; continue; }
        if (command[j] === '`' || (command[j] === '$' && command[j + 1] === '(')) seg.subst = true;
        text += command[j];
        j += 1;
      }
      word = (word ?? '') + text;
      i = j + 1;
      continue;
    }
    if (c === '`') { seg.subst = true; word = (word ?? '') + c; i += 1; continue; }
    if (c === '$' && command[i + 1] === '(') {
      // Keep the whole substitution inside the current segment; it runs, so the segment can never be masked.
      seg.subst = true;
      let depth = 0;
      let j = i + 1;
      for (; j < n; j += 1) {
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') { depth -= 1; if (depth === 0) break; }
      }
      word = (word ?? '') + command.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
       const m = /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(command.slice(i));
      if (m) {
        flushWord();
        pendingHeredocs.push({ seg, delimiter: m[3] });
        seg.words.push('<<');
        i += m[0].length;
        continue;
      }
    }
    if (c === '\n') {
      close(i, '\n');
      // Heredoc bodies start after the line that opened them; each ends at a line equal to its delimiter.
      let at = i + 1;
      for (const heredoc of pendingHeredocs.splice(0)) {
        let lineStart = at;
        let bodyEnd = n;
        let next = n;
        while (lineStart < n) {
          const lineEnd = command.indexOf('\n', lineStart) === -1 ? n : command.indexOf('\n', lineStart);
          if (command.slice(lineStart, lineEnd).trim() === heredoc.delimiter) { bodyEnd = lineStart; next = lineEnd; break; }
          lineStart = lineEnd + 1;
        }
        heredoc.seg.heredocs.push({ start: at, end: bodyEnd });
        at = next;
      }
      if (at !== i + 1) { seg.start = at; seg.end = at; i = at; continue; }
      i += 1;
      continue;
    }
    if (c === ';' || c === '(' || c === ')') { close(i, c); i += 1; continue; }
    if (c === '&' || c === '|') {
      if (c === '&' && command[i - 1] === '>') { word = (word ?? '') + c; i += 1; continue; } // 2>&1
      if (c === '&' && command[i + 1] === '>') { word = (word ?? '') + c; i += 1; continue; } // &>file
      const double = command[i + 1] === c;
      close(i, double ? c + c : c);
      i += double ? 2 : 1;
      continue;
    }
    if (c === ' ' || c === '\t') { flushWord(); i += 1; continue; }
    word = (word ?? '') + c;
    i += 1;
  }
  close(n, '');
  return segments.filter((segment) => segment.end > segment.start || segment.heredocs.length);
}

// The executable a segment runs, past keywords, variable assignments and exec-style wrappers with their options.
function headOf(words) {
  const rest = [...words];
  const skipOptions = (withValue = new Set()) => {
    while (rest.length && /^-/.test(rest[0])) {
      const option = rest.shift();
      if (withValue.has(option) && rest.length) rest.shift();
    }
  };
  for (;;) {
    if (!rest.length) return { head: '', args: [] };
    const first = rest[0];
    if (KEYWORDS.has(first)) { rest.shift(); continue; }
     if (/^[A-Za-z_]\w*=/.test(first)) { rest.shift(); continue; }
    if (WRAPPERS.has(first)) {
      rest.shift();
      if (first === 'env') skipOptions(new Set(['-u', '--unset', '-C', '--chdir', '-S']));
      else if (first === 'timeout') { skipOptions(new Set(['-k', '--kill-after', '-s', '--signal'])); if (/^\d/.test(rest[0] ?? '')) rest.shift(); }
      else if (first === 'nice') skipOptions(new Set(['-n', '--adjustment']));
      else skipOptions();
      continue;
    }
    return { head: first.split('/').at(-1), args: rest.slice(1) };
  }
}

// Every segment's head and arguments, past keywords, assignments and wrappers — the parser's view of what a command
// runs. The selftests use it as a second, independent route to the embedded command-head regexes in hooks.js.
export function commandHeads(command) {
  return scan(String(command ?? '')).map((segment) => headOf(segment.words)).filter(({ head }) => head);
}

// `pipelineSep` is the separator that ends a segment's whole pipeline: in `nohup pnpm test | tee log &` the `&` after
// `tee log` backgrounds `pnpm test` too.
export function executableSegments(command) {
  const text = String(command ?? '');
  const segments = scan(text);
  let pipelineSep = '';
  const ends = [];
  for (let k = segments.length - 1; k >= 0; k -= 1) {
    if (segments[k].sep !== '|') pipelineSep = segments[k].sep;
    ends[k] = pipelineSep;
  }
  return segments.map((segment, k) => ({ text: text.slice(segment.start, segment.end), sep: segment.sep, pipelineSep: ends[k],
    ...headOf(segment.words), start: segment.start })).filter((segment) => segment.head);
}

const WRITE_REDIRECT =/^(?:\d*|&)>>?(.*)$/;
function writesAFile(words) {
  for (let k = 0; k < words.length; k += 1) {
    const m = WRITE_REDIRECT.exec(words[k]);
    if (!m) continue;
    const target = m[1] || words[k + 1] || '';
    if (/^&\d*-?$/.test(target) || target === '/dev/null') continue;
    return true;
  }
  return false;
}

function readOnly(segment) {
  if (segment.subst) return false;
  // A loop condition belongs to its loop (`until grep -q done log; do sleep 60; done`): blanking it would hide the
  // loop from a trigger that governs the loop itself.
  if (/^(?:while|until)$/.test(segment.words[0] ?? '')) return false;
  const { head, args } = headOf(segment.words);
  if (!head) return false;
  if (args.includes('--help')) return true; // `opencode run --help` prints usage, it launches nothing
  if (head === 'git') {
    const rest = [...args];
    while (rest.length && /^-/.test(rest[0])) { const option = rest.shift(); if (/^-[Cc]$/.test(option) && rest.length) rest.shift(); }
    return READ_ONLY_GIT.has(rest[0] ?? '') && !writesAFile(segment.words);
  }
  if (!READ_ONLY.has(head)) return false;
  if (head === 'sed' && args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))) return false;
  return !writesAFile(segment.words);
}

const blank = (text) => text.replace(/[^\n]/g, ' ');

export function maskReadOnlyMentions(command) {
  const text = String(command ?? '');
  if (!text) return text;
  const segments = scan(text);
  // A pipeline (segments joined by a single `|`) that feeds an interpreter runs what its readers print.
  const pipelines = [];
  let current = [];
  for (const segment of segments) {
    current.push(segment);
    if (segment.sep !== '|') { pipelines.push(current); current = []; }
  }
  if (current.length) pipelines.push(current);
  const spans = [];
  for (const pipeline of pipelines) {
    const feedsInterpreter = pipeline.length > 1 && pipeline.slice(1).some((segment) => INTERPRETERS.has(headOf(segment.words).head));
    for (const segment of pipeline) {
      const { head } = headOf(segment.words);
      // A heredoc body is data unless an interpreter reads it (`python3 - <<EOF`, `bash <<EOF`).
      if (!INTERPRETERS.has(head) && !feedsInterpreter) for (const body of segment.heredocs) spans.push(body);
      if (!feedsInterpreter && readOnly(segment)) spans.push({ start: segment.start, end: segment.end });
      // A commit message is data, even though `git commit` itself is a write.
      if (head === 'git' && headOf(segment.words).args[0] === 'commit' && !segment.subst) {
        const source = text.slice(segment.start, segment.end);
        for (const match of source.matchAll(/(?:^|\s)-m\s+(?:"[^"]*"|'[^']*')/g)) {
          const start = segment.start + match.index + match[0].indexOf('-m');
          spans.push({ start, end: segment.start + match.index + match[0].length });
        }
      }
    }
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const span of spans) {
    if (span.end <= at) continue;
    const start = Math.max(span.start, at);
    out += text.slice(at, start) + blank(text.slice(start, span.end));
    at = span.end;
  }
  return out + text.slice(at);
}

// Port behavior, not machine state: pure SR Cloud 369120f verdicts with normalized classes only.
const GUARDED_PATTERNS = [
  ['cloud-secret', /\.atlassian-cli\/config/i],
  ['cloud-secret', /\.claude(-work)?\/secrets/i],
  ['npm-config', /\.npmrc\b/i],
  ['aws-credentials', /\.aws\/credentials/i],
  ['ssh-key', /\.ssh\/id_\w+(?!\.pub)\b/],
  ['gh-hosts', /\.config\/gh\/hosts/i],
  ['netrc', /\.netrc\b/i],
  ['shell-history', /(zsh|bash)_history\b/i],
  ['docker-config', /\.docker\/config\.json/i],
  ['kube-config', /\.kube\/config/i],
  ['pypi-config', /\.pypirc\b/i],
  ['git-credentials', /\.git-credentials\b/i],
];
const ENV_FILE = /(^|[/\s"'=])\.env(\.[A-Za-z0-9_-]+)?\b/;
const ENV_TEMPLATE = /\.env\.(example|sample|template|dist)\b/i;
const METADATA_ONLY = new Set(['ls', 'stat', 'test', '[', 'chmod', 'chown', 'rm', 'mv', 'touch', 'mkdir', 'basename', 'dirname', 'realpath', 'readlink', 'file', 'du', 'find', 'sha256sum', 'sha1sum', 'md5sum', 'cksum', 'shasum']);
const PROSE_VERBS = new Set(['echo', 'printf', 'git', 'gh', 'glab', 'atlassian-cli']);
const HEREDOC_PROSE_VERBS = new Set([...PROSE_VERBS, 'cat', 'tee']);
const INLINE_INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3']);
const INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);
const PATH_PREFIXES = ['${HOME}', '$HOME', '../', './', '/', '~', '$'];

function pathClass(text) {
  for (const [kind, expression] of GUARDED_PATTERNS) if (expression.test(text)) return kind;
  if (ENV_FILE.test(text) && !ENV_TEMPLATE.test(text)) return 'env-file';
  return null;
}

export function isGuarded(text) { return Boolean(text && pathClass(text)); }

function leadingVerb(segment) {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < words.length && (/^[A-Za-z_]\w*=/.test(words[index]) || words[index] === 'sudo')) index += 1;
  return (words[index] || '').replace(/^.*\//, '');
}

function allowsProse(segment) {
  const verb = leadingVerb(segment);
  if (PROSE_VERBS.has(verb)) return true;
  if (!INLINE_INTERPRETERS.has(verb)) return false;
  const words = segment.trim().split(/\s+/).filter(Boolean);
  return !words.some((word) => INLINE_FLAGS.has(word) || word === '-' || word.startsWith('--input-type'));
}

function ranges(text) {
  const result = []; const separator = /\|\||&&|[;|\n]/g; let last = 0;
  for (let match; (match = separator.exec(text));) { result.push({ start: last, end: match.index }); last = match.index + match[0].length; }
  result.push({ start: last, end: text.length }); return result;
}

function quotedSpans(text) {
  const spans = []; let quote = null; let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === null) {
      if (character === '\\' && index + 1 < text.length) { index += 1; continue; }
      if (character === '"' || character === "'") { quote = character; start = index + 1; }
    } else if (quote === '"') {
      if (character === '\\' && index + 1 < text.length) { index += 1; continue; }
      if (character === '"') { spans.push({ start, end: index }); quote = null; }
    } else if (character === "'") { spans.push({ start, end: index }); quote = null; }
  }
  return spans;
}

function patternMatches(text) {
  const found = [];
  for (const [, expression] of GUARDED_PATTERNS) {
    const global = new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : `${expression.flags}g`);
    for (let match; (match = global.exec(text));) found.push({ index: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return found.sort((left, right) => left.index - right.index);
}

function neutralizeMentions(text) {
  const spans = quotedSpans(text); const segments = ranges(text); const mentions = []; let result = text;
  const punctuation = new Set([',', '.', ';', ':', '!', '?', ')', '»']);
  const matches = patternMatches(text);
  for (let offset = matches.length - 1; offset >= 0; offset -= 1) {
    const match = matches[offset];
    const before = text.slice(Math.max(0, match.index - 8), match.index);
    if (PATH_PREFIXES.some((prefix) => before.endsWith(prefix))) continue;
    const span = spans.find((item) => match.index >= item.start && match.end <= item.end);
    if (!span || text.slice(span.start, span.end).trim().split(/\s+/).length < 2) continue;
    const adjacent = (match.index === span.start || /\s/.test(text[match.index - 1]) || text[match.index - 1] === '«')
      && (match.end === span.end || /\s/.test(text[match.end]) || punctuation.has(text[match.end]));
    if (!adjacent) continue;
    const segmentRange = segments.find((item) => match.index >= item.start && match.index <= item.end);
    const segment = segmentRange ? text.slice(segmentRange.start, segmentRange.end) : text;
    if (!allowsProse(segment)) continue;
    mentions.push(match.text); result = `${result.slice(0, match.index)}MENTION_REDACTED${result.slice(match.end)}`;
  }
  return { text: result, mentions };
}

function stripHeredocBodies(text) {
  const lines = text.split('\n'); const kept = []; let closer = null;
  for (const line of lines) {
    if (closer !== null) { if (line.trim() === closer) closer = null; continue; }
    kept.push(line);
    const match = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/);
    if (match) closer = match[1] ?? match[2] ?? match[3];
  }
  return kept.join('\n');
}

function applyHeredocPolicy(original, stripped) {
  const source = original.split('\n'); const kept = stripped.split('\n'); const output = []; const mentions = [];
  let sourceIndex = 0; let keptIndex = 0;
  while (sourceIndex < source.length) {
    if (keptIndex < kept.length && source[sourceIndex] === kept[keptIndex]) { output.push(source[sourceIndex]); sourceIndex += 1; keptIndex += 1; continue; }
    const start = sourceIndex;
    while (sourceIndex < source.length && !(keptIndex < kept.length && source[sourceIndex] === kept[keptIndex])) sourceIndex += 1;
    const removed = source.slice(start, sourceIndex);
    const opener = output.at(-1) ?? '';
    const heredocIndex = opener.search(/<<-?/);
    const openerRanges = ranges(opener);
    const openerRange = openerRanges.find((item) => heredocIndex >= item.start && heredocIndex <= item.end);
    const verb = leadingVerb(openerRange ? opener.slice(openerRange.start, openerRange.end) : opener);
    if (HEREDOC_PROSE_VERBS.has(verb)) {
      for (const line of removed) if (isGuarded(line)) mentions.push(line.trim());
    } else output.push(...removed);
  }
  return { text: output.join('\n'), mentions };
}

function metadataOnly(segment) {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  if (words.some((word) => /^-(exec|execdir|ok|okdir)$/.test(word))) return false;
  const verb = leadingVerb(segment);
  return verb === 'wc' || METADATA_ONLY.has(verb);
}

function guardedRedirection(command) {
  const markers = ['.atlassian-cli', 'secrets', '.npmrc', 'credentials', '_history'];
  const lower = command.toLowerCase();
  for (let index = 0; index < lower.length; index += 1) {
    if (lower[index] !== '<' && lower[index] !== '>') continue;
    let start = index + 1; while (start < lower.length && /\s/.test(lower[start])) start += 1;
    let end = start; while (end < lower.length && !/[\s|;&]/.test(lower[end])) end += 1;
    if (markers.some((marker) => lower.slice(start, end).includes(marker))) return true;
  }
  return false;
}

function rawVerdict(command) {
  if (!isGuarded(command)) return null;
  if (guardedRedirection(command)) return 'a redirection involving a guarded path';
  const guarded = command.split(/\|\||&&|[;|\n]/).filter(isGuarded);
  if (!guarded.length) return 'a guarded path this hook could not attribute to a segment';
  return guarded.find((segment) => !metadataOnly(segment))?.trim().slice(0, 120) ?? null;
}

export function verdictForBash(command) {
  if (typeof command !== 'string' || !isGuarded(command)) return { hit: false, mentions: [], ruleId: 'guarded-path-read', commandClass: 'bash', verdict: null };
  const heredoc = applyHeredocPolicy(command, stripHeredocBodies(command));
  const prose = neutralizeMentions(heredoc.text);
  const verdict = rawVerdict(prose.text);
  return { hit: Boolean(verdict), mentions: [...heredoc.mentions, ...prose.mentions], ruleId: verdict ? 'guarded-path-read' : 'guarded-path-mention', pathClass: pathClass(command) ?? 'other-guarded', commandClass: 'bash', verdict };
}

export function verdictForPath(path, surface = 'read') {
  if (typeof path !== 'string') return { hit: false, mentions: [], ruleId: 'guarded-path-read', commandClass: surface };
  const kind = pathClass(path);
  return { hit: Boolean(kind), mentions: [], ruleId: 'guarded-path-read', pathClass: kind ?? undefined, commandClass: surface };
}

// Pure parser/planner: compute equal-length byte replacements separately from host writes.
function byteLength(value) { return new TextEncoder().encode(value).length; }

function jsonStringRanges(text) {
  const ranges = [];
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '')) cursor += 1; };
  const string = () => {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === '\\') cursor += 2;
      else if (text[cursor++] === '"') return { start: start + 1, end: cursor - 1, value: JSON.parse(text.slice(start, cursor)) };
    }
    throw new Error('unterminated JSON string');
  };
  const value = (path) => {
    whitespace();
    if (text[cursor] === '"') { const range = string(); ranges.push({ ...range, path }); return; }
    if (text[cursor] === '{') {
      cursor += 1; whitespace();
      while (text[cursor] !== '}') {
        const key = string().value; whitespace();
        if (text[cursor++] !== ':') throw new Error('invalid JSON object');
        value([...path, key]); whitespace();
        if (text[cursor] !== ',') break;
        cursor += 1; whitespace();
      }
      if (text[cursor++] !== '}') throw new Error('invalid JSON object');
      return;
    }
    if (text[cursor] === '[') {
      cursor += 1; whitespace(); let index = 0;
      while (text[cursor] !== ']') {
        value([...path, index]); index += 1; whitespace();
        if (text[cursor] !== ',') break;
        cursor += 1; whitespace();
      }
      if (text[cursor++] !== ']') throw new Error('invalid JSON array');
      return;
    }
    const start = cursor;
    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor += 1;
    if (start === cursor) throw new Error('invalid JSON value');
  };
  value([]); whitespace();
  if (cursor !== text.length) throw new Error('trailing JSON content');
  return ranges;
}

export function locateReplacements(text, replacements, target) {
  const located = [];
  let lineStart = 0;
  for (const lineWithReturn of text.split('\n')) {
    const line = lineWithReturn.endsWith('\r') ? lineWithReturn.slice(0, -1) : lineWithReturn;
    if (!line) { lineStart += byteLength(lineWithReturn) + 1; continue; }
    const record = JSON.parse(line);
    const queueTarget = target === 'queue' && record.type === 'queue-operation';
    for (const range of jsonStringRanges(line)) {
      let eligible = target === 'history' ? range.path[0] === 'display' || range.path[0] === 'pastedContents' : queueTarget && range.path[0] === 'content';
      if (target?.kind === 'tool-use') {
        for (let depth = 0; depth < range.path.length; depth += 1) {
          const candidate = range.path.slice(0, depth).reduce((value, key) => value?.[key], record);
          if (candidate?.type === 'tool_use' && candidate.id === target.toolUseId && range.path[depth] === 'input') eligible = true;
        }
      }
      if (!eligible) continue;
      const source = line.slice(range.start, range.end);
      for (const { raw, token } of replacements) {
        const escaped = JSON.stringify(raw).slice(1, -1);
        for (let index = source.indexOf(escaped); index !== -1; index = source.indexOf(escaped, index + escaped.length)) {
          const length = byteLength(escaped);
          const replacement = byteLength(token) <= length ? token.padEnd(length, '*') : '*'.repeat(length);
          located.push({ offset: lineStart + byteLength(line.slice(0, range.start + index)), expected: escaped, replacement, length });
        }
      }
    }
    lineStart += byteLength(lineWithReturn) + 1;
  }
  return located;
}

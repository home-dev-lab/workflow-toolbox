// Parse, then transform: build a pure rewrite plan before any host resolution occurs.
const OP_PATH = /^[\p{L}\p{N}._' -]+(?:\/[\p{L}\p{N}._' -]+){2,3}$/u;
const quoteForSingleQuotes = (value) => value.replace(/'/g, "'\"'\"'");

function quoteContextAt(command, end) {
  let quote = null; let opener = -1;
  for (let index = 0; index < end; index += 1) {
    const character = command[index];
    if (character === '\\' && quote === '"') { index += 1; continue; }
    if (character !== "'" && character !== '"') continue;
    if (quote === character) { quote = null; opener = -1; } else if (!quote) { quote = character; opener = index; }
  }
  return { quote, opener };
}

function closingQuote(command, start, quote) {
  for (let index = start; index < command.length; index += 1) {
    if (command[index] === '\\' && quote === '"') { index += 1; continue; }
    if (command[index] === quote) return index;
  }
  return -1;
}

function heredocBodies(command) {
  const ranges = [];
  const expression = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  for (let match; (match = expression.exec(command));) {
    const bodyStart = command.indexOf('\n', expression.lastIndex);
    if (bodyStart < 0) continue;
    let lineStart = bodyStart + 1;
    while (lineStart <= command.length) {
      const lineEnd = command.indexOf('\n', lineStart);
      const end = lineEnd < 0 ? command.length : lineEnd;
      if (command.slice(lineStart, end).replace(/^\t+/, '') === match[2]) { ranges.push([bodyStart + 1, end]); expression.lastIndex = end; break; }
      if (lineEnd < 0) break;
      lineStart = lineEnd + 1;
    }
  }
  return ranges;
}

function hasTemplateDestination(command) {
  return /(?:>{1,2}|\btee(?:\s+-\w+)*)\s*(?:"[^"\n]*\.tpl"|'[^'\n]*\.tpl'|[^\s;|&]+\.tpl)(?=\s|$|[;|&])/m.test(command) || /\bop(?:\.exe)?\s+inject\b/.test(command);
}

function isOpConsumer(command, index) {
  const segment = command.slice(Math.max(command.lastIndexOf(';', index - 1), command.lastIndexOf('\n', index - 1)) + 1, index);
  return /\bop(?:\.exe)?\s+(?:read|inject|run)\b/.test(segment);
}

export function opInvocationsIn(command) {
  const expression = /\bop(?:\.exe)?\s+read(?:\s+--account\s+(?:'([^']*)'|"([^"]*)"|([^\s"']+)))?\s+(?:'(op:\/\/[^']+)'|"(op:\/\/[^"]+)"|(op:\/\/[^\s"']+))/g;
  const invocations = [];
  for (let match; (match = expression.exec(command));) invocations.push({ account: match[1] ?? match[2] ?? match[3] ?? '', ref: match[4] ?? match[5] ?? match[6] });
  return invocations;
}

export function rewriteOpReferences(command, account = '') {
  // Measured 2026-09-08: OP_ACCOUNT does not cross WSL interop, while the explicit
  // --account positional argv does, so account identity remains part of each invocation.
  if (hasTemplateDestination(command)) return { command, count: 0, references: [] };
  const bodies = heredocBodies(command);
  const prefix = /secret:1p:|op:\/\//g;
  const replacements = []; const references = [];
  for (let match; (match = prefix.exec(command));) {
    if (bodies.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const context = quoteContextAt(command, match.index);
    const pathStart = prefix.lastIndex;
    let path; let end; let replacementStart = match.index; let replacementEnd;
    if (context.quote && context.opener + 1 === match.index) {
      end = closingQuote(command, pathStart, context.quote);
      if (end < 0) continue;
      path = command.slice(pathStart, end); replacementStart = context.opener; replacementEnd = end + 1;
    } else {
      const pathMatch = command.slice(pathStart).match(/^[\p{L}\p{N}._'-]+(?:\/[\p{L}\p{N}._'-]+){2,3}(?!\/)/u);
      if (!pathMatch) continue;
      path = pathMatch[0]; replacementEnd = pathStart + path.length;
    }
    if (!OP_PATH.test(path)) continue;
    const reference = `op://${path}`;
    if (isOpConsumer(command, match.index)) continue;
    if (context.quote && (context.opener + 1 !== match.index || replacementEnd !== end + 1)) continue;
    const accountArg = account ? ` --account '${quoteForSingleQuotes(account)}'` : '';
    replacements.push({ start: replacementStart, end: replacementEnd, value: `"$(op read${accountArg} 'op://${quoteForSingleQuotes(path)}')"` });
    references.push({ ref: reference, account }); prefix.lastIndex = replacementEnd;
  }
  let rewritten = command;
  for (const replacement of replacements.reverse()) rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
  const exact = opInvocationsIn(rewritten);
  const unique = new Map([...references, ...exact].map((item) => [`${item.account}:${item.ref}`, item]));
  return { command: rewritten, count: replacements.length, references: [...unique.values()] };
}

export { quoteForSingleQuotes };

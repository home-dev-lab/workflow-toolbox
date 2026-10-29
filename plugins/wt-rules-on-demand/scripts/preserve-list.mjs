// The sub-agent pre-serve list, `type=rule[,rule...][;type=...]`. Pure and import-free: the SubagentStart hook parses it
// at every spawn before it loads anything else.
const ruleName = (name) => (name.endsWith('.md') ? name : `${name}.md`);

function parseEntry(entry) {
  const at = entry.indexOf('=');
  if (at === -1) return null;
  const type = entry.slice(0, at).trim();
  const rules = entry.slice(at + 1).split(',').map((name) => name.trim()).filter(Boolean).map(ruleName);
  return type && rules.length ? { type, rules } : null;
}

export function parsePreserveRules(value) {
  const list = new Map();
  if (typeof value !== 'string') return list;
  for (const entry of value.split(';')) {
    const parsed = parseEntry(entry);
    if (!parsed) continue;
    const known = list.get(parsed.type) ?? [];
    for (const rule of parsed.rules) if (!known.includes(rule)) known.push(rule);
    list.set(parsed.type, known);
  }
  return list;
}

export const START_LINE_CAP = 400;

// One SessionStart line naming every configured type, cut whole-clause at START_LINE_CAP with `+<K> more`.
export function preserveStartLine(list) {
  const prefix = 'wt-rules-on-demand: rules served at sub-agent start for: ';
  const clauses = [...list].map(([type, rules]) => `${type} (${rules.length} ${rules.length === 1 ? 'rule' : 'rules'})`);
  if (!clauses.length) return '';
  let line = prefix;
  let shown = 0;
  for (const clause of clauses) {
    const rest = clauses.length - shown - 1;
    const tail = rest ? `, +${rest} more` : '';
    const next = `${line}${shown ? ', ' : ''}${clause}`;
    if (next.length + tail.length > START_LINE_CAP && shown) break;
    if (next.length + tail.length > START_LINE_CAP) return `${prefix}+${clauses.length} more`;
    line = next;
    shown++;
  }
  return shown < clauses.length ? `${line}, +${clauses.length - shown} more` : line;
}

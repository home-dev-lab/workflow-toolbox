import { maskReadOnlyMentions, executableSegments } from './bash-mention.js';
import { bounded } from './evidence.js';

// Keep this dependency tree free of node: imports: the Function Hooks host rejects them.
export const CHECKS = Object.freeze(['agent-model', 'gate-background']);

export function bashCommandVerdict(compliance, command) {
  const followed = compliance.require
    ? compliance.require.test(bounded(command))
    : compliance.requireAll.every((part) => bounded(command).includes(part));
  return followed ? 'followed' : 'not followed';
}

export function isGovernedAct(compliance, event) {
  if (compliance.kind === 'bash-command') return event.tool === 'Bash' && compliance.act.test(maskReadOnlyMentions(bounded(event.command)));
  return compliance.kind === 'test-before-edit' && /^(?:Edit|Write)$/.test(event.tool)
    && compliance.path.test(bounded(event.path ?? event.file_path ?? event.input?.path ?? event.input?.file_path));
}

const ASSIGN = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const CMDPOS = String.raw`(?:^|[;&|(\n{]\s*|\bdo\s+|\bthen\s+|-c\s+["']|\btimeout\s+(?:(?:-\S+|\d\S*)\s+)+|\b(?:nohup|exec|time|env)\s+|\bsetsid\s+(?:-\S+\s+)*)` + ASSIGN;
const PKG_FLAGS = String.raw`(?:(?:-C|--dir|--filter|-F|--prefix|-w|--workspace)\s+\S+\s+|-r\s+|--recursive\s+|--silent\s+|-s\s+)*`;
const GATE = new RegExp(CMDPOS + String.raw`(?:(?:pnpm|npm|yarn)\s+${PKG_FLAGS}(?:run\s+|exec\s+)?(?:test|typecheck|lint|build|e2e|check|vitest|jest|tsc)\b|(?:npx|pnpx|bunx)\s+(?:vitest|jest|tsc\s+(?:-p|-b|--noEmit|--build))\b|(?:\S*/)?(?:vitest|jest|pytest)\b|(?:\S*/)?playwright\s+test\b|node\s+(?:--\S+\s+)*--test\b|bun\s+test\b|(?:\S*/)?tsc\s+(?:-p|-b|--noEmit|--build)\b)`, 'm');
const ROD_REFUSAL = 'wt-rules-on-demand: read the rule below before this action';
const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => typeof c === 'string' ? c : c?.text ?? '').join('\n');
  return '';
};

// Heredoc BODIES are data, not commands: bash-mention.js's scan() skips them itself. Pre-stripping them here left a
// `<<HEREDOC` placeholder that scan() re-read as a new, never-closed heredoc, swallowing every later segment (seed
// opencode-V, round 5). Known miss: a gate written to a script by heredoc
// and then launched will not be seen; the source checker accepts that cost.
export function classify(name, input = {}) {
  if (name === 'Agent' || name === 'Task') {
    const ok = typeof input.model === 'string' && input.model.trim() !== '';
    return { check: 'agent-model', verdict: ok ? 'FOLLOWED' : 'VIOLATED', detail: ok ? `model=${input.model}` : 'no model input' };
  }
  if (name === 'Bash' && typeof input.command === 'string') {
    const acts = [];
    const segments = executableSegments(maskReadOnlyMentions(input.command));
    for (const [segment, item] of segments.entries()) {
    const cmd = item.text;
    const invocation = `${item.head} ${item.args.join(' ')}`;
    if (GATE.test(cmd) || GATE.test(invocation)) {
      const bg = input.run_in_background === true;
      const wrapped = /\b(?:nohup|setsid)\b/.test(cmd) && item.pipelineSep === '&';
      const ok = bg || wrapped;
       let detail = `foreground: ${cmd.slice(0, 120).replace(/\s+/g, ' ')}`;
       if (ok) detail = bg ? 'run_in_background' : 'nohup/setsid &';
       acts.push({ check: 'gate-background', verdict: ok ? 'FOLLOWED' : 'VIOLATED', detail, segment });
    }
    }
    return acts;
  }
  return null;
}

// Judge generic acts from transcript tool calls.
export function checkLines(lines, { file = '', seen = null } = {}) {
  const events = [];
  lines.forEach((raw, index) => {
    if (typeof raw === 'object') {
      if (raw.kind === 'use') events.push({ kind: 'use', id: raw.id, name: raw.name, input: raw.input, ts: raw.at, line: raw.line });
      if (raw.kind === 'result') events.push({ kind: 'result', id: raw.id, text: raw.text ?? '', isError: raw.isError });
      if (raw.kind === 'turn') events.push({ kind: 'turn' });
      return;
    }
    if (!raw || raw[0] !== '{' || !/"(?:tool_use|tool_result|user)"/.test(raw)) return;
    let obj;
    try { obj = JSON.parse(raw); } catch { return; }
    const msg = obj.message;
    if (!msg || !Array.isArray(msg.content) && typeof msg.content !== 'string') return;
    if (obj.type === 'user') {
      const content = msg.content;
      const results = Array.isArray(content) ? content.filter((c) => c?.type === 'tool_result') : [];
      for (const r of results) events.push({ kind: 'result', id: r.tool_use_id, text: textOf(r.content), isError: r.is_error === true });
      if ((typeof content === 'string' || content.some((c) => c?.type === 'text')) && !results.length && !obj.isMeta && !obj.isCompactSummary) events.push({ kind: 'turn' });
    } else if (obj.type === 'assistant') {
      for (const c of msg.content) if (c?.type === 'tool_use') events.push({ kind: 'use', id: c.id, name: c.name, input: c.input ?? {}, ts: obj.timestamp ?? null, line: index + 1 });
    }
  });
  const resultOf = new Map(events.filter((e) => e.kind === 'result').map((e) => [e.id, e]));
  const acts = [];
  for (const e of events) {
    if (e.kind !== 'use') continue;
    const classified = classify(e.name, e.input);
    if (!classified) continue;
    if (seen) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
    }
    const r = resultOf.get(e.id);
    for (const c of Array.isArray(classified) ? classified : [classified]) {
    const base = { file, line: e.line, ts: e.ts, tool: e.name, check: c.check, toolUseId: e.id, ...(c.segment !== undefined ? { segment: c.segment } : {}) };
    if (r && r.text.includes(ROD_REFUSAL)) { acts.push({ ...base, verdict: 'refused', detail: 'engine before-first-act refusal' }); continue; }
    acts.push({ ...base, verdict: c.verdict, detail: c.detail });
    }
  }
  return acts;
}

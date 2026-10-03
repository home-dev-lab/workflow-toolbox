import { argumentEvidence, bounded, SUBJECT_CAP } from './evidence.js';
import { executableSegments, maskReadOnlyMentions, shellAssignments } from './bash-mention.js';

const test = (regex, text) => { regex.lastIndex = 0; return regex.test(bounded(text)); };
const capture = (regex, text) => { regex.lastIndex = 0; return regex.exec(bounded(text))?.[1] ?? null; };
const values = (regex, text) => {
  const found = [];
  for (const match of regex.matchAll(bounded(text))) if (match[1]) found.push(match[1]);
  return found;
};

function withoutCode(text) {
  let start = 0, cursor = 0, output = '';
  while (cursor < text.length) {
    const open = text.indexOf('`', cursor);
    if (open < 0) break;
    const fence = text.startsWith('```', open);
    const close = text.indexOf(fence ? '```' : '`', open + (fence ? 3 : 1));
    if (close < 0 || !fence && text.slice(open + 1, close).includes('\n')) { cursor = open + 1; continue; }
    output += text.slice(start, open);
    cursor = close + (fence ? 3 : 1);
    start = cursor;
  }
  output += text.slice(start);
  if (output.startsWith('---\n')) {
    const end = output.indexOf('\n---', 4);
    if (end >= 0 && (output[end + 4] === '\n' || end + 4 === output.length)) output = output.slice(end + 4).replace(/^\n/, '');
  }
  return output;
}

export function toolInputVerdict(compliance, event) {
  try { return { verdict: judgeToolInput(compliance, event), matchError: null }; }
  catch (error) {
    return { verdict: 'unknown', matchError: String(error?.message ?? error) };
  }
}

function judgeToolInput(compliance, event) {
  if (event.tool === 'Bash' && compliance.rejectBash && executableSegments(maskReadOnlyMentions(bounded(event.input?.command)))
    .some((part) => test(compliance.rejectBash, part.text))) return 'not followed';
  if (!test(compliance.tool, bounded(event.tool))) return null;
  if (compliance.path && !test(compliance.path, bounded(event.input?.file_path ?? event.input?.path ?? ''))) return null;
  let raw = event.input;
  if (compliance.inputField === 'edit-text') raw = event.input?.content ?? event.input?.new_string ?? event.input?.edits;
  else if (compliance.inputField) raw = compliance.inputField.split('||').map((key) => event.input?.[key]).find((value) => value !== undefined);
  let evidence = argumentEvidence(raw);
  if (compliance.inputField) evidence = bounded(Array.isArray(raw) ? raw.map((item) => item?.new_string ?? '').join('\n') : raw);
  if (compliance.maskCode && typeof evidence === 'string') evidence = withoutCode(evidence);
  if (compliance.when && !test(compliance.when, evidence ?? '')) return null;
  let subjects = [evidence];
  if (compliance.matchBlock) subjects = values(compliance.matchBlock, evidence ?? '');
  else if (compliance.eachLine) subjects = (evidence ?? '').split('\n').filter((line) => test(compliance.eachLine, line));
  if (!subjects.length) return null;
  const meets = (value) => value !== null && compliance.required.every((regex) => test(regex, value))
    && (!compliance.any?.length || compliance.any.some((regex) => test(regex, value)))
    && (!compliance.forbidden || !test(compliance.forbidden, value));
  return subjects.every(meets)
    && (!compliance.absentKey || !Object.hasOwn(event.input ?? {}, compliance.absentKey))
    && (!compliance.minimumKey || Number(event.input?.[compliance.minimumKey]) >= compliance.minimumValue) ? 'followed' : 'not followed';
}

// Substitutes `$NAME` / `${NAME}` the way the shell would: never inside single quotes or after a backslash, and never
// past the subject cap (a self-doubling value stays bounded).
function expand(text, vars) {
  let output = '', quoted = false, i = 0;
  while (i < text.length && output.length < SUBJECT_CAP) {
    const c = text[i];
    if (c === '\\' && !quoted) { output += text.slice(i, i + 2); i += 2; continue; }
    if (c === "'" && !quoted) {
      const close = text.indexOf("'", i + 1);
      const stop = close < 0 ? text.length : close + 1;
      output += text.slice(i, stop); i = stop; continue;
    }
    if (c === '"') quoted = !quoted;
    const match = c === '$' ? /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(text.slice(i)) : null;
    if (match && vars.has(match[1] ?? match[2])) { output += vars.get(match[1] ?? match[2]); i += match[0].length; continue; }
    output += c; i += 1;
  }
  return bounded(output);
}

// Each governed segment also carries `expanded`: its text with the variables assigned by EARLIER segments of the same
// command substituted (last assignment wins), so `W=<path>; git worktree add "$W"` is judged on the path it uses.
export function bashSegments(compliance, command) {
  const text = maskReadOnlyMentions(bounded(command));
  const assignments = shellAssignments(text);
  return executableSegments(text).filter((part) => test(compliance.act, `${part.head} ${part.args.join(' ')}`) || test(compliance.act, part.text))
    .map((part) => {
      const vars = new Map();
      for (const { start, name, value, unset } of assignments) {
        if (start >= part.start) break;
        if (unset) vars.delete(name); else vars.set(name, expand(value, vars));
      }
      const expanded = expand(part.text, vars);
      return expanded === part.text ? part : { ...part, expanded };
    });
}

export function segmentVerdict(compliance, segment) {
  if (compliance.exempt && test(compliance.exempt, `${segment.head} ${segment.args.join(' ')}`)) return 'not applicable';
  const meets = (text) => compliance.require ? test(compliance.require, text) : compliance.requireAll.every((part) => text.includes(part));
  const satisfied = meets(bounded(segment.text)) || typeof segment.expanded === 'string' && meets(bounded(segment.expanded));
  return satisfied && (!compliance.forbidPipe || segment.sep !== '|' && segment.sep !== '|&') ? 'followed' : 'not followed';
}

function bashValues(compliance, command, id) {
  command = bounded(command);
  const output = [];
  for (const segment of executableSegments(maskReadOnlyMentions(bounded(command)))) {
    if (!compliance.act || !test(compliance.act, segment.text) || !segment.text.includes(id)) continue;
    output.push(...values(compliance.value, segment.text));
  }
  // Shell loops expose one tool call but several invocations; the result confirms the whole loop succeeded.
  const loop = /\bfor\s+(\w+)\s+in\b/.exec(command);
  const rest = loop ? command.slice(loop.index + loop[0].length) : '';
  const separator = rest.indexOf(';');
  const body = separator < 0 ? '' : rest.slice(separator + 1).split(/\bdone\b/, 1)[0];
  if (compliance.act && loop && separator >= 0 && /\bdo\b/.test(body) && test(compliance.act, body) && body.includes(id) && new RegExp(String.raw`\$\{?${loop[1]}\b`).test(body))
    output.push(...rest.slice(0, separator).trim().split(/\s+/));
  return output;
}

// Events are one context's uses, results and turn boundaries. One result per subject;
// unresolved is explicit whenever the turn is still open or an id could not be proven.
export function correlateTurn(compliance, events) {
  try { return judgeTurn(compliance, events); }
  catch (error) {
    return events.filter((event) => event.kind === 'use').map((event) => ({ id: event.id, verdict: 'unresolved', detail: String(error?.message ?? error) }));
  }
}

function judgeTurn(compliance, events) {
  const results = new Map(events.filter((event) => event.kind === 'result').map((event) => [event.id, event]));
  const output = [];
  let turn = [];
  const close = (closed) => {
    const usedPartners = new Set();
    for (const subject of turn.filter((event) => event.kind === 'use' && test(compliance.tool, bounded(event.name))
      && (!compliance.subjectInput || test(compliance.subjectInput, bounded(event.input?.[compliance.subjectInputKey]))))) {
      const result = results.get(subject.id);
      if (result?.text?.includes('wt-rules-on-demand: read the rule below before this action')) {
        output.push({ id: subject.id, verdict: 'refused', detail: 'before-first-act refusal' });
        continue;
      }
      const input = argumentEvidence(subject.input) ?? '';
      const confirmed = result && !result.isError;
      const id = confirmed ? capture(compliance.id, bounded(result.text)) ?? capture(compliance.id, input) : null;
      if (compliance.identityPair) {
        const index = turn.indexOf(subject);
        const partner = id && turn.slice(index + 1).find((event) => event.kind === 'use' && !usedPartners.has(event.id) && compliance.followUpTool
           && test(compliance.followUpTool, bounded(event.name)) && (event.input?.to === id || event.input?.to === subject.input?.name)
           && values(compliance.value, bounded(event.input?.message)).includes(id)
           && results.has(event.id) && !results.get(event.id).isError
           && !results.get(event.id).text?.includes('wt-rules-on-demand: read the rule below before this action'));
        if (partner) { usedPartners.add(partner.id); }
        let verdict = 'unresolved';
        if (id && closed) verdict = partner ? 'followed' : 'not followed';
        output.push({ id: subject.id, verdict });
        continue;
      }
      const collected = new Set(confirmed ? values(compliance.value, input) : []);
      if (id) for (const event of turn) {
        if (event.kind !== 'use' || event === subject) continue;
        const confirmation = results.get(event.id);
        if (!confirmation || confirmation.isError || /wt-rules-on-demand: read the rule below before this action/.test(confirmation.text ?? '')) continue;
        const evidence = argumentEvidence(event.input) ?? '';
        if (event.name === 'Bash') for (const value of bashValues(compliance, event.input?.command ?? '', id)) collected.add(value);
        else if (compliance.followUpTool && test(compliance.followUpTool, bounded(event.name)) && evidence.includes(id))
          for (const value of values(compliance.value, evidence)) collected.add(value);
      }
      let verdict = 'unresolved';
      if (id && closed) verdict = collected.size >= compliance.minDistinct ? 'followed' : 'not followed';
      let detail = 'no tool result';
      if (result) detail = 'failed or no subject id in result';
      if (id) detail = `subject ${id}: ${collected.size} distinct confirmed values in turn`;
      output.push({ id: subject.id, verdict, detail });
    }
    turn = [];
  };
  for (const event of events) if (event.kind === 'turn' || event.kind === 'compact') close(true);
  else turn.push(event);
  close(false);
  return output;
}

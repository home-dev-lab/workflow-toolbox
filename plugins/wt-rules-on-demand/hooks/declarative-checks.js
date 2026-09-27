import { argumentEvidence, bounded } from './evidence.js';
import { executableSegments, maskReadOnlyMentions } from './bash-mention.js';

const test = (regex, text) => { regex.lastIndex = 0; return regex.test(text); };
const capture = (regex, text) => { regex.lastIndex = 0; return regex.exec(text)?.[1] ?? null; };
const values = (regex, text) => {
  const found = [];
  const matcher = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  for (const match of bounded(text).matchAll(matcher)) if (match[1]) found.push(match[1]);
  return found;
};

export function toolInputVerdict(compliance, event) {
  if (!test(compliance.tool, bounded(event.tool))) return null;
  const evidence = argumentEvidence(event.input);
  return evidence && compliance.required.every((regex) => test(regex, evidence)) ? 'followed' : 'not followed';
}

export function bashSegments(compliance, command) {
  return executableSegments(maskReadOnlyMentions(bounded(command))).filter((part) => test(compliance.act, `${part.head} ${part.args.join(' ')}`) || test(compliance.act, part.text));
}

export function segmentVerdict(compliance, segment) {
  if (compliance.exempt && test(compliance.exempt, `${segment.head} ${segment.args.join(' ')}`)) return 'not applicable';
  const text = bounded(segment.text);
  const satisfied = compliance.require ? test(compliance.require, text) : compliance.requireAll.every((part) => text.includes(part));
  return satisfied ? 'followed' : 'not followed';
}

function bashValues(compliance, command, id) {
  command = bounded(command);
  const output = [];
  for (const segment of executableSegments(maskReadOnlyMentions(bounded(command)))) {
    if (!test(compliance.act, segment.text) || !segment.text.includes(id)) continue;
    output.push(...values(compliance.value, segment.text));
  }
  // Shell loops expose one tool call but several invocations; the result confirms the whole loop succeeded.
  const loop = /\bfor\s+(\w+)\s+in\b/.exec(command);
  const rest = loop ? command.slice(loop.index + loop[0].length) : '';
  const separator = rest.indexOf(';');
  const body = separator < 0 ? '' : rest.slice(separator + 1).split(/\bdone\b/, 1)[0];
  if (loop && separator >= 0 && /\bdo\b/.test(body) && test(compliance.act, body) && body.includes(id) && new RegExp(String.raw`\$\{?${loop[1]}\b`).test(body))
    output.push(...rest.slice(0, separator).trim().split(/\s+/));
  return output;
}

// Events are one context's uses, results and turn boundaries. One result per subject;
// unresolved is explicit whenever the turn is still open or an id could not be proven.
export function correlateTurn(compliance, events) {
  const results = new Map(events.filter((event) => event.kind === 'result').map((event) => [event.id, event]));
  const output = [];
  let turn = [];
  const close = (closed) => {
    for (const subject of turn.filter((event) => event.kind === 'use' && test(compliance.tool, bounded(event.name)))) {
      const result = results.get(subject.id);
      const input = argumentEvidence(subject.input) ?? '';
      const confirmed = result && !result.isError;
      const id = confirmed ? capture(compliance.id, bounded(result.text)) ?? capture(compliance.id, input) : null;
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

import { bounded, argumentEvidence } from './evidence.js';
import { maskReadOnlyMentions, executableHeads } from './bash-mention.js';

export function testTriggerRegex(trigger, regex, text, onError, budget) {
  const subject = bounded(text);
  try { return regex.test(subject, budget); }
  catch (error) {
    onError?.({ kind: trigger.kind, pattern: regex.source, length: subject.length, error: String(error?.message ?? error) });
    return true;
  }
}

export function unevaluatedTrigger(trigger, item) {
  const regex = trigger.kind === 'tool' || trigger.kind === 'path' ? trigger.tool : trigger.regex;
  let text = item.tool;
  if (trigger.kind === 'prompt') text = item.text;
  else if (trigger.kind === 'bash') text = item.command;
  return { kind: trigger.kind, pattern: regex.source, length: bounded(text).length,
    error: 'shared regex call budget exhausted; trigger unevaluated' };
}

export function triggerMatches(trigger, item, onError, budget) {
  if (trigger.detector && item.detected?.get(trigger) !== true) return false;
  let failed = false;
  const test = (regex, text) => testTriggerRegex(trigger, regex, text, (error) => { failed = true; onError?.(error); }, budget);
  if (trigger.kind === 'prompt') return item.channel === 'prompt' && test(trigger.regex, item.text);
  if (item.channel !== 'tool') return false;
  if (trigger.kind === 'bash') {
    if (item.tool !== 'Bash') return false;
    const command = bounded(trigger.onMention ? item.command : maskReadOnlyMentions(bounded(item.command)));
    if (trigger.commandHead) return executableHeads(command).some((part) => test(trigger.regex, `${part.head} ${part.args.join(' ')}`));
    return test(trigger.regex, command);
  }
  if (trigger.kind === 'tool') {
    const toolMatched = item.prechecked?.has(trigger) ? item.prechecked.get(trigger) : test(trigger.tool, item.tool);
    return failed || (toolMatched && (!trigger.input || (item.input !== null && (item.inputPrechecked?.has(trigger) ? item.inputPrechecked.get(trigger) : test(trigger.input, argumentEvidence(item.input))))));
  }
  if (trigger.kind === 'path') {
    const toolMatched = test(trigger.tool, item.tool);
    return failed || (toolMatched && test(trigger.regex, item.path));
  }
  return false;
}

import { bounded, argumentEvidence } from './evidence.js';
import { maskReadOnlyMentions, executableHeads } from './bash-mention.js';

export function triggerMatches(trigger, item) {
  if (trigger.kind === 'prompt') return item.channel === 'prompt' && trigger.regex.test(bounded(item.text));
  if (item.channel !== 'tool') return false;
  if (trigger.kind === 'bash') {
    if (item.tool !== 'Bash') return false;
    const command = bounded(trigger.onMention ? item.command : maskReadOnlyMentions(bounded(item.command)));
    if (trigger.commandHead) return executableHeads(command).some((part) => trigger.regex.test(`${part.head} ${part.args.join(' ')}`));
    return trigger.regex.test(command);
  }
  if (trigger.kind === 'tool') return trigger.tool.test(bounded(item.tool)) && (!trigger.input || (item.input !== null && trigger.input.test(argumentEvidence(item.input))));
  if (trigger.kind === 'path') return trigger.tool.test(bounded(item.tool)) && trigger.regex.test(bounded(item.path));
  return false;
}

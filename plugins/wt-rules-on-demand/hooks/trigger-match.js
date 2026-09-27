import { bounded, argumentEvidence } from './evidence.js';
import { maskReadOnlyMentions } from './bash-mention.js';

export function triggerMatches(trigger, item) {
  if (trigger.kind === 'prompt') return item.channel === 'prompt' && trigger.regex.test(bounded(item.text));
  if (item.channel !== 'tool') return false;
  if (trigger.kind === 'bash') return item.tool === 'Bash' && trigger.regex.test(bounded(trigger.onMention ? item.command : maskReadOnlyMentions(bounded(item.command))));
  if (trigger.kind === 'tool') return trigger.tool.test(bounded(item.tool)) && (!trigger.input || (item.input !== null && trigger.input.test(argumentEvidence(item.input))));
  if (trigger.kind === 'path') return trigger.tool.test(bounded(item.tool)) && trigger.regex.test(bounded(item.path));
  return false;
}

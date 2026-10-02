// Mechanism/policy separation: translate pure verdicts into warn-only measurement behavior.
import { appendEvent } from './journal.js';

export const WARNING = '[wt-secret-guard: WOULD BLOCK; executed in measurement mode. This command can read a credential file.]';

export async function applySecretReadGuard(host, event, next, verdict, surface) {
  await appendEvent(host, { surface, action: 'evaluated', ruleId: 'guarded-path-read', pathClass: verdict.pathClass, commandClass: verdict.commandClass, toolUseId: event.tool_use_id });
  for (let index = 0; index < verdict.mentions.length; index += 1) {
    await appendEvent(host, { surface, action: 'mention-allowed', ruleId: 'guarded-path-mention', pathClass: verdict.pathClass, commandClass: 'prose', toolUseId: event.tool_use_id, count: 1 });
  }
  const result = await next(event);
  if (!verdict.hit) return result;
  await appendEvent(host, { surface, action: 'would-block', ruleId: verdict.ruleId, pathClass: verdict.pathClass, commandClass: verdict.commandClass, toolUseId: event.tool_use_id, dedupeKey: event.tool_use_id ? `${event.tool_use_id}:would-block` : undefined });
  return withWarning(result);
}

// A refusal can come before anything ran (an unreadable reference), so its warning never claims execution.
const REFUSAL_WARNING = '[wt-secret-guard: WOULD BLOCK; this command can read a credential file.]';

// The host types a refusal as `{ deny }` alone, and builds what the model reads of an answered call from its
// `result` (core's own messages when `ref` is handed back), never from a hook's `text`. So the warning travels
// inside the refusal, or in `context`, which the model reads after the result.
function withWarning(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.deny !== undefined) return { deny: `${result.deny}\n${REFUSAL_WARNING}` };
  const context = Array.isArray(result.context) ? result.context : [];
  return { ...result, context: [...context, WARNING] };
}

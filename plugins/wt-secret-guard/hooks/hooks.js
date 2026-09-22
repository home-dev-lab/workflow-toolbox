// @ts-check
// Composition root and dependency inversion: wire pure policies to host capabilities in order.
import { configure, config } from './config.js';
import { detections } from './detector.js';
import { appendEvent, publish } from './journal.js';
import { scrubPromptStorage, scrubToolUseStorage } from './prompt-storage-host.js';
import { resolveReference as resolveRuntimeReference, rewriteReferences } from './reference-runtime.js';
import { scrub } from './scrub.js';
import { applySecretReadGuard } from './secret-read-guard.js';
import { verdictForBash, verdictForPath } from './secret-read-policy.js';
import { knownTokens, testState, tokenize } from './token-vault.js';
import { classifyOutbound } from './outbound-tools.js';
import { maskAssistantRender, maskTurnStep } from './assistant-stream.js';
import { REDACTION_NOTE } from './constants.js';

export { configure, testState, tokenize };

const journalHost = ($) => ({
  getSalt: () => $.store.get('salt'), setSalt: (value) => $.store.set('salt', value),
  setDetections: (value) => $.store.set('detections', value), getStats: () => $.store.get('stats'),
  setStats: (value) => $.store.set('stats', value), setLastPublishedAt: (value) => $.store.set('lastpublishedat', value),
  fsRead: (path) => $.fs.read(path), fsWrite: (path, text) => $.fs.write(path, text), fsStat: (path) => $.fs.stat(path), processRun: (argv, init) => $.process.run(argv, init), pluginRoot: () => $.plugin.root, configDir: () => $.env.get('CLAUDE_CONFIG_DIR'), home: () => $.env.get('HOME'),
  sessionId: () => $.session.id(), sessionCwd: () => $.session.cwd(), uiLog: (text) => $.ui.log(text),
});
const referenceHost = ($) => ({ processRun: (argv, init) => $.process.run(argv, init), fsRead: (path) => $.fs.read(path), envGet: (name) => $.env.get(name), uiLog: (text) => $.ui.log(text) });
const storageHost = ($) => ({
  configDir: () => $.env.get('CLAUDE_CONFIG_DIR'), home: () => $.env.get('HOME'), sessionId: () => $.session.id(), sessionCwd: () => $.session.cwd(),
  fsRead: (path) => $.fs.read(path), fsStat: (path) => $.fs.stat(path), processRun: (argv, init) => $.process.run(argv, init), pluginRoot: () => $.plugin.root,
  sleep: (milliseconds, options) => $.clock.sleep(milliseconds, options), uiLog: (text) => $.ui.log(text), isWindows: async () => await $.env.get('OS') === 'Windows_NT',
});
export const resolveReference = ($, ref, account) => resolveRuntimeReference(referenceHost($), ref, account);

export { REDACTION_NOTE };

const PROVIDER_KEY_PAGES = {
  'aws-access-key': 'https://console.aws.amazon.com/iam/home#/security_credentials',
  'brave-api-key': 'https://api.search.brave.com/app/keys',
  'github-classic': 'https://github.com/settings/tokens',
  'github-fine-grained': 'https://github.com/settings/personal-access-tokens',
  'openai-api-key': 'https://platform.openai.com/api-keys',
  'slack-token': 'https://api.slack.com/apps',
};

function inboundNotice(found) {
  const pages = [...new Set(found.map(({ kind }) => PROVIDER_KEY_PAGES[kind]).filter(Boolean))];
  const provider = pages.length ? ` Provider key page${pages.length === 1 ? '' : 's'}: ${pages.join(', ')}.` : '';
  return `[wt-secret-guard: A credential was detected in this message. Its value has been withheld from this session to stop us from spreading it. This cannot unsend anything; the only remedy is revocation.${provider}]`;
}

function withNotes(result, rewrites, entropy, tokenised = false) {
  if (!result || result.deny || (!rewrites && !entropy && !tokenised)) return result;
  const notes = [];
  if (tokenised) notes.push(REDACTION_NOTE);
  if (rewrites) notes.push(`[wt-secret-guard: rewrote ${rewrites} secret reference${rewrites === 1 ? '' : 's'}]`);
  if (entropy) notes.push(`[wt-secret-guard: ${entropy} candidate${entropy === 1 ? '' : 's'} not tokenised - entropy only]`);
  return { ...result, text: typeof result.text === 'string' ? `${result.text}\n${notes.join('\n')}` : notes.join('\n') };
}

async function scrubInbound($, event, next) {
  const found = detections(event.text);
  if (!found.length) return next(event);
  let text = event.text;
  for (const { kind, value, secret = value } of found) text = text.split(value).join(tokenize(kind, secret));
  const notice = inboundNotice(found);
  await publish(journalHost($)); await $.ui.log(notice);
  return next({ ...event, text: `${text}\n\n${notice}` });
}

async function scrubToolResult($, event, next) {
  const response = await next(event);
  const cleaned = scrub(response, '');
  await publish(journalHost($));
  if (cleaned.changed) await $.ui.log(`wt-secret-guard: scrubbed ${knownTokens().size} tokenised value(s)`);
  return withNotes(cleaned.value, 0, cleaned.entropy, cleaned.changed);
}

async function measuredRead($, event, next, surface) {
  const host = journalHost($);
  if (!config().secretFileReadWarnings) {
    await appendEvent(host, { surface, action: 'policy-disabled', ruleId: 'policy', commandClass: surface, toolUseId: event.tool_use_id });
    return scrubToolResult($, event, next);
  }
  const path = event.file_path ?? event.notebook_path ?? event.path;
  const verdict = verdictForPath(path, surface);
  return applySecretReadGuard(host, event, (forwarded) => scrubToolResult($, forwarded, next), verdict, surface);
}

async function refuseRawOutbound($, event) {
  const classified = await classifyOutbound({}, event);
  if (!classified.findings.length) return null;
  const replacements = classified.findings.map(({ kind, value, secret = value }) => ({ raw: value, token: tokenize(kind, secret) }));
  if (event.agentId) await $.ui.log('wt-secret-guard: denied subagent input; subagent transcript location is unmeasured, so persisted input could not be repaired.');
  else await scrubToolUseStorage(storageHost($), replacements, event.tool_use_id);
  await appendEvent(journalHost($), {
    surface: classified.surface, action: 'refused', kinds: classified.findings.map(({ kind }) => kind), count: classified.findings.length,
    toolUseId: event.tool_use_id, dedupeKey: event.tool_use_id ? `outbound:${event.tool_use_id}` : undefined,
  });
  await publish(journalHost($));
  const guidance = classified.surface === 'bash'
    ? ' Use a supported secret reference instead.'
    : ' Remove the raw value from the outbound content.';
  return { deny: `wt-secret-guard refused raw secret-bearing ${classified.surface} input.${guidance}` };
}

async function guardedOutbound($, event, next) {
  const refusal = await refuseRawOutbound($, event);
  if (refusal) return refusal;
  return scrubToolResult($, event, next);
}

async function warnHookAttachment($, event, next) {
  const cleaned = scrub(event, '');
  if (event.origin?.kind === 'hook' && event.origin?.event === 'SessionStart' && cleaned.changed) {
    await appendEvent(journalHost($), { surface: 'attachment', action: 'warned', dedupeKey: `attachment:${event.index ?? 'session-start'}` });
    await $.ui.log('wt-secret-guard: detected and scrubbed a SessionStart hook attachment; model-side propagation of attachment rewrites is unproven. Remove the value from the source hook or consumer store.');
  }
  return next(cleaned.value);
}

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  configure(options);
  on('session.receive', scrubInbound);
  on('prompt.attachment', warnHookAttachment);
  on('tool.call', { tool: 'Bash' }, async ($, event, next) => {
    const audit = journalHost($);
    const references = referenceHost($);
    const originalCommand = typeof event.command === 'string' ? event.command : '';
    const refusal = await refuseRawOutbound($, event);
    if (refusal) return refusal;
    const execute = async (originalEvent) => {
      const rewrite = await rewriteReferences(references, originalCommand);
      if (rewrite.invalidReference) {
        return { deny: `wt-secret-guard refused Bash execution: the command carries ${rewrite.reason || 'a reference it does not support'}. Supported forms are op://vault/item/field, op read with one literal op:// reference and documented flags, secret:env:NAME, secret:file:/absolute/path[#line], and a redaction token this session issued - as a bare shell word or as the whole contents of a quoted word. A reference inside a heredoc body is left as text.` };
      }
      for (const reference of rewrite.references) {
        const resolved = await resolveRuntimeReference(references, reference.ref, reference.account);
        if (!resolved.token) return { deny: 'wt-secret-guard refused Bash execution because a 1Password reference could not be prefetched.' };
      }
      const response = await next(rewrite.command === originalCommand ? originalEvent : { ...originalEvent, command: rewrite.command });
      const cleaned = scrub(response, rewrite.command);
      await publish(audit);
      if (cleaned.changed) await $.ui.log(`wt-secret-guard: scrubbed ${knownTokens().size} tokenised value(s)`);
      return withNotes(cleaned.value, rewrite.count, cleaned.entropy, cleaned.changed);
    };
    if (!config().secretFileReadWarnings) {
      await appendEvent(audit, { surface: 'bash', action: 'policy-disabled', ruleId: 'policy', commandClass: 'bash', toolUseId: event.tool_use_id });
      return execute(event);
    }
    return applySecretReadGuard(audit, event, execute, verdictForBash(originalCommand), 'bash');
  });
  on('tool.call', { tool: 'Read' }, ($, event, next) => measuredRead($, event, next, 'read'));
  on('tool.call', { tool: 'NotebookRead' }, ($, event, next) => measuredRead($, event, next, 'notebook-read'));
  on('tool.call', { tool: 'Write' }, guardedOutbound);
  on('tool.call', { tool: 'Edit' }, guardedOutbound);
  on('tool.call', { tool: 'NotebookEdit' }, guardedOutbound);
  on('tool.call', { tool: 'WebFetch' }, guardedOutbound);
  on('tool.call', { tool: 'WebSearch' }, guardedOutbound);
  on('tool.call', { tool: 'Agent' }, guardedOutbound);
  on('tool.call', { tool: 'Task' }, guardedOutbound);
  on('tool.call', { tool: 'Grep' }, scrubToolResult);
  on('tool.call', { tool: 'Glob' }, scrubToolResult);
  on('tool.call', { tool: /^mcp__/ }, guardedOutbound);
  on('turn.step', async function* ($, event, next) {
    const correlation = event.turnId ?? event.index;
    const stream = maskTurnStep(event, next, REDACTION_NOTE, () => appendEvent(journalHost($), { surface: 'assistant', action: 'masked', dedupeKey: correlation ? `assistant:${correlation}` : undefined }));
    for (;;) {
      const step = await stream.next();
      if (step.done) return step.value;
      yield step.value;
    }
  });
  on('ui.render', { component: 'AssistantMessage' }, ($, event, next) => maskAssistantRender(event, next));
  on('prompt.submit', async ($, event, next) => {
    const cleaned = scrub(event, '');
    const replacements = typeof event.text === 'string'
      ? [...knownTokens()].filter(([, entry]) => event.text.includes(entry.value)).map(([token, entry]) => ({ raw: entry.value, token }))
      : [];
    await publish(journalHost($));
    if (cleaned.changed) await $.ui.log(`wt-secret-guard: scrubbed ${knownTokens().size} tokenised value(s)`);
    const noted = withNotes(cleaned.value, 0, cleaned.entropy);
    const result = await next(cleaned.changed ? { ...noted, context: [...(noted.context ?? []), REDACTION_NOTE] } : noted);
    if (cleaned.changed && replacements.length && event.origin?.kind) {
      await scrubPromptStorage(storageHost($), replacements, next.signal);
    }
    return result;
  });
};

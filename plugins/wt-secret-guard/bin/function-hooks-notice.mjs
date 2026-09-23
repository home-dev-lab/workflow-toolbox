export function startupNotice(env) {
  return env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === '1'
    ? ''
    : '[wt-secret-guard: Function Hooks are disabled. Secret guarding is inactive; restart Claude Code with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1.]';
}

export function startupPayload(env) {
  const notice = startupNotice(env);
  return notice ? { systemMessage: notice, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: notice } } : null;
}

if (process.argv[1]?.endsWith('function-hooks-notice.mjs')) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const payload = startupPayload(process.env);
  if (payload) process.stdout.write(`${JSON.stringify(payload)}\n`);
}

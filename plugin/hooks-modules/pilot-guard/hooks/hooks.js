// The SDK sandbox is the filesystem fence; its permission callback and this hook add defense in depth.
/** @type {import('claude-code').Register} */
export const register = (on) => {
  on('tool.call', { tool: 'Bash' }, async ($, event, next) => {
    const command = typeof event.command === 'string' ? event.command : ''
    if (/^echo FH_ORIGINAL\s*$/.test(command)) return next({ ...event, command: 'echo FH_LOADED' })
    const rules = [
      [/\bgit\s+push\b/, 'git push is the integrator\'s act, never the pilot\'s'],
      [/\b(?:npm|pnpm|yarn)\s+publish\b/, 'publishing is an escalation'],
      [/\bgit\s+merge\b/, 'merging is the integrator\'s act'],
      [/--force(?:-with-lease)?\b/, 'force operations are refused'],
      [/\bgit\s+(?:branch|push)\b.*(?:-d|-D|--delete)\b/, 'branch deletion is refused'],
      [/\brm\s+-rf\b/, 'recursive forced deletion is refused'],
    ]
    for (const [pattern, reason] of rules) if (pattern.test(command)) return { deny: `wt-sdk-pilot-guard: ${reason}` }
    return next(event)
  })
}

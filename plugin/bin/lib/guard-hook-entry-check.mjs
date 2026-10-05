// guard-hook-entry-check.mjs — find PreToolUse / PermissionRequest hook entries the host cannot use.
//
// Measured on Claude Code 2.1.289 (disposable headless sessions, one per case, each beside a valid sibling hook):
// - an entry the host cannot load drops the WHOLE source it sits in: every hook and permission rule of that settings
//   file, or the whole plugin. Measured shapes: a command hook without `command`, an unknown `type`, an http hook
//   without `url`, a `timeout` that is a string or 0, an `async` that is not a boolean.
// - a matcher on the regular-expression path that does not compile skips that matcher group, and an `if` that is not
//   a permission rule skips that one hook; both are reported in the debug log only, and `claude plugin validate
//   --strict` passes them.
// Only these two events are checked: the host strips a malformed entry of any other event on its own (read off the
// 2.1.289 binary). This is not the host's schema: an entry it passes can still be refused, which is why the host
// validator keeps running wherever the binary exists. Pure: no file system, no process, no platform dependency.

export const GUARD_HOOK_EVENTS = ['PreToolUse', 'PermissionRequest']

// The handler types hooks.md documents. An unknown type was measured to drop the whole source.
const HOOK_TYPES = ['command', 'http', 'mcp_tool', 'prompt', 'agent']

// hooks.md "Matcher patterns": `*`, empty or omitted match all; only letters, digits, `_`, `-`, spaces, `,` and `|`
// are compared as exact strings; anything else is a JavaScript regular expression.
const EXACT_MATCHER = /^[A-Za-z0-9_\- ,|]*$/

// A permission rule: `Tool` or `Tool(pattern)`, the pattern running to the final closing parenthesis.
const PERMISSION_RULE = /^[^\s()]+(\(.*\))?$/s

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const describe = (value) => (typeof value === 'number' ? String(value) : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

function matcherProblem(matcher) {
  if (matcher === undefined) return null
  if (typeof matcher !== 'string') return `matcher must be a string; received ${describe(matcher)}`
  if (matcher === '*' || EXACT_MATCHER.test(matcher)) return null
  try {
    new RegExp(matcher)
    return null
  } catch (error) {
    return `matcher ${JSON.stringify(matcher)} is a regular expression that does not compile (${error.message}); the host skips this group`
  }
}

function typeProblem(hook) {
  if (!HOOK_TYPES.includes(hook.type)) return `unknown hook \`type\` ${JSON.stringify(hook.type)}; the documented types are ${HOOK_TYPES.join(', ')}`
  if (hook.type === 'command' && typeof hook.command !== 'string') return 'a command hook needs a string `command`'
  if (hook.type === 'http' && typeof hook.url !== 'string') return 'an http hook needs a string `url`'
  return null
}

function fieldProblem(hook) {
  if (hook.timeout !== undefined && !(typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) && hook.timeout > 0)) {
    return `\`timeout\` must be a positive number of seconds; received ${describe(hook.timeout)}`
  }
  if (hook.async !== undefined && typeof hook.async !== 'boolean') return `\`async\` must be a boolean; received ${describe(hook.async)}`
  if (hook.if === undefined) return null
  if (typeof hook.if !== 'string') return `\`if\` must be a string; received ${describe(hook.if)}`
  if (!PERMISSION_RULE.test(hook.if)) return `\`if\` ${JSON.stringify(hook.if)} is not a permission rule (\`Tool\` or \`Tool(pattern)\`); the host skips this hook`
  return null
}

function hookProblem(hook) {
  if (!isObject(hook)) return `a hook entry must be an object; received ${describe(hook)}`
  return typeProblem(hook) ?? fieldProblem(hook)
}

function groupProblems(group, at) {
  if (!isObject(group)) return [{ path: at, problem: `a matcher group must be an object; received ${describe(group)}` }]
  const problems = []
  const matcher = matcherProblem(group.matcher)
  if (matcher) problems.push({ path: `${at}.matcher`, problem: matcher })
  if (!Array.isArray(group.hooks)) {
    problems.push({ path: `${at}.hooks`, problem: `must be an array of hook entries; received ${describe(group.hooks)}` })
    return problems
  }
  group.hooks.forEach((hook, h) => {
    const problem = hookProblem(hook)
    if (problem) problems.push({ path: `${at}.hooks.${h}`, problem })
  })
  return problems
}

/**
 * Return `{ path, problem }` for every PreToolUse / PermissionRequest entry of a settings object or plugin manifest
 * that the host cannot use. An empty array means none was found by these checks.
 */
export function guardHookEntryProblems(config) {
  const hooks = isObject(config) ? config.hooks : undefined
  if (!isObject(hooks)) return []
  return GUARD_HOOK_EVENTS.flatMap((event) => {
    const groups = hooks[event]
    if (groups === undefined) return []
    if (!Array.isArray(groups)) return [{ path: `hooks.${event}`, problem: `must be an array of matcher groups; received ${describe(groups)}` }]
    return groups.flatMap((group, g) => groupProblems(group, `hooks.${event}.${g}`))
  })
}

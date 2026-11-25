import { execFileSync as nativeExecFileSync, spawnSync as nativeSpawnSync } from 'node:child_process'
export * from 'node:child_process'
export { default } from 'node:child_process'

// Synchronous children block the test runner's own timeout. Always kill them at the OS boundary.
export const HOOK_SPAWN_TIMEOUT_MS = 30_000

function boundedOptions(options = {}) {
  const timeout = options.timeout ?? HOOK_SPAWN_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new RangeError('hook spawn timeout must be a positive integer in milliseconds')
  return { ...options, timeout, killSignal: 'SIGKILL' }
}

function childName(command, args) {
  return args.find(arg => /(?:^|[/\\])wt-[\w-]+-hook\.(?:mjs|js|cjs)$/.test(arg))
    ?? args.find(arg => /-hook\.(?:mjs|js|cjs)$/.test(arg))
    ?? args.find(arg => /(?:^|[/\\])wt-[\w-]+\.(?:mjs|js|cjs)$/.test(arg))
    ?? args.join(' ').match(/wt-[\w-]+-hook\.(?:mjs|js|cjs)/)?.[0]
    ?? args.find(arg => /(?:hook|guard)[^/\\]*\.(?:mjs|js|cjs)$/.test(arg))
    ?? args.find(arg => /\.(?:mjs|js|cjs)$/.test(arg))
    ?? command
}

function checkTimeout(error, command, args, timeout, result = error) {
  if (error?.code !== 'ETIMEDOUT') return
  throw Object.assign(new Error(`stalled hook child: ${childName(command, args)} exceeded ${timeout} ms`, { cause: error }), { result })
}

function runBounded(run, command, argsOrOptions, options) {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : []
  const bounded = boundedOptions(Array.isArray(argsOrOptions) ? options : argsOrOptions ?? options)
  let result
  try {
    result = run(command, args, bounded)
  } catch (error) {
    checkTimeout(error, command, args, bounded.timeout)
    throw error
  }
  checkTimeout(result?.error, command, args, bounded.timeout, result)
  return result
}

export function spawnSync(command, argsOrOptions, options) {
  return runBounded(nativeSpawnSync, command, argsOrOptions, options)
}

export function execFileSync(command, argsOrOptions, options) {
  return runBounded(nativeExecFileSync, command, argsOrOptions, options)
}

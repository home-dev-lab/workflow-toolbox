const SELF_TEST_ENV = 'WT_FAIL_OPEN_TRACE_SELF_TEST'

function renderError(error) {
  return error instanceof Error ? error.message : String(error)
}

// The seam exists so the lock can prove, PER HOOK, that a broken entry path leaves a trace
// rather than looking healthy-quiet. It deliberately accepts ONE exact hook name and nothing
// else: a wildcard would turn a single environment value into "silently no-op every shipped
// guard at once", which is a large effect for a control that is invisible in operator docs.
// Naming one hook keeps the test coverage and removes the blanket affordance.
function maybeTriggerSelfTest(hookName) {
  if (process.env[SELF_TEST_ENV] === hookName) {
    throw new Error(`forced fail-open self-test for ${hookName}`)
  }
}

export function writeFailOpenTrace(hookName, error) {
  try {
    process.stderr.write(`${hookName}: FAILED OPEN - ${renderError(error)}\n`)
  } catch {
    // Writing the trace must not itself become the reason the hook fails closed.
  }
}

export function runFailOpenHook(hookName, fn, onError) {
  try {
    maybeTriggerSelfTest(hookName)
    return fn()
  } catch (error) {
    writeFailOpenTrace(hookName, error)
    return onError ? onError(error) : undefined
  }
}

export async function runFailOpenHookAsync(hookName, fn, onError) {
  try {
    maybeTriggerSelfTest(hookName)
    await fn()
  } catch (error) {
    writeFailOpenTrace(hookName, error)
    if (onError) await onError(error)
  }
}

import { appServerSource, publicAstraTurn } from './second-opinion-app-server.mjs'

// Runs inside the existing sandbox/owned child, not in the calling host process.
async function structuredAstraTurn() {
  const { createWriteStream, writeSync } = await import('node:fs')
  const [, effort, prompt, nonce] = process.argv.slice(1)
  try {
    // Recorded before any verdict so the caller's broker cleanup knows the tree is already gone.
    const answer = await publicAstraTurn(effort, prompt, (terminated) => {
      if (terminated) writeSync(3, `${JSON.stringify({ type: 'wt-app-server-tree-terminated-v1', nonce })}\n`)
    })
    // One framed record, emitted only after a complete, explicitly clean verdict.
    // The private pipe is independent of companion stdout, including late logs.
    await new Promise((resolve, reject) => {
      const channel = createWriteStream(null, { fd: 3 })
      channel.on('error', reject)
      channel.end(`${JSON.stringify({ type: 'wt-astra-verified-v1', answer, nonce })}\n`, resolve)
    })
  } catch (error) {
    if (typeof error.answer === 'string') process.stdout.write(error.answer)
    process.stderr.write(`REFUSED: structured Astra completion unavailable: ${error.message}\n`)
    process.exitCode = 1
  }
}

// Inline the small bridge so the sandbox only needs the dynamically resolved
// companion root; the caller's plugin checkout need not be readable in the child.
const structuredAstraSource = `${appServerSource}\nawait (${structuredAstraTurn.toString()})()`

// A zero child status alone is never a completion verdict: imports and provider
// code can exit early, and a pending promise need not keep Node's loop alive.
function treeTerminationPrefix(nonce) {
  return `${JSON.stringify({ type: 'wt-app-server-tree-terminated-v1', nonce })}\n`
}

// The bridge's own tree kill, bound to this call's nonce; never inferred from a missing process.
export function appServerTreeTerminated(completionRecord, nonce) {
  return typeof nonce === 'string' && nonce !== '' && completionRecord.startsWith(treeTerminationPrefix(nonce))
}

export function verifiedAstraResult(result) {
  if (result.status !== 0) return result
  try {
    const channel = appServerTreeTerminated(result.completionRecord, result.completionNonce)
      ? result.completionRecord.slice(treeTerminationPrefix(result.completionNonce).length) : result.completionRecord
    // Parse the rest of the channel: additional records or trailing junk fail closed.
    const record = JSON.parse(channel)
    if (record?.type !== 'wt-astra-verified-v1' || typeof record.answer !== 'string'
      || typeof result.completionNonce !== 'string' || !result.completionNonce
      || record.nonce !== result.completionNonce || Object.keys(record).length !== 3) throw new Error('invalid completion record')
    return { ...result, stdout: record.answer }
  } catch {
    return { ...result, status: 1, stdout: '',
      stderr: `${result.stderr}REFUSED: structured Astra completion unavailable\n` }
  }
}

// Adapt the launch at the sandbox boundary, keeping the owned process lifecycle
// unchanged. Planning and wrapping must see the very same bridge arguments.
export function resolveAstraSandbox(resolveSandbox, request) {
  const [companion, , , , , , effort, prompt] = request.args
  const args = ['--input-type=module', '--eval', structuredAstraSource, companion, effort, prompt, request.completionNonce]
  const plan = resolveSandbox({ ...request, args })
  const wrap = plan.wrap
  plan.wrap = function (bin) { return wrap.call(this, bin, args) }
  return plan
}

import { appServerSource, publicAstraTurn } from './second-opinion-app-server.mjs'

// Runs inside the existing sandbox/owned child, not in the calling host process.
async function structuredAstraTurn() {
  const { createWriteStream } = await import('node:fs')
  const [, effort, prompt, nonce] = process.argv.slice(1)
  try {
    const answer = await publicAstraTurn(effort, prompt)
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
export function verifiedAstraResult(result) {
  if (result.status !== 0) return result
  try {
    // Parse the entire channel: additional records or trailing junk fail closed.
    const record = JSON.parse(result.completionRecord)
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

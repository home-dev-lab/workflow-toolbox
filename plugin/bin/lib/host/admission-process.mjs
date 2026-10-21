// Keep the supervisor responsive when policy code loops synchronously in its worker.
// Losing the caller's IPC channel must also stop the worker, including on caller SIGKILL.
import { formatAdmissionError, workerAdmission } from './admission.mjs'
import { isInvokedDirectly } from './entry-guard.mjs'

async function run({ options, env, timeout, moduleVariable, silent }) {
  let message
  try { message = { refusal: await workerAdmission(options, env, timeout, moduleVariable, silent) } }
  catch (error) { message = { error: formatAdmissionError(error) } }
  if (process.connected) process.send(message, () => process.disconnect())
}

if (isInvokedDirectly(import.meta.url)) {
  process.once('disconnect', () => process.exit(0))
  process.once('message', run)
}

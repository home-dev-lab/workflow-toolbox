import { readFileSync, renameSync, rmSync } from 'node:fs'

export function readDecision(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error instanceof SyntaxError) return { invalid: true }
    throw error
  }
}

export function consumedRequestIds(ctx) {
  const state = ctx.current()
  return new Set([...(state.consumedExtensionIds ?? []), ...(state.consumedExtensionId ? [state.consumedExtensionId] : [])])
}

export function requestWasConsumed(ctx, decision) {
  return typeof decision.requestId === 'string' && consumedRequestIds(ctx).has(decision.requestId)
}

// Only the worker writes .claimed. Claim before reading: a concurrent atomic
// publication always stays in the public slot, never under the path we remove.
// An existing claim is a recoverable crash window and must be processed first.
export function claimDecision(file) {
  const claimed = `${file}.claimed`
  let decision = readDecision(claimed)
  if (!decision) {
    try { renameSync(file, claimed) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    decision = readDecision(claimed)
  }
  return { decision, remove: () => rmSync(claimed, { force: true }) }
}

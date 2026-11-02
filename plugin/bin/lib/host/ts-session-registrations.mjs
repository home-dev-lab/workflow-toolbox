import { tsFrame } from './ts-lsp-wire.mjs'

// Dynamic registrations live in the client, so shutting down the server alone
// cannot release them. Retain only registrations the client actually accepted.
export function acceptTsRegistration(state, response) {
  const request = state.serverRequests.get(response.id)
  state.serverRequests.delete(response.id)
  if (!request || response.error) return
  if (request.method === 'client/registerCapability') {
    for (const { id, method } of request.params.registrations) state.registrations.set(id, { id, method })
  }
  if (request.method === 'client/unregisterCapability') {
    for (const { id } of request.params.unregisterations) state.registrations.delete(id)
  }
}

export function releaseTsRegistrations(state) {
  if (!state.registrations.size) return
  const id = `wt-tsls-unregister-${state.nonce}-${state.generation}`
  state.unregisterIds.add(id)
  state.streams.output.write(tsFrame({ jsonrpc: '2.0', id, method: 'client/unregisterCapability',
    params: { unregisterations: [...state.registrations.values()] } }))
  state.registrations.clear()
}

export function consumeTsUnregisterReply(state, message) {
  if (message.method || !state.unregisterIds.has(message.id)) return false
  if (message.error) state.streams.stderr.write('wt-tsls: client refused idle capability cleanup; client registration state is unknown\n')
  state.unregisterIds.delete(message.id)
  return true
}

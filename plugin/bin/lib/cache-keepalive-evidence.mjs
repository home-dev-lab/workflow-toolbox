// Retained TTL evidence is scoped to a model, with bounded session-local retention.
const MAX_MODELS = 32

export function evidenceOwnerIds(state) {
  if (state.cacheEvidenceByModel) return []
  return Object.values(state.cacheEvidence ?? {}).map((entry) => entry.callId).filter((id) => typeof id === 'string')
}

function mergeEvidence(target, incoming) {
  for (const [key, entry] of Object.entries(incoming)) {
    if (!target[key] || entry.atMs >= target[key].atMs) target[key] = entry
  }
  return target
}

function migrateLegacy(state, discovery) {
  const models = new Map()
  for (const [key, entry] of Object.entries(state.cacheEvidence ?? {})) {
    const model = discovery.owners[entry.callId] ?? state.cacheEvidenceModel ?? state.lastModel
    if (typeof model !== 'string' || !model) continue
    models.set(model, { ...models.get(model), [key]: entry })
  }
  return models
}

export function rememberEvidence(state, discovery) {
  let models = new Map(Object.entries(state.cacheEvidenceByModel ?? {}))
  if (discovery.reset) models = new Map()
  else if (!state.cacheEvidenceByModel) models = migrateLegacy(state, discovery)
  const entries = Object.entries(discovery.evidenceByModel)
  if (discovery.mode === 'discovery') entries.reverse()
  for (const [model, incoming] of entries) {
    const evidence = mergeEvidence(models.get(model) ?? {}, incoming)
    models.delete(model)
    models.set(model, evidence)
  }
  while (models.size > MAX_MODELS) models.delete(models.keys().next().value)
  state.cacheEvidenceByModel = Object.fromEntries(models)
  state.transcriptCursor = discovery.cursor
}

export function selectEvidence(state) {
  state.cacheEvidenceModel = state.lastModel ?? null
  state.cacheEvidence = state.cacheEvidenceByModel?.[state.lastModel] ?? {}
}

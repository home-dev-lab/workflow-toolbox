/** Positive correlation is local even when other transcript names could not be read. */
export function transcriptLocality(record, transcriptIds) {
  if (!transcriptIds || record.agentIdSource === 'none') return 'unknown'
  const { agentId, agentIdSource } = record
  if (agentIdSource === 'brief') return transcriptIds.brief.has(agentId) ? 'local' : 'foreign'
  const matched = transcriptIds.name.has(agentId) || (agentIdSource !== 'name' && transcriptIds.brief.has(agentId))
  if (matched) return 'local'
  return transcriptIds.nameComplete === false ? 'unknown' : 'foreign'
}

export function isProvenForeign(record, transcriptIds, scanComplete) {
  return scanComplete === true && transcriptLocality(record, transcriptIds) === 'foreign'
}

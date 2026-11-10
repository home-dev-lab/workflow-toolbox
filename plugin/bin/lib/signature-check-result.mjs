function checkOffender(item) {
  if (!item || typeof item.sha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(item.sha)) throw Error('malformed signature checker offender')
  if (!['N', 'B', 'E', 'X', 'Y', 'R'].includes(item.status) || typeof item.subject !== 'string') throw Error('malformed signature checker offender')
}

function checkedDocument(text) {
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed.text !== 'string') throw Error('malformed signature checker result')
  if (!Array.isArray(parsed.offenders) || !parsed.offenders.length) throw Error('malformed signature checker result')
  for (const item of parsed.offenders) checkOffender(item)
  return parsed
}

function checkedCleanDocument(text) {
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed.text !== 'string') throw Error('malformed signature checker result')
  if (!Array.isArray(parsed.offenders) || parsed.offenders.length !== 0) throw Error('malformed clean signature checker result')
  return parsed
}

/** An exit-1 document is authority to attempt verification, never an arbitrary CLI string. */
export function signatureCheckResult(result) {
  if (!result || result.error || result.signal) throw Error('signature checker failed')
  if (result.status === 0) return checkedCleanDocument(result.stdout)
  if (result.status !== 1) throw Error('signature checker failed')
  return checkedDocument(result.stdout)
}

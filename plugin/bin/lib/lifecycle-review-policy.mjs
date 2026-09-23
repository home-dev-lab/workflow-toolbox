const MAX_REPORT_FINDINGS = 50
const MAX_FINDING_CHARACTERS = 2000
const FORWARD_SLASH = String.fromCharCode(47)
const BACKWARD_SLASH = String.fromCharCode(92)
const normalizedFinding = (finding) => finding.toLowerCase().replace(/\s+/g, ' ').trim()
const withoutLineSuffix = (value) => value.replace(/(\.[A-Za-z0-9]+):\d+(?::\d+)?(?:-\d+)?(?=`|[\])]|\s|$)/g, (match, extension, offset, source) => {
  const before = source.slice(0, offset)
  const tokenStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('('), before.lastIndexOf('['), before.lastIndexOf('`')) + 1
  const token = before.slice(tokenStart)
  return /[A-Za-z0-9_.-]$/.test(token) && !token.includes('://') ? extension : match
})
const normalizedClaim = (finding) => normalizedFinding(withoutLineSuffix(finding))
const normalizedLocationFile = (location) => {
  let normalized = String(location ?? '').trim().replace(/^`|`$/g, '').replaceAll(BACKWARD_SLASH, FORWARD_SLASH)
  if (normalized.startsWith(`.${FORWARD_SLASH}`)) normalized = normalized.slice(2)
  return normalized.replace(/:\d+(?::\d+)?(?:-\d+)?$/, '')
}
const normalizedAnchor = (anchor) => {
  const dod = /^dod(?:\s+(?:criterion|item))?\s*#?(\d+)$/i.exec(anchor)
  if (dod) return `dod ${dod[1]}`
  const task = /^(?:plan\s+task\s+)?([a-z]+\d+)$/i.exec(anchor)
  return task ? `plan task ${task[1].toLowerCase()}` : normalizedFinding(anchor)
}

function severityAtStart(phase, finding, legacy) {
  if (phase === 'critic') {
    const match = /^\[(blocking|non-blocking)\](?:\s*)/i.exec(finding)
    if (match) return { severity: match[1].toLowerCase(), end: match[0].length }
    return legacy ? { severity: 'blocking', end: 0 } : null
  }
  const bracketed = /^\[(critical|high|medium|low)\](?:\s*)/i.exec(finding)
  if (bracketed) return { severity: bracketed[1].toLowerCase(), end: bracketed[0].length }
  if (!legacy) return null
  const legacyMatch = /^(?:\*\*)?\[(critical|high|medium|low)\](?:\*\*)?|^\((critical|high|medium|low)\)|^(critical|high|medium|low):/i.exec(finding)
  return { severity: (legacyMatch?.slice(1).find(Boolean) ?? 'high').toLowerCase(), end: legacyMatch?.[0].length ?? 0 }
}

function routedBecause(phase, severity, severityBlocks, anchorMatch, suppliedAnchor, validAnchor, nullAnchor) {
  if (!severityBlocks) {
    if (phase === 'critic') return 'critic marked non-blocking'
    return `${severity.toUpperCase()} severity never blocks`
  }
  if (!anchorMatch) return 'legacy report has no anchor field'
  if (!suppliedAnchor) return 'explicit anchor is empty'
  let suffix = ''
  if (!validAnchor && !nullAnchor) suffix = ' does not resolve'
  return `explicit anchor ${suppliedAnchor}${suffix}`
}

function findingDetail(phase, finding, { legacy = false, validAnchors = [], priorFindingCount = 0 } = {}) {
  const severityToken = severityAtStart(phase, finding, legacy)
  if (!severityToken) return { problem: 'has no recognized severity in its severity field' }
  // eslint-disable-next-line sonarjs/super-linear-regex
  const anchorMatch = /\[anchor:\s*([^\]]*)\]/i.exec(finding)
  const suppliedAnchor = anchorMatch?.[1]?.trim() ?? ''
  const acceptedAnchors = new Set(validAnchors.map(normalizedAnchor))
  const nullAnchor = /^(?:none|n\/a|na|null|-)$/.test(suppliedAnchor.toLowerCase())
  const validAnchor = suppliedAnchor && !nullAnchor && acceptedAnchors.has(normalizedAnchor(suppliedAnchor))
  const anchor = validAnchor ? suppliedAnchor : null
  const severityBlocks = phase === 'critic' ? severityToken.severity === 'blocking' : ['critical', 'high', 'medium'].includes(severityToken.severity)
  const missingRequiredAnchor = !legacy && severityBlocks && !anchorMatch
  const routeReason = routedBecause(phase, severityToken.severity, severityBlocks, anchorMatch, suppliedAnchor, validAnchor, nullAnchor)
  // Finding length is bounded before these location scans.
  // eslint-disable-next-line sonarjs/super-linear-regex
  let location = /\[location:\s*([^\]]+)\]/i.exec(finding)?.[1]?.trim() ?? null
  // eslint-disable-next-line sonarjs/super-linear-regex
  if (!location) location = /(?:`)?((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+:\d+(?:-\d+)?)(?:`)?/.exec(finding)?.[1] ?? null
  const metadataEnd = [...finding.matchAll(/\[(?:anchor|location):[^\]]*\]/gi)].reduce((end, match) => Math.max(end, (match.index ?? 0) + match[0].length), severityToken.end)
  const text = finding.slice(metadataEnd).trim() || finding
  const extendsPrior = Number(/\bextends prior finding\s+(\d+)\b/i.exec(finding)?.[1]) || null
  if (extendsPrior !== null && extendsPrior > priorFindingCount) {
    if (!severityBlocks) return { dropped: true, raw: finding, text, severity: severityToken.severity, warning: `extends nonexistent prior finding ${extendsPrior}` }
    return { problem: `extends nonexistent prior finding ${extendsPrior}` }
  }
  return {
    raw: finding, text, severity: severityToken.severity, anchor, location, extendsPrior,
    blocks: severityBlocks && anchor !== null,
    routeReason,
    missingRequiredAnchor,
  }
}

export function verdictFromReport(phase, content, options = {}) {
  const expected = phase === 'critic' ? ['approved', 'changes-requested'] : ['clear', 'changes-requested']
  const match = new RegExp(`^VERDICT:\\s*(${expected.join('|')})\\s*$`, 'mi').exec(content)
  if (!match) return null
  const findingsStart = content.slice(match.index + match[0].length).match(/^FINDINGS:\s*$/im)
  if (!findingsStart) return null
  const afterFindings = content.slice(match.index + match[0].length + findingsStart.index + findingsStart[0].length)
  const lines = afterFindings.split(/\r?\n/)
  const sectionEnd = lines.findIndex((line, index) => index > 0 && (/^#/.test(line) || (line === '' && /^## /.test(lines[index + 1] ?? ''))))
  const rawFindings = (sectionEnd < 0 ? lines : lines.slice(0, sectionEnd))
    .filter((line) => /^[-*+]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*+]\s+/, '').trim())
    .filter((finding) => !/^(?:none\.?|no (?:issues?|findings?)(?: found)?\.?)$/i.test(finding))
  if (rawFindings.length > MAX_REPORT_FINDINGS) return { problem: `finding count exceeds ${MAX_REPORT_FINDINGS}` }
  if (rawFindings.some((finding) => [...finding].length > MAX_FINDING_CHARACTERS)) return { problem: `finding exceeds ${MAX_FINDING_CHARACTERS}-character limit` }
  if (match[1] === 'changes-requested' && rawFindings.length === 0) return null
  const parsedFindings = rawFindings.map((finding) => findingDetail(phase, finding, options))
  const malformed = parsedFindings.findIndex((finding) => finding.problem)
  if (malformed >= 0) return { problem: `finding ${malformed + 1} ${parsedFindings[malformed].problem}` }
  const droppedFindings = parsedFindings.flatMap((finding, index) => finding.dropped ? [{ ...finding, index: index + 1 }] : [])
  const findingDetails = parsedFindings.filter((finding) => !finding.dropped)
  const missingAnchors = findingDetails.flatMap((finding, index) => finding.missingRequiredAnchor ? [index + 1] : [])
  if (missingAnchors.length > 0) return { problem: `finding${missingAnchors.length === 1 ? '' : 's'} ${missingAnchors.join(', ')} ${missingAnchors.length === 1 ? 'has' : 'have'} no anchor field` }
  const blockingCount = findingDetails.filter((finding) => finding.blocks).length
  if (match[1] === 'clear' && blockingCount > 0) return { problem: `clear verdict carries ${blockingCount} blocking finding${blockingCount === 1 ? '' : 's'}` }
  return {
    outcome: match[1],
    findings: findingDetails.map((finding) => finding.text),
    severities: phase === 'critic' ? findingDetails.map((finding) => finding.severity) : [],
    findingDetails,
    droppedFindings,
    warnings: droppedFindings.map((finding) => `dropped ${finding.severity.toUpperCase()} finding ${finding.index}: ${finding.warning}`),
  }
}

export function adaptiveRoundDecision(rounds, fixedRounds, maxRounds, plateauUsed) {
  const latest = rounds.at(-1)
  if (rounds.length < fixedRounds) return { continue: true, plateauUsed }
  if (rounds.length >= maxRounds) return { continue: false, plateauUsed }
  const earlier = new Set(rounds.slice(0, -1).flatMap((round) => round.findings.map(normalizedFinding)))
  if (latest.blockingFindings.some((finding) => earlier.has(normalizedFinding(finding)))) return { continue: false, plateauUsed }
  if (latest.findingDetails?.some((finding) => finding.blocks && finding.extendsPrior !== null)) return { continue: false, plateauUsed }
  const previousCount = rounds.at(-2).blockingFindings.length
  const latestCount = latest.blockingFindings.length
  if (latestCount < previousCount) return { continue: true, plateauUsed }
  if (latestCount === previousCount && !plateauUsed) return { continue: true, plateauUsed: true }
  return { continue: false, plateauUsed }
}

export function reviewConvergenceDecision(rounds) {
  const blockingRounds = rounds.filter((round) => round.blockingFindings.length > 0)
  const latest = blockingRounds.at(-1)
  if (!latest) return { continue: true, signal: null }
  const extended = latest.findingDetails?.find((finding) => finding.blocks && finding.extendsPrior !== null)
  if (extended) return { continue: false, signal: `finding extends prior finding ${extended.extendsPrior}` }

  const earlier = new Map()
  for (const round of blockingRounds.slice(0, -1)) {
    for (const finding of round.findingDetails ?? []) {
      if (finding.blocks) earlier.set(`${normalizedAnchor(finding.anchor)}\0${normalizedLocationFile(finding.location)}\0${normalizedClaim(finding.text)}`, finding)
    }
  }
  for (const finding of latest.findingDetails ?? []) {
    if (!finding.blocks) continue
    const prior = earlier.get(`${normalizedAnchor(finding.anchor)}\0${normalizedLocationFile(finding.location)}\0${normalizedClaim(finding.text)}`)
    if (prior) return { continue: false, signal: `same finding returned: ${prior.anchor} — ${finding.text.replace(/\s+/g, ' ').trim()}` }
  }

  const counts = blockingRounds.map((round) => round.blockingFindings.length)
  let bestRound = 0
  for (let index = 1; index < counts.length; index += 1) if (counts[index] < counts[bestRound]) bestRound = index
  if (counts.length - bestRound > 2) {
    const failures = counts.slice(-2)
    return { continue: false, signal: `blocking count failed to set a new minimum for two consecutive rounds: best ${counts[bestRound]}; ${failures.join(' -> ')}` }
  }
  return { continue: true, signal: null }
}

export function hasPerSectionAttackAccount(content, sections = ['ADR', 'Tasks', 'Gates']) {
  // The report size is bounded before this section scan.
  // eslint-disable-next-line sonarjs/super-linear-regex
  const body = /(?:^|\n)## No-finding attack account\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/i.exec(content)?.[1] ?? ''
  if (!body.trim()) return false
  return sections.every((section) => {
    const prefix = `- ${section}:`.toLowerCase()
    const line = body.split(/\r?\n/).find((candidate) => candidate.trim().toLowerCase().startsWith(prefix) && candidate.trim().length > prefix.length)
    return Boolean(line && !/\bno (?:issues?|findings?)(?: found)?\.?\s*$/i.test(line))
  })
}

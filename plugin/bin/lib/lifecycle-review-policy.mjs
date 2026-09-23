const MAX_REPORT_FINDINGS = 50
const MAX_FINDING_CHARACTERS = 2000
const DIFF_FILE_PREFIX = `+++ b${String.fromCharCode(47)}`
const DIFF_NO_NEWLINE_PREFIX = String.fromCharCode(92)

const normalizedFinding = (finding) => finding.toLowerCase().replace(/\s+/g, ' ').trim()
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

function locationIsAddedByPatch(location, patch) {
  if (!location || !patch) return false
  const locationMatch = /^(.*):(\d+)(?:-(\d+))?$/.exec(location)
  if (!locationMatch) return false
  const target = locationMatch[1]
  const first = Number(locationMatch[2])
  const last = Number(locationMatch[3] ?? locationMatch[2])
  const added = new Set()
  let file = null
  let line = 0
  for (const patchLine of patch.split(/\r?\n/)) {
    if (patchLine.startsWith(DIFF_FILE_PREFIX)) { file = patchLine.slice(DIFF_FILE_PREFIX.length); continue }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(patchLine)
    if (hunk) { line = Number(hunk[1]); continue }
    if (!file || line === 0 || patchLine.startsWith(DIFF_NO_NEWLINE_PREFIX)) continue
    if (patchLine.startsWith('+')) {
      if (file === target) added.add(line)
      line += 1
    }
    else if (!patchLine.startsWith('-')) line += 1
  }
  for (let candidate = first; candidate <= last; candidate += 1) if (!added.has(candidate)) return false
  return true
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

function findingDetail(phase, finding, { legacy = false, validAnchors = [], previousFixPatch = null } = {}) {
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
  const fixesOwnCode = anchor?.toLowerCase().startsWith('plan task ') && locationIsAddedByPatch(location, previousFixPatch)
  const extendsPrior = Number(/\bextends prior finding\s+(\d+)\b/i.exec(finding)?.[1]) || null
  const metadataEnd = [...finding.matchAll(/\[(?:anchor|location):[^\]]*\]/gi)].reduce((end, match) => Math.max(end, (match.index ?? 0) + match[0].length), severityToken.end)
  const text = finding.slice(metadataEnd).trim() || finding
  return {
    raw: finding, text, severity: severityToken.severity, anchor, location, extendsPrior,
    blocks: severityBlocks && anchor !== null && !fixesOwnCode,
    routeReason: fixesOwnCode ? 'located only in previous fix code and anchored to no card criterion' : routeReason,
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
  const findingDetails = rawFindings.map((finding) => findingDetail(phase, finding, options))
  const malformed = findingDetails.findIndex((finding) => finding.problem)
  if (malformed >= 0) return { problem: `finding ${malformed + 1} ${findingDetails[malformed].problem}` }
  const missingAnchors = findingDetails.flatMap((finding, index) => finding.missingRequiredAnchor ? [index + 1] : [])
  if (missingAnchors.length > 0) return { problem: `finding${missingAnchors.length === 1 ? '' : 's'} ${missingAnchors.join(', ')} ${missingAnchors.length === 1 ? 'has' : 'have'} no anchor field` }
  const blockingCount = findingDetails.filter((finding) => finding.blocks).length
  if (match[1] === 'clear' && blockingCount > 0) return { problem: `clear verdict carries ${blockingCount} blocking finding${blockingCount === 1 ? '' : 's'}` }
  return {
    outcome: match[1],
    findings: findingDetails.map((finding) => finding.text),
    severities: phase === 'critic' ? findingDetails.map((finding) => finding.severity) : [],
    findingDetails,
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
  const latest = rounds.at(-1)
  if (!latest) return { continue: true, signal: null }
  const extended = latest.findingDetails?.find((finding) => finding.blocks && finding.extendsPrior !== null)
  if (extended) return { continue: false, signal: `finding extends prior finding ${extended.extendsPrior}` }

  const earlier = new Map()
  for (const round of rounds.slice(0, -1)) {
    for (const finding of round.findingDetails ?? []) {
      if (finding.blocks) earlier.set(`${normalizedAnchor(finding.anchor)}\0${normalizedFinding(finding.text)}`, finding)
    }
  }
  for (const finding of latest.findingDetails ?? []) {
    if (!finding.blocks) continue
    const prior = earlier.get(`${normalizedAnchor(finding.anchor)}\0${normalizedFinding(finding.text)}`)
    if (prior) return { continue: false, signal: `same finding returned: ${prior.anchor} — ${finding.text.replace(/\s+/g, ' ').trim()}` }
  }

  if (rounds.length >= 3) {
    const counts = rounds.slice(-3).map((round) => round.blockingFindings.length)
    if (counts[1] >= counts[0] && counts[2] >= counts[1]) {
      return { continue: false, signal: `blocking count did not drop for two consecutive rounds: ${counts.join(' -> ')}` }
    }
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

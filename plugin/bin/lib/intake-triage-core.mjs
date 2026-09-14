const ROUTES = ['inline', 'lane-direct', 'pilot']

function text(value) {
  return typeof value === 'string' ? value : ''
}

function labelsOf(card) {
  return Array.isArray(card.labels)
    ? card.labels.map((label) => typeof label === 'string' ? label : text(label?.name))
    : []
}

function effortOf(card) {
  return /\beffort\s*:\s*([SML])\b/i.exec(labelsOf(card).join('\n'))?.[1]?.toUpperCase() ?? null
}

function forcedRoute(description) {
  const match = /^Route:\s*(inline|lane-direct|pilot)\b/im.exec(description)
  return match?.[1]?.toLowerCase() ?? null
}

function routeValue(description) {
  return /^Route:\s*([^\s]+)/im.exec(description)?.[1]?.toLowerCase() ?? null
}

function hasFiles(description) {
  return /`[^`/\n]+(?:\/[^`\n]+)+`|(?<![\w.-])(?:plugin|toolkit|docs|\.claude)\/[\w./-]+/i.test(description)
}

function signalsOf(card) {
  const description = text(card?.description)
  return {
    effort: effortOf(card),
    filesNamed: hasFiles(description),
    definitionOfDone: /(?:\b(?:definition of done|DoD)\s*:|^#{1,6}\s+definition of done\s*$)/im.test(description),
    openQuestion: /\b(?:open question|question|tbd|to be decided|decision needed)\s*:/i.test(description) || /\?/.test(description),
    existingRoute: forcedRoute(description),
  }
}

export function inspectCard(card) {
  const source = card && typeof card === 'object' ? card : {}
  const signals = signalsOf(source)
  return {
    id: text(source.id),
    title: text(source.title ?? source.name),
    description: text(source.description),
    signals,
  }
}

export function renderRoute(route, reason) {
  return `Route: ${route} — ${reason}`
}

export function routeUp(route) {
  const position = ROUTES.indexOf(route)
  return ROUTES[Math.min(position < 0 ? ROUTES.length - 1 : position + 1, ROUTES.length - 1)]
}

function resultFor(card, route, reason, forced = false) {
  return {
    ...card,
    route,
    reason,
    forced,
    refused: false,
    routeLine: renderRoute(route, reason),
  }
}

function refusedFor(card, reason) {
  return { ...card, forced: false, refused: true, reason }
}

function reasonFor(signals) {
  if (signals.definitionOfDone && !signals.openQuestion) return 'DoD complete, no open question'
  if (signals.openQuestion) return 'Open question remains'
  return 'Definition of done incomplete'
}

function responseMap(responses) {
  if (!Array.isArray(responses)) throw new TypeError('The batch classifier must return an array.')
  return new Map(responses.map((response) => [text(response?.id), response]))
}

/**
 * Resolve deterministic triage before a single injected batch classifier is called.
 */
export function prepareTriage(cards) {
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array.')

  const inspected = cards.map(inspectCard)
  const results = new Array(inspected.length)
  const eligible = []

  for (const [index, card] of inspected.entries()) {
    if (!card.signals.effort) {
      results[index] = refusedFor(card, 'Missing effort label; refused from triage until labelled.')
    } else if (card.signals.existingRoute) {
      results[index] = resultFor(card, card.signals.existingRoute, 'Forced by existing Route line', true)
    } else if (routeValue(card.description)) {
      results[index] = refusedFor(card, `Invalid Route value: ${routeValue(card.description)}; refused from triage.`)
    } else {
      results[index] = { ...card, forced: false, refused: false }
      eligible.push({ index, card })
    }
  }

  return { results, eligible }
}

/**
 * Classify all eligible cards in one injected batch. Existing Route lines and missing effort
 * labels are resolved before the classifier is called, so neither can be silently re-routed.
 */
export async function triageCards(cards, classifyBatch) {
  if (typeof classifyBatch !== 'function') throw new TypeError('classifyBatch must be a function.')
  const { results, eligible } = prepareTriage(cards)

  if (eligible.length === 0) return results

  const byId = responseMap(await classifyBatch(eligible.map(({ card }) => card)))
  for (const { index, card } of eligible) {
    const response = byId.get(card.id)
    const proposed = ROUTES.includes(response?.route) ? response.route : 'pilot'
    const route = response?.doubt ? routeUp(proposed) : proposed
    results[index] = resultFor(card, route, reasonFor(card.signals))
  }
  return results
}

// actionability-planka-producer-core.mjs — pure decision logic behind
// wt-actionable-snapshot-producer-hook.mjs. Kept separate (same discipline as
// actionability-core.mjs/decide()) so tests can drive the computation without a
// spawned hook process, a real Planka board, or a real dependency-parser binary.
//
// This file answers two questions, deliberately kept apart:
//   1. extractCards()   — given a PostToolUse call against a Planka MCP tool, is
//                          there enough information here to say ANYTHING about
//                          the whole board, or must the hook stay silent?
//   2. computeSnapshot() — given a card set this project agrees is complete, and
//                          a dependency resolver, what does the actionability
//                          snapshot actually say — and what did it count?
//
// The card that created this file (1835531703) is explicit that a producer
// which writes a plausible number without naming what it counted reproduces the
// very defect it exists to fix. computeSnapshot() therefore always returns a
// countedScope string describing the scan, even when the caller does not ask.

const STARTABLE_LISTS = new Set(['backlog', 'next'])
const DONE_LISTS = new Set(['done'])

function normalizeListName(name) {
  return String(name || '').trim().toLowerCase()
}

// Pulls the JSON text payload out of whatever shape a PostToolUse hook's
// tool_response carries for an MCP tool call. Observed shapes, both handled:
// a raw content-block array (`[{type:'text', text:'...'}]`, what a direct MCP
// tools/call response looks like) and an object wrapping the same array under
// `.content`. A bare string is accepted too, defensively.
export function extractResponseText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse
  const blocks = Array.isArray(toolResponse)
    ? toolResponse
    : (toolResponse && typeof toolResponse === 'object' && Array.isArray(toolResponse.content))
      ? toolResponse.content
      : null
  if (!blocks) return null
  const first = blocks.find((b) => b && typeof b.text === 'string')
  return first ? first.text : null
}

// Normalizes ONE card object (however it arrived — a get_board list member or
// a find_cards result) into the {id, description, listName, position} shape
// computeSnapshot() needs. Returns null for anything unusable rather than
// throwing — one malformed card must not abort the whole scan.
function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id : (typeof raw.id === 'number' ? String(raw.id) : null)
  if (!id) return null
  const description = typeof raw.description === 'string' ? raw.description : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  const listName = typeof raw.listName === 'string' ? raw.listName : (typeof raw.list === 'string' ? raw.list : '')
  const position = typeof raw.position === 'number' ? raw.position : Number.MAX_SAFE_INTEGER
  return { id, name, description, listName, position }
}

/**
 * @param {{ toolName: string, toolInput: unknown, toolResponse: unknown }} input
 * @returns {{ ok: true, cards: Array<{id:string,name:string,description:string,listName:string,position:number}> } | { ok: false, reason: string }}
 */
export function extractCards({ toolName, toolInput, toolResponse }) {
  const text = extractResponseText(toolResponse)
  if (!text) return { ok: false, reason: 'no readable tool_response text' }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'tool_response text is not valid JSON' }
  }

  if (toolName === 'mcp__planka__get_board') {
    // get_board's shape: { ...board fields, lists: [{ id, name, cards: [...] }] }
    const lists = Array.isArray(parsed?.lists) ? parsed.lists : null
    if (!lists) return { ok: false, reason: 'get_board response has no lists[] array' }
    const cards = []
    for (const list of lists) {
      const listName = typeof list?.name === 'string' ? list.name : ''
      // A list with no `cards` array at all is a TRUNCATED/malformed response, not a
      // legitimately empty list — a real empty list still carries `cards: []`. Treating
      // the former as the latter is exactly the "plausible-but-wrong number" this producer
      // exists to refuse (review finding: a shape like {name:'Next'} with no cards key
      // would otherwise silently read as "Next has zero cards").
      if (!Array.isArray(list?.cards)) return { ok: false, reason: `list ${JSON.stringify(listName)} has no cards[] array — treating as truncated, not empty` }
      for (const raw of list.cards) {
        const card = normalizeCard(raw)
        // A card this producer cannot read (no usable id) makes the WHOLE extraction
        // unusable — filtering it out would silently drop a possible Done dependency or a
        // possible Backlog/Next candidate and compute a snapshot as if the set were
        // complete when it is not. Fail the extraction instead of guessing.
        if (!card) return { ok: false, reason: `unreadable card in list ${JSON.stringify(listName)} — missing/invalid id` }
        cards.push({ ...card, listName: card.listName || listName })
      }
    }
    return { ok: true, cards }
  }

  if (toolName === 'mcp__planka__find_cards') {
    // find_cards only covers the WHOLE board when called with no filter at
    // all — a filtered call (list/label/text) legitimately returns a subset,
    // and computing a board-wide count from a subset is exactly the
    // plausible-but-wrong number this producer must never write. Skip,
    // silently, rather than guess.
    //
    // ⚠ Scoped to the CURRENT find_cards schema (boardId, list, label, text — no pagination
    // as of this writing). If the tool ever grows another filtering/paging argument, this
    // check does not know about it and would need to be extended — named here rather than
    // silently assumed complete.
    const ti = toolInput && typeof toolInput === 'object' ? toolInput : {}
    const filtered = Boolean(ti.list || ti.label || ti.text)
    if (filtered) return { ok: false, reason: 'find_cards called with a filter — result is a subset, not the whole board' }
    if (!Array.isArray(parsed)) return { ok: false, reason: 'find_cards response is not an array' }
    const cards = []
    for (const raw of parsed) {
      const card = normalizeCard(raw)
      if (!card) return { ok: false, reason: 'unreadable card in find_cards response — missing/invalid id' }
      cards.push(card)
    }
    return { ok: true, cards }
  }

  return { ok: false, reason: `unsupported tool_name ${toolName}` }
}

/**
 * @param {{
 *   cards: Array<{id:string,name:string,description:string,listName:string,position:number}>,
 *   resolveDeps: (description: string) => { ids: string[], unparseable: string[] },
 *   boardId?: string,
 *   now: number,
 * }} input
 * @returns {{
 *   at: number, actionable: number, next: string, workPossible: true, reason: '',
 *   blockedUntil: null, inFlightUntil: null, countedScope: string,
 * }}
 */
export function computeSnapshot({ cards, resolveDeps, boardId, now }) {
  const doneIds = new Set(
    cards.filter((c) => DONE_LISTS.has(normalizeListName(c.listName))).map((c) => c.id),
  )
  const startable = cards
    .filter((c) => STARTABLE_LISTS.has(normalizeListName(c.listName)))
    .sort((a, b) => a.position - b.position)

  let actionableCount = 0
  let unresolvedCount = 0
  let firstActionable = null
  for (const card of startable) {
    const { ids, unparseable } = resolveDeps(card.description)
    const resolved = unparseable.length === 0 && ids.every((id) => doneIds.has(id))
    if (resolved) {
      actionableCount += 1
      if (!firstActionable) firstActionable = card
    } else {
      unresolvedCount += 1
    }
  }

  const next = firstActionable ? `#${firstActionable.id} ${firstActionable.name}`.trim() : ''
  const scanned = startable.length
  const countedScope =
    `Backlog+Next cards${boardId ? ` on board ${boardId}` : ''}: ${scanned} scanned, ` +
    `${actionableCount} with every Depends-on resolved to a card in Done, ` +
    `${unresolvedCount} unresolved/unparseable/blocked; Done pool: ${doneIds.size} cards.`

  return {
    at: now,
    actionable: actionableCount,
    next,
    workPossible: true,
    reason: '',
    blockedUntil: null,
    inFlightUntil: null,
    countedScope,
  }
}

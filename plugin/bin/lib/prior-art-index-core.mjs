// prior-art-index-core.mjs — pure logic for the card-title index that
// wt-prior-art-launch-guard-hook.mjs reads before a launch command runs.
// Kept separate from the hook (and from the actionable-snapshot producer
// that calls it) so a test can drive it without a spawned process, a real
// Planka board, or a filesystem.
//
// SCOPE, DELIBERATELY NARROW: {id, name, listName} per card. No description,
// no comments — the guard's whole job is "does a title look related", never
// a summary of card content, so nothing else needs to leave the board.
//
// CAP. 500 cards, each field bounded to 300 chars — chosen so the serialized
// file stays well under 300 KB even on an unusually large board (500 * ~250
// bytes/card of JSON overhead ≈ 125 KB), a size a guard hook can read
// synchronously on every matching Bash call without a noticeable pause.
// Cards past the cap are DROPPED, never silently merged or summarized — the
// index records `truncated: true` and the true `scanned` count so a reader
// can tell "no match in the index" from "no match in a partial index".

export const MAX_CARDS = 500
export const MAX_FIELD_CHARS = 300

function boundedText(value) {
  return String(value ?? '').slice(0, MAX_FIELD_CHARS)
}

/**
 * @param {Array<{id:string,name:string,listName:string}>} cards - already
 *   extracted board cards (e.g. from extractCards() in
 *   actionability-planka-producer-core.mjs). Assumed non-archived: both
 *   `get_board` and an unfiltered `find_cards` omit archived cards in the
 *   Planka MCP server's own response shape — this module does not re-filter
 *   on an `isArchived`/`archived` field because neither call surfaces one.
 * @param {number} now - Date.now() at scan time.
 * @returns {{ at: number, scanned: number, cap: number, truncated: boolean,
 *             cards: Array<{id:string,name:string,listName:string}> }}
 */
export function buildCardIndex(cards, now) {
  const list = Array.isArray(cards) ? cards : []
  const scanned = list.length
  const truncated = scanned > MAX_CARDS
  const kept = list.slice(0, MAX_CARDS).map((c) => ({
    id: boundedText(c?.id),
    name: boundedText(c?.name),
    listName: boundedText(c?.listName),
  }))
  return { at: now, scanned, cap: MAX_CARDS, truncated, cards: kept }
}

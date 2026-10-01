// The one rule for reading a Planka MCP find_cards answer as the WHOLE board. Shared by the
// actionability producer and toolkit/scripts/planka-mcp-client.ts, so neither can turn a page into
// a board-wide answer the other would refuse.
//
// The current schema is paginated: `{ total, offset, limit, cards }`. A page is the whole board only
// when `total` and `offset` are integers ≥ 0, `offset` is 0 and `cards` holds exactly `total` cards.
// A bare array (the legacy schema) is accepted only when the call did not ask for pagination.
export function readWholeBoardPage(parsed, { paginationRequested = false } = {}) {
  if (Array.isArray(parsed)) {
    if (paginationRequested) {
      return { ok: false, reason: 'find_cards paginated response has no total — result is a subset, not the whole board' }
    }
    return { ok: true, cards: parsed }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cards)) {
    return { ok: false, reason: 'find_cards response has no cards[] array' }
  }
  const { total, offset } = parsed
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(offset) || offset < 0) {
    return { ok: false, reason: 'find_cards response has invalid pagination metadata' }
  }
  if (offset !== 0 || parsed.cards.length !== total) {
    return { ok: false, reason: `find_cards page contains ${parsed.cards.length} of ${total} cards at offset ${offset} — result is a subset, not the whole board` }
  }
  return { ok: true, cards: parsed.cards }
}

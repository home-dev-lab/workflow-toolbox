export type WholeBoardPage =
  | { ok: true, cards: unknown[] }
  | { ok: false, reason: string }

export function readWholeBoardPage(parsed: unknown, options?: { paginationRequested?: boolean }): WholeBoardPage

/**
 * Returns the first `keep` entries, unchanged and in order; if `lenses` already
 * has `keep` or fewer entries, returns it unchanged.
 *
 * First-N is the right reduction here because the review lens lists are ordered
 * most-specific-first for each diff category. In the current workflow data, each
 * four-lens category puts its broadest catch-all lens last, so reducing to 3
 * preserves the earlier category-specific lenses while dropping only that tail.
 *
 * Throws on a negative `keep`. Without that guard `slice(0, keep)` reinterprets a
 * negative as "drop that many from the END" and returns a perfectly plausible list —
 * `reducedLenses(fourLenses, -1)` yielded the first three, indistinguishable from a
 * correct reduction and wrong for any other input length. `keep === 0` is NOT an error:
 * keeping nothing is a meaningful budget.
 */
export function reducedLenses(lenses: readonly string[], keep = 3): readonly string[] {
  if (keep < 0) {
    throw new Error(
      `reducedLenses: keep must not be negative (received ${keep}) — a negative slice bound silently drops from the end instead of keeping a prefix`,
    )
  }
  return lenses.length <= keep ? lenses : lenses.slice(0, keep)
}

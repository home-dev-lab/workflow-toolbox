// stale-date-guard-core.mjs — classify absolute dates found in markdown prose
// as PROVENANCE (a dated fact — "measured on 31/07" — never expires) or
// DEADLINE (an operational cutoff — "usable again on 29/07" — expires the
// moment "today" passes it), and flag only a DEADLINE that has actually
// passed. See card #1832980806121817984: a rule carried a dead account-reset
// deadline for four days because nothing distinguished it from the ~45
// harmless provenance dates in the same file — the two must never be
// treated alike, or the guard is either blind (folds deadlines into
// provenance) or self-defeating (flags nearly everything and gets disabled).
//
// This is a HEURISTIC text classifier, not a parser with a formal grammar —
// French and English rule prose does not carry a machine-readable tag for
// "this date is a deadline". The heuristic is a WINDOW of text around each
// date match, tested against two keyword lists (deadline markers outrank
// provenance markers when both are present in the window, because a phrase
// like "corrigé le 28/07, échéance dépassée" IS reporting a stale deadline).
// A date matching NEITHER list is UNKNOWN — reported separately, never
// silently dropped and never silently treated as a deadline. This is the
// safety valve the card explicitly asked for ("un vérificateur qui rapporte
// des CANDIDATS pour tri humain est un livrable légitime ; un vérificateur
// qui mal-étiquette en silence ne l'est pas").

/** Matches DD/MM or DD/MM/YYYY (French rule convention) and ISO YYYY-MM-DD. */
const DATE_PATTERN =
  /\b([0-3]?[0-9])\/([0-1]?[0-9])(?:\/([0-9]{2,4}))?\b|\b([0-9]{4})-([0-1][0-9])-([0-3][0-9])\b/g;

// Deadline markers: an operational cutoff — "until", "expires", "the next
// usable X is", "before/after date". Checked FIRST — a window that reads as
// both ("corrigé le 28/07, service arrêté le 28/07") is a deadline report,
// not a provenance note, because the operative content is the cutoff.
const DEADLINE_MARKERS = [
  /jusqu'?(au|à)/i,
  /échéance (est )?(passée|dépassée|expirée)/i,
  /expir/i,
  /résili/i,
  /deadline/i,
  /avant le\b/i,
  /prochain compte utilisable/i,
  /service (arrêté|shut ?down|retired|ends?)/i,
  /suspendu(e)? jusqu/i,
  /valid until/i,
  /due date/i,
  /d'ici (au|le)\b/i,
  /à partir du\b/i,
];
// NOTE: the bare word "échéance" is deliberately NOT a marker on its own — it
// is also used generically ("annoncer l'ÉCHÉANCE de la carte") to talk ABOUT
// the concept of a deadline without stating one for the surrounding date.
// Caught by real-world validation against this project's own rule files
// (card #1832980806121817984): "l'ÉCHÉANCE de la carte (Frederic, 27/07)"
// false-flagged the citation date as a deadline. Requiring the compound
// phrase ("échéance … passée/dépassée/expirée") keeps the true positive
// (GLM: "l'échéance est passée") while dropping that false one.

// Provenance markers: a dated fact — what was observed/measured/fixed on
// that day. These never expire and must never be flagged, however old.
const PROVENANCE_MARKERS = [
  /mesur[ée]/i,
  /measured/i,
  /constat[ée]/i,
  /observ[ée]/i,
  /observed/i,
  /v[ée]cu/i,
  /corrig[ée]/i,
  /corrected/i,
  /fixed/i,
  /test[ée]/i,
  /tested/i,
  /rapport[ée]/i,
  /reported/i,
  /vérifi[ée]/i,
  /verified/i,
  /écrit(e)? le\b/i,
  /dat[ée] du\b/i,
  /set\s+\d/i, // "(set 28/07, approved …)"
  /approved/i,
  // A parenthetical citation shape — "(Frederic, 31/07)", "(28/07, testé)" —
  // is itself a strong provenance signal even with no keyword: it is how
  // this codebase attributes a dated observation. Matched by the caller via
  // isParentheticalCitation(), not this list (needs match position).
];

function isParentheticalCitation(line, matchIndex, matchLength) {
  // Look for an unmatched '(' before the date and the nearest ')' after it,
  // within a short span — "(Frederic, 31/07)" / "(28/07, testé)" / "(31/07)".
  const before = line.slice(Math.max(0, matchIndex - 40), matchIndex);
  const after = line.slice(matchIndex + matchLength, matchIndex + matchLength + 40);
  const openIdx = before.lastIndexOf('(');
  if (openIdx === -1) return false;
  const closeIdx = after.indexOf(')');
  if (closeIdx === -1) return false;
  // Reject if a closing paren appears in `before` after the open (nested/closed
  // already) or an opening paren appears in `after` before the close (a new
  // group started) — keeps this to the simple, common one-group case.
  if (before.slice(openIdx + 1).includes(')')) return false;
  if (after.slice(0, closeIdx).includes('(')) return false;
  return true;
}

function windowAround(line, index, length, radius = 55) {
  const start = Math.max(0, index - radius);
  const end = Math.min(line.length, index + length + radius);
  return line.slice(start, end);
}

/**
 * Parse a regex match's captured groups into a normalized {year, month, day}
 * or null if the match cannot be resolved to a real calendar date (invalid
 * day/month, or a DD/MM with no year — those are dated to the CURRENT
 * reference year for staleness purposes, since rule prose in this project
 * never writes a cross-year DD/MM without an explicit year).
 */
function resolveDate(match, referenceYear) {
  const [, d1, m1, y1, isoY, isoM, isoD] = match;
  let year, month, day;
  if (isoY !== undefined) {
    year = Number(isoY);
    month = Number(isoM);
    day = Number(isoD);
  } else {
    day = Number(d1);
    month = Number(m1);
    year = y1 !== undefined ? (y1.length === 2 ? 2000 + Number(y1) : Number(y1)) : referenceYear;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject shapes that are almost certainly not dates, e.g. "5h" fractions or
  // version-looking "0/9" caught by a loose regex upstream — a day of 0 or a
  // month of 0 already fails the bounds check above.
  return { year, month, day };
}

function toComparableNumber({ year, month, day }) {
  return year * 10000 + month * 100 + day;
}

/**
 * Scan `text` (one markdown file's content) and return an array of findings:
 *   { line, column, raw, date: {year,month,day}, kind, stale, window }
 * kind is 'deadline' | 'provenance' | 'unknown'. `stale` is only meaningful
 * for kind === 'deadline' (true when date < today).
 *
 * `today` — {year, month, day} — defaults to the real current date; pass an
 * explicit value in tests so results are deterministic and don't rot.
 */
export function scanText(text, { today = defaultToday(), referenceYear = today.year } = {}) {
  const todayNum = toComparableNumber(today);
  const lines = text.split('\n');
  const findings = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    DATE_PATTERN.lastIndex = 0;
    let m;
    while ((m = DATE_PATTERN.exec(line)) !== null) {
      const date = resolveDate(m, referenceYear);
      if (!date) continue;
      const window = windowAround(line, m.index, m[0].length);
      const isDeadline = DEADLINE_MARKERS.some((re) => re.test(window));
      const isProvenance =
        !isDeadline &&
        (PROVENANCE_MARKERS.some((re) => re.test(window)) ||
          isParentheticalCitation(line, m.index, m[0].length));
      const kind = isDeadline ? 'deadline' : isProvenance ? 'provenance' : 'unknown';
      const stale = kind === 'deadline' && toComparableNumber(date) < todayNum;
      findings.push({
        line: lineIndex + 1,
        column: m.index + 1,
        raw: m[0],
        date,
        kind,
        stale,
        window: window.trim(),
      });
    }
  }
  return findings;
}

function defaultToday() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export { toComparableNumber };

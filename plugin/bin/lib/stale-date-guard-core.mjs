// stale-date-guard-core.mjs — classify absolute dates found in markdown prose
// as PROVENANCE (a dated fact — "measured on 31/07" — never expires) or
// DEADLINE (an operational cutoff — "usable again on 29/07" — expires the
// moment "today" passes it), and flag only a DEADLINE that has actually
// passed AND is not already narrated as past. See card #1832980806121817984:
// a rule carried a dead account-reset deadline for four days because nothing
// distinguished it from the ~45 harmless provenance dates in the same file —
// the two must never be treated alike, or the guard is either blind (folds
// deadlines into provenance) or self-defeating (flags nearly everything and
// gets disabled).
//
// This is a HEURISTIC text classifier, not a parser with a formal grammar —
// French and English rule prose does not carry a machine-readable tag for
// "this date is a deadline". The heuristic is a WINDOW of text around each
// date match, tested against THREE keyword tiers, checked in this priority
// order (real bug found running this guard against the actual corpus, card
// #1832980806121817984, arbiter review):
//
//   1. ACKNOWLEDGED-PAST markers ("l'échéance est passée", "GLM est MORT",
//      "service arrêté") — the surrounding text is ITSELF reporting that the
//      cutoff already happened. Classified as provenance (a dated fact of
//      when something ended), never as an actionable stale deadline. Without
//      this tier, the guard's own confident output flags the ONE sentence in
//      the corpus that already fixed this exact class of bug as if it still
//      needed fixing — the worst possible false positive for this tool.
//   2. DEADLINE markers ("jusqu'au", "avant le", "prochain compte
//      utilisable") — an open, still-pending cutoff. Compared to "today".
//   3. PROVENANCE markers ("mesuré le", "corrigé le", a parenthetical
//      citation "(Frederic, 31/07)") — a dated fact, never expires.
//
// A date matching none of the three is UNKNOWN — reported separately, never
// silently dropped and never silently treated as a deadline. This is the
// safety valve the card explicitly asked for ("un vérificateur qui rapporte
// des CANDIDATS pour tri humain est un livrable légitime ; un vérificateur
// qui mal-étiquette en silence ne l'est pas").

/** Matches DD/MM or DD/MM/YYYY (French rule convention) and ISO YYYY-MM-DD. */
const DATE_PATTERN =
  /\b([0-3]?[0-9])\/([0-1]?[0-9])(?:\/([0-9]{2,4}))?\b|\b([0-9]{4})-([0-1][0-9])-([0-3][0-9])\b/g;

// --- Tier 1: acknowledged-past — the text ITSELF says the cutoff is over ---
//
// Checked FIRST and wins over a deadline marker in the same window: a phrase
// like "l'échéance est passée" or "service arrêté" IS a deadline word, but
// paired with an explicit past-tense acknowledgment it is reporting a
// RESOLVED fact, not asking the reader to act. Real corpus case (card
// #1832980806121817984): "GLM est MORT — service arrêté le 2026-07-28,
// l'échéance est passée" is the rule's OWN fix for the class this card
// exists to catch; flagging it as an open stale deadline would have the
// guard ask a reader to re-fix something already fixed.
const ACKNOWLEDGED_PAST_MARKERS = [
  /est\s+(pass[ée]e?|d[ée]pass[ée]e?|expir[ée]e?)\b/i,
  /d[ée]j[àa]\s+(pass[ée]e?|p[ée]rim[ée]e?|expir[ée]e?)/i,
  /\bis\s+(past|over|no\s+longer\s+valid)\b/i,
  /\bno\s+longer\b/i,
  /\bMORT\b/,
  /service\s+arrêté\b/i,
  /\brésili[ée]\b/i,
  /\bterminé[ée]?\b/i,
  /\bdiscontinued\b/i,
  /\bdeprecated\b/i,
];

// --- Tier 2: deadline — an open, still-pending operational cutoff ---------
const DEADLINE_MARKERS = [
  /jusqu'?(au|à)/i,
  /expir/i,
  /deadline/i,
  /avant le\b/i,
  /prochain compte utilisable/i,
  /service\s+(shut ?down|ends?)\b/i,
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
// false-flagged the citation date as a deadline.
// NOTE: "résilié" / "service arrêté" moved to tier 1 (acknowledged-past) —
// both are past-participle constructions in this project's French/English
// usage and were never observed describing a still-pending cutoff.

// --- Tier 3: provenance — a dated fact, never expires ---------------------
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
  // Additional narrative-report verbs found scanning the REAL corpus (card
  // #1832980806121817984, second arbiter round) — "on 24/07" or "le 31/07"
  // alone tells you nothing about tense, but the verb next to it does.
  /viol[ée]e?s?/i, // "violées le 24/07"
  /clarifi[ée]/i, // "clarifiée le 27/07"
  /\btrouv[ée]/i, // "a trouvé … le 25/07"
  /abandonn[ée]/i, // "un pilote avait abandonné … le 26/07"
  /\bcaught\b/i, // "Caught by a pilot that checked, 2026-07-31"
  /\bchecked\b/i,
  /\bappeared\b/i, // "on 31/07, a PKCS#8 private key appeared"
  /\bcame\s+from\b/i,
  /\blived\s+through\b/i, // "Lived through 3 times on the same evening of 31/07"
  // A parenthetical citation shape — "(Frederic, 31/07)", "(28/07, testé)" —
  // is itself a strong provenance signal even with no keyword: it is how
  // this codebase attributes a dated observation. Matched by the caller via
  // isParentheticalCitation(), not this list (needs match position).
];

function isParentheticalCitation(text, matchIndex, matchLength) {
  // Look for an unmatched '(' before the date and the nearest ')' after it,
  // within a short span — "(Frederic, 31/07)" / "(28/07, testé)" / "(31/07)".
  // Radius widened to 90 (card #1832980806121817984, 2nd round): a real
  // multi-clause parenthetical aside ("(Formulation clarifiée le 27/07 : … et
  // un pilote avait abandonné sa review … pour une relecture plus faible le
  // 26/07.)") put the opening paren more than 40 chars before its SECOND
  // citation date.
  const radius = 90;
  const before = text.slice(Math.max(0, matchIndex - radius), matchIndex);
  const after = text.slice(matchIndex + matchLength, matchIndex + matchLength + radius);
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

// Sentence-bounded window: reach up to `maxRadius` chars on each side, but
// never CROSS a completed sentence ('.', '!', '?' followed by whitespace).
// Plain radius alone (the first version of this guard) leaked across
// unrelated sentences once paragraph-joining was added to fix the
// line-wrap gap below: two back-to-back sentences with no blank line
// between them ("Mesuré le 31/07 : X. Le prochain compte utilisable est le
// 29/08.") let the FIRST sentence's provenance marker rescue the SECOND
// sentence's live deadline date, and vice versa — caught by this guard's
// own test suite immediately after paragraph-joining was added (card
// #1832980806121817984, 2nd round). Sentence-bounding keeps the
// line-wrap fix (no terminator sits between a wrapped clause and the date
// that follows it) while restoring the one-sentence-at-a-time scope a
// classifier like this needs.
function windowAround(text, index, length, maxRadius = 90) {
  const backStart = Math.max(0, index - maxRadius);
  const before = text.slice(backStart, index);
  let start = backStart;
  for (let i = before.length - 1; i >= 0; i--) {
    if (/[.!?]/.test(before[i]) && /\s/.test(before[i + 1] ?? ' ')) {
      start = backStart + i + 2;
      break;
    }
  }
  const afterEnd = Math.min(text.length, index + length + maxRadius);
  const after = text.slice(index + length, afterEnd);
  const terminatorMatch = /[.!?]\s/.exec(after);
  const end = terminatorMatch ? index + length + terminatorMatch.index + 1 : afterEnd;
  return text.slice(start, Math.max(end, index + length));
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
  return { year, month, day };
}

function toComparableNumber({ year, month, day }) {
  return year * 10000 + month * 100 + day;
}

// A markdown paragraph is a run of non-blank lines bounded by blank lines.
// Real bug (card #1832980806121817984, 2nd round): "Mesuré deux fois le" /
// "28/07 — …" was a single hard-wrapped SENTENCE split across two lines by
// the editor's line width, and a per-LINE window never saw "Mesuré" sitting
// on the previous line — the date came back UNKNOWN despite being provenance
// in plain English. Joining each paragraph's lines with a single space before
// scanning fixes this at the source rather than patching one more marker.
// Trade-off named, not hidden: a paragraph that is itself a dense bulleted
// list (no blank lines between bullets) is joined too, so a marker in one
// bullet could — in principle — rescue an unrelated date in the next one.
// The default window radius (55 chars) bounds how far that reach can go;
// no such leak was observed scanning the real corpus this guard targets.
function paragraphsWithLineMap(text) {
  const lines = text.split('\n');
  const paragraphs = [];
  let current = []; // { lineIndex, text }
  const flush = () => {
    if (current.length === 0) return;
    paragraphs.push(current);
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      flush();
    } else {
      current.push({ lineIndex: i, text: lines[i] });
    }
  }
  flush();
  return paragraphs;
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
  const findings = [];
  for (const paragraphLines of paragraphsWithLineMap(text)) {
    // Join with a single space; track each line's start offset in the joined
    // string so a match can be mapped back to its real (line, column).
    let joined = '';
    const offsets = []; // { lineIndex, start, lineText }
    for (const { lineIndex, text: lineText } of paragraphLines) {
      offsets.push({ lineIndex, start: joined.length, lineText });
      joined += lineText + ' ';
    }
    DATE_PATTERN.lastIndex = 0;
    let m;
    while ((m = DATE_PATTERN.exec(joined)) !== null) {
      const date = resolveDate(m, referenceYear);
      if (!date) continue;
      // Map the match's offset in `joined` back to its original line/column.
      let owner = offsets[0];
      for (const o of offsets) {
        if (o.start <= m.index) owner = o;
        else break;
      }
      const column = m.index - owner.start + 1;

      const window = windowAround(joined, m.index, m[0].length);
      const isAcknowledgedPast = ACKNOWLEDGED_PAST_MARKERS.some((re) => re.test(window));
      const isDeadline = !isAcknowledgedPast && DEADLINE_MARKERS.some((re) => re.test(window));
      const isProvenance =
        !isAcknowledgedPast &&
        !isDeadline &&
        (PROVENANCE_MARKERS.some((re) => re.test(window)) ||
          isParentheticalCitation(joined, m.index, m[0].length));
      const kind = isAcknowledgedPast
        ? 'provenance'
        : isDeadline
          ? 'deadline'
          : isProvenance
            ? 'provenance'
            : 'unknown';
      const stale = kind === 'deadline' && toComparableNumber(date) < todayNum;
      findings.push({
        line: owner.lineIndex + 1,
        column,
        raw: m[0],
        date,
        kind,
        stale,
        window: window.trim(),
      });
    }
  }
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return findings;
}

function defaultToday() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export { toComparableNumber };

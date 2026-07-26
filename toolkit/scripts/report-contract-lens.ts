// report-contract-lens.ts — a REVIEW LENS on narrative reports (pilot/orchestrator
// reports, card comments), for card #1827270233300141550: "toute affirmation NOMME
// son ensemble, son instrument, sa lane".
//
// WHY A LENS AND NOT A RULE (the card's own framing, kept here because the code
// IS the argument): a rule is read at session start; a template is filled in
// appearance. Neither interposes between an intention and the moment a sentence
// is written. This lens reads the ARTIFACT — the report text itself — at the one
// moment it is actually re-read: review. It reuses the pattern already proven by
// pr-review's docs-alignment lens (toolkit/examples/docs-provenance.ts,
// toolkit/examples/pr-review.workflow.ts): a condition arms a focused check that
// produces structured findings instead of a reminder. Kept as a small standalone
// module (not a `.workflow.ts` composition) — this is a synchronous, deterministic
// text check with no agent fan-out, so the Workflow-tool machinery would be
// dead weight for a chore-sized deliverable.
//
// HONEST COVERAGE (read this before trusting a clean run — the card explicitly
// asks: which requirements does the lens actually catch, and which does it
// miss?):
//
//   Req 1 (lane d'implémentation / lane de review nommées séparément)
//     → MECHANICAL, but CLOSED-VOCABULARY: matches a fixed set of FR/EN phrasings
//       (IMPL_LANE / REVIEW_LANE below), and requires the labeled line to carry a
//       non-placeholder VALUE (not just the label — a template with the labels
//       present and "à renseigner" typed in is still non-compliant; caught after a
//       cross-family review found the label-only match too weak, see UPD below). A
//       report using an unlisted lane-label synonym ("voie technique", "porteur du
//       code") reads as non-compliant even if a human would accept it. Known
//       limitation, not a bug: extend the alias regexes when a real synonym shows
//       up rather than loosening the match into a false-negative machine.
//
//   Req 2 (aucun/zéro/personne toujours avec ensemble ET instrument)
//     → MECHANICAL for the "ensemble" half: an absence-term (aucun/zéro/personne/
//       none/nothing) with NO scope marker (sur N, N/M, parmi, des N, of the N, in
//       the N) in the same CLAUSE (not just sentence — an unrelated number in a
//       different clause joined by "but"/"and"/"mais"/"et" no longer counts, see
//       UPD below) is a reliable, low-false-positive signal — it is literally the
//       card's own counter-example ("aucun" alone).
//     → HEURISTIC for the "instrument" half: the vocabulary of instruments (script,
//       grep, lu, exécuté via, gate, transcripts…) is open-ended; this check can
//       miss a genuine instrument named in unusual words. Reported separately so a
//       reader can see which half fired — EXCEPT when scope is ALSO missing: the
//       code only raises the scope finding then (an `else if`), so a sentence
//       missing BOTH surfaces one problem, not two. Documented gap, not fixed: it
//       never causes a missed requirement-2 violation, only a less granular reason.
//
//   Req 3 (nombre + unité + ensemble dans la même phrase ; % avec numérateur ET
//   dénominateur)
//     → MECHANICAL, but SCOPED TO PERCENTAGES ONLY: a percentage with no fraction
//       (N/M, N sur M, N of M) in the same clause is a high-precision signal. The
//       general form of req 3 — ANY bare count with an ambiguous unit noun ("29
//       tours", "100 fichiers") and no stated set — is NOT mechanically checked
//       here at all; that open-ended case is out of this lens's reach (same
//       family of gap as req 4's location cross-check below). A first version of
//       this comment described req 3 as "mechanical+heuristic" without disclosing
//       this — the coverage label was truthful about the percentage sub-case but
//       silent on the uncovered general case, which is exactly the kind of
//       half-true scope claim this card exists to catch. Corrected here.
//     → ADVISORY ONLY (non-blocking) for "same pass" wording: whether the
//       numerator and denominator come from the same run/pass is genuinely
//       context-dependent (sometimes irrelevant), so its absence is a WARN, not a
//       finding — this is stated so a clean run isn't over-read as proof this half
//       was checked as strictly as the other two.
//
//   UPD — a direct-Bash cross-family review (opencode CLI, openai/gpt-5.6-terra,
//   no wrapper agent in between — see evidence 09/10/11/12 in the card's report)
//   found 4 real gaps in the FIRST version of this lens: req 1 accepted a
//   label-only placeholder line; req 2 and req 3 both tested "does the whole
//   SENTENCE contain a scope/fraction marker" instead of "does the CLAUSE
//   qualifying this specific term", false-negativing on compound sentences with
//   an unrelated number elsewhere; and req 3's coverage claim overstated what was
//   actually implemented. All four are fixed and locked by the adversarial test
//   block below (named after the review that found them) — re-run against the
//   review's own repro strings, not just the tests this file's author wrote.
//
//   Req 4 (vérification reportée = point ouvert avec un endroit)
//     → HEURISTIC ONLY, and INCOMPLETE BY CONSTRUCTION: a deferral phrase with no
//       nearby location marker (a card id, a file, "pr #N"…) is flagged, which
//       catches the clear bad pattern. But whether that pointer is actually
//       reflected ON THE DELIVERED THING (the card, not just this report's own
//       prose) is NOT checkable from the report text alone — that half needs a
//       cross-reference read against the tracker, which this lens does not do.
//
//   Req 5 (un résultat de sonde dit ce qui l'aurait fait échouer, et si observé)
//     → HEURISTIC ONLY: a gate/test/probe result phrased as bare "green" with no
//       nearby failure-criterion language (aurait échoué / would fail / critère
//       d'échec / démonstration rouge / observé) is flagged. Whether the stated
//       criterion is actually CORRECT is a semantic judgment this lens cannot
//       make — it can catch an absent criterion, never a wrong one.
//
// So: 3 requirements have a MECHANICAL, low-false-positive core (1, 2, 3); 2
// (4, 5) are heuristic best-effort only, and req 4's core half is out of this
// lens's reach entirely (needs the tracker, not just the report text).
//
// CLI usage: `tsx scripts/report-contract-lens.ts <report-file>` — exits 0 with
// no blocking findings, 1 otherwise (gate-by-exit-code, per this project's own
// ground-truth-verification rule: never trust piped/printed output alone).

export type Requirement = 1 | 2 | 3 | 4 | 5

export type Confidence = 'mechanical' | 'heuristic'

export interface Finding {
  requirement: Requirement
  confidence: Confidence
  message: string
  excerpt: string
}

export interface Warning {
  requirement: Requirement
  message: string
  excerpt: string
}

export type CoverageLabel = 'mechanical' | 'mechanical+heuristic' | 'heuristic'

export interface CheckResult {
  ok: boolean
  findings: Finding[]
  warnings: Warning[]
  coverage: Record<Requirement, CoverageLabel>
}

const COVERAGE: Record<Requirement, CoverageLabel> = {
  1: 'mechanical',
  2: 'mechanical+heuristic',
  3: 'mechanical+heuristic',
  4: 'heuristic',
  5: 'heuristic',
}

// --- shared helpers ---------------------------------------------------

// Split into rough "sentences" — good enough for a heuristic text lens, not a
// grammar parser. Keeps punctuation-terminated clauses together and also
// breaks ONLY on paragraph boundaries (blank lines) — a bare single newline
// is markdown's soft line-wrap, not a sentence break; splitting on every
// newline fragmented a real sentence mid-way in testing (the deferred-check
// sentence wrapped its card-id onto the next line, so the location marker
// landed in a different "sentence" than the deferral phrase it qualifies —
// a real false positive caught by the fixture, not a hypothetical).
function paragraphsOf(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

function sentencesOf(text: string): string[] {
  return paragraphsOf(text)
    .flatMap((p) => p.replace(/\s*\r?\n\s*/g, ' ').split(/(?<=[.!?;])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function excerptOf(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// --- Req 1: lane d'implémentation / lane de review nommées séparément --

const IMPL_LANE = /\b(lane|voie)\s+d['’]?impl[ée]mentation\b|\bimplementation\s+lane\b/i
const REVIEW_LANE = /\b(lane|voie)\s+de\s+review\b|\breview\s+lane\b/i

// Cross-family review finding (evidence 09, req 1, High): the label phrase
// alone was enough to pass — "Lane d'implémentation / lane de review : à
// renseigner." matched BOTH label patterns while naming neither lane. A
// template with the labels present but a placeholder value is exactly the
// failure mode this card names ("un gabarit se remplit en apparence") —
// so a line carrying a lane label must ALSO carry non-placeholder content,
// once both label phrases are stripped out of it.
const PLACEHOLDER_VALUE = /^(à\s+renseigner|tbd|todo|n\/a|xxx+|\.\.\.|\?+)\.?$/i

function isPlaceholderLine(line: string): boolean {
  const stripped = line
    .replace(IMPL_LANE, ' ')
    .replace(REVIEW_LANE, ' ')
    .replace(/[/:—-]/g, ' ')
    .trim()
  return stripped.length === 0 || PLACEHOLDER_VALUE.test(stripped)
}

function checkReq1(text: string): Finding[] {
  const lines = text.split(/\r?\n/)
  const implLine = lines.find((l) => IMPL_LANE.test(l))
  const reviewLine = lines.find((l) => REVIEW_LANE.test(l))
  const implNamed = implLine !== undefined && !isPlaceholderLine(implLine)
  const reviewNamed = reviewLine !== undefined && !isPlaceholderLine(reviewLine)
  if (implNamed && reviewNamed) return []
  const missing = [!implNamed && "lane d'implémentation", !reviewNamed && 'lane de review']
    .filter((x): x is string => Boolean(x))
    .join(' et ')
  return [
    {
      requirement: 1,
      confidence: 'mechanical',
      message: `${missing} non nommée séparément (les deux lanes doivent être identifiables individuellement, avec une VALEUR réelle — pas seulement l'étiquette, pas fondues en une seule mention)`,
      excerpt: excerptOf(text.split(/\r?\n/).find((l) => /lane|voie/i.test(l)) ?? text),
    },
  ]
}

// --- Req 2: aucun/zéro/personne avec ensemble ET instrument -------------

// NOTE — a real gotcha hit and fixed while building THIS lens (kept as a
// comment because the card is exactly about precision claims): JS regex \b
// treats accented letters as NON-word characters (\w is ASCII-only), so a
// boundary immediately adjacent to é/è/etc. silently fails to match even
// where a human reads a normal word edge ("aurait \béchoué\b" never matches
// "aurait échoué" — \b before é finds no transition, because JS considers
// both the preceding space AND "é" itself non-word). Every pattern below that
// ends or starts on an accented letter uses the explicit negative-lookaround
// `(?![A-Za-zÀ-ÖØ-öø-ÿ])` / `(?<![A-Za-zÀ-ÖØ-öø-ÿ])` in place of `\b`.

const ABSENCE_TERM =
  /\b(aucun[e]?|z[ée]ro|personne|rien\s+trouv[ée](?![A-Za-zÀ-ÖØ-öø-ÿ])|none|nothing|no issues?|no defects?)\b/i
const SCOPE_MARKER =
  /\bsur\s+(les?\s+|la\s+|l['’])?\d+|\d+\s*\/\s*\d+|\bparmi\b|\bdes\s+\d+\b|\bof\s+the\s+\d+|\bin\s+the\s+\d+\b|\bacross\s+\d+|\bl['’]ensemble\b/i
const INSTRUMENT_MARKER =
  /\blu(e)?s?\s+(par|via)\b|\bex[ée]cut[ée]s?\s+via\b|\bvia\s+\w|\bpar\s+(script|lecture|grep|test|gate|opencode|sonnet|lint|typecheck)\b|\bby\s+(the\s+|a\s+)?(script|reading|grep|test)\b|\btranscripts?\b|\bjournal\b/i

// Cross-family review finding (evidence 09, req 2/3, High): checking "does
// the SENTENCE contain a scope/fraction marker anywhere" false-negatived on
// a compound sentence where an unrelated number sits in a different clause
// ("No issues found, but the 1/1 smoke test passed." — the fraction belongs
// to the smoke test, not to "no issues", yet it satisfied the whole-sentence
// test). Fix: split on the clause-joining conjunction and only look inside
// the clause that actually CONTAINS the term being qualified.
const CLAUSE_SPLIT = /,\s*(?:but|and|mais|et|however|cependant)\s+|\s+(?:but|however|cependant)\s+/i

function clausesOf(sentence: string): string[] {
  return sentence
    .split(CLAUSE_SPLIT)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
}

function checkReq2(text: string): { findings: Finding[]; warnings: Warning[] } {
  const findings: Finding[] = []
  const warnings: Warning[] = []
  for (const sentence of sentencesOf(text)) {
    if (!ABSENCE_TERM.test(sentence)) continue
    const clause = clausesOf(sentence).find((c) => ABSENCE_TERM.test(c)) ?? sentence
    const hasScope = SCOPE_MARKER.test(clause)
    const hasInstrument = INSTRUMENT_MARKER.test(clause)
    if (!hasScope) {
      findings.push({
        requirement: 2,
        confidence: 'mechanical',
        message:
          '"aucun/zéro/personne" sans ensemble nommé dans la même phrase (ex.: "sur les N…", "N/M") — jamais "aucun" seul',
        excerpt: excerptOf(sentence),
      })
    } else if (!hasInstrument) {
      warnings.push({
        requirement: 2,
        message:
          'ensemble nommé mais aucun instrument reconnu à proximité (vocabulaire ouvert — vérification heuristique seulement)',
        excerpt: excerptOf(sentence),
      })
    }
  }
  return { findings, warnings }
}

// --- Req 3: nombre + unité + ensemble ; % avec numérateur/dénominateur --

const PERCENT = /\d+(?:[.,]\d+)?\s*%/
// "of" added (evidence 09, req 3, Medium): "46 of 50" is the ordinary English
// numerator/denominator form and was not recognized — only "/" and "sur" were.
const FRACTION = /\d+\s*(?:\/|sur|of)\s*\d+/i
const SAME_PASS = /\bm[êe]me\s+(passage|run|ex[ée]cution)\b|\bsame\s+(pass|run)\b/i

// Honest scope note (evidence 09, Medium): this only implements the
// PERCENTAGE sub-case of "nombre + unité + ensemble". A bare count with an
// ambiguous unit noun and no percentage ("Reviewed 12 files.") is NOT
// mechanically checked here — that general case is out of this lens's reach
// (see the module header's coverage table for requirement 3).

function checkReq3(text: string): { findings: Finding[]; warnings: Warning[] } {
  const findings: Finding[] = []
  const warnings: Warning[] = []
  for (const sentence of sentencesOf(text)) {
    if (!PERCENT.test(sentence)) continue
    // Same clause-attachment fix as req 2 (evidence 09, req 3, High): an
    // unrelated fraction in a different clause ("Coverage is 92%, and the
    // 1/1 smoke test passed.") must not excuse the bare percentage.
    const clause = clausesOf(sentence).find((c) => PERCENT.test(c)) ?? sentence
    const hasFraction = FRACTION.test(clause)
    if (!hasFraction) {
      findings.push({
        requirement: 3,
        confidence: 'mechanical',
        message:
          'pourcentage sans numérateur ET dénominateur dans la même phrase (ex.: "92% (46 sur 50)")',
        excerpt: excerptOf(sentence),
      })
    } else if (!SAME_PASS.test(sentence)) {
      warnings.push({
        requirement: 3,
        message:
          'numérateur/dénominateur présents mais rien ne dit s\'ils viennent du même passage (heuristique, non bloquant — souvent non pertinent)',
        excerpt: excerptOf(sentence),
      })
    }
  }
  return { findings, warnings }
}

// --- Req 4: vérification reportée = point ouvert avec un endroit -------

const DEFERRAL_TERM =
  /\bplus\s+tard\b|\breport[ée]e?(?![A-Za-zÀ-ÖØ-öø-ÿ])|\bult[ée]rieurement\b|\bnot\s+yet\b|\bdeferred\b|\bTODO\b|\bfuture\s+pass\b|\bprochaine\s+review\b|\bsera\s+(fait|faite|v[ée]rifi[ée]e?)(?![A-Za-zÀ-ÖØ-öø-ÿ])/i
const LOCATION_MARKER = /#\d{2,}|\bcarte\s+#?\d+|\bcard\s+#?\d+|\bpr\s*#\d+|\b[\w-]+\.(ts|md|mjs|js|tsx)\b/i

function checkReq4(text: string): Finding[] {
  const findings: Finding[] = []
  for (const sentence of sentencesOf(text)) {
    if (!DEFERRAL_TERM.test(sentence)) continue
    if (!LOCATION_MARKER.test(sentence)) {
      findings.push({
        requirement: 4,
        confidence: 'heuristic',
        message:
          'vérification reportée sans endroit nommé (carte, fichier, PR) — un report sans localisation reste un point flottant, pas un point ouvert (⚠ ce check ne peut pas vérifier que le point est bien reflété SUR la carte, seulement que ce rapport en cite une)',
        excerpt: excerptOf(sentence),
      })
    }
  }
  return findings
}

// --- Req 5: un résultat de sonde dit ce qui l'aurait fait échouer -------

const RESULT_CLAIM =
  /\b(gates?|tests?|sonde|probe|v[ée]rification)\b[\s\S]{0,60}\b(vert(e)?|pass(ed|e|ent)?|r[ée]ussi(e)?s?|green)\b/i
const FAILURE_CRITERION =
  /\baurait\b[\s\S]{0,25}(?<![A-Za-zÀ-ÖØ-öø-ÿ])([ée]chou[A-Za-zÀ-ÖØ-öø-ÿ]*|failli[A-Za-zÀ-ÖØ-öø-ÿ]*)(?![A-Za-zÀ-ÖØ-öø-ÿ])|\bwould\s+(have\s+)?fail\b|\bsi\s+(cass[ée]|absent|manquant|un\s+d[ée]faut)\b|\bcrit[èe]re\s+d['’]?[ée]chec\b|\bred[\s-]?demonstration\b|\bd[ée]monstration\s+rouge\b|\brouge\s+confirm[ée](?![A-Za-zÀ-ÖØ-öø-ÿ])|\bobserv[ée]e?(?![A-Za-zÀ-ÖØ-öø-ÿ])/i

function checkReq5(text: string): Finding[] {
  const findings: Finding[] = []
  for (const paragraph of paragraphsOf(text)) {
    if (!RESULT_CLAIM.test(paragraph)) continue
    if (!FAILURE_CRITERION.test(paragraph)) {
      findings.push({
        requirement: 5,
        confidence: 'heuristic',
        message:
          'résultat de sonde/gate annoncé vert sans dire ce qui l\'aurait fait échouer ni si cet échec a été observé',
        excerpt: excerptOf(paragraph),
      })
    }
  }
  return findings
}

// --- entry point ---------------------------------------------------------

export function checkReport(text: string): CheckResult {
  const findings: Finding[] = []
  const warnings: Warning[] = []

  findings.push(...checkReq1(text))
  const r2 = checkReq2(text)
  findings.push(...r2.findings)
  warnings.push(...r2.warnings)
  const r3 = checkReq3(text)
  findings.push(...r3.findings)
  warnings.push(...r3.warnings)
  findings.push(...checkReq4(text))
  findings.push(...checkReq5(text))

  return { ok: findings.length === 0, findings, warnings, coverage: COVERAGE }
}

// --- CLI --------------------------------------------------------------

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: tsx scripts/report-contract-lens.ts <report-file>')
    process.exit(2)
  }
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(path, 'utf8')
  const result = checkReport(text)

  console.log(`report-contract-lens — ${path}`)
  console.log(`coverage: 1=${result.coverage[1]} 2=${result.coverage[2]} 3=${result.coverage[3]} 4=${result.coverage[4]} 5=${result.coverage[5]}`)
  console.log('')
  if (result.findings.length === 0) {
    console.log('BLOCKING FINDINGS: none')
  } else {
    console.log(`BLOCKING FINDINGS: ${result.findings.length}`)
    for (const f of result.findings) {
      console.log(`  [req ${f.requirement}, ${f.confidence}] ${f.message}`)
      console.log(`    > ${f.excerpt}`)
    }
  }
  if (result.warnings.length > 0) {
    console.log('')
    console.log(`ADVISORY (non-blocking): ${result.warnings.length}`)
    for (const w of result.warnings) {
      console.log(`  [req ${w.requirement}] ${w.message}`)
      console.log(`    > ${w.excerpt}`)
    }
  }
  console.log('')
  console.log(result.ok ? 'RESULT: PASS (exit 0)' : 'RESULT: FAIL (exit 1)')
  process.exit(result.ok ? 0 : 1)
}

// ESM entry-guard: compare real paths, not raw strings (a `.bin` symlink
// shim would no-op a raw argv[1] compare — see fiche bin-symlink-entry-guard).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}

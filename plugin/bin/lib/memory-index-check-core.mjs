// memory-index-check-core.mjs — the reachability check behind
// wt-memory-index-check.mjs. Kept separate so tests can drive the pure
// function without spawning a process (see wt-stale-date-guard.mjs's
// lib/stale-date-guard-core.mjs for the same split).
//
// WHAT THIS PROTECTS: an auto-loaded memory
// index (e.g. an auto-memory MEMORY.md) is truncated by the harness past a
// line count nobody sees a warning for. Entries past the cut simply stop
// existing for every session that loads the index — no error, no visible
// truncation. Counting index lines alone cannot tell a COMPRESSED index
// (fiches still reachable through an intermediate hub fiche) from an
// AMPUTATED one (fiches genuinely lost) — a probe that only counts lines can
// be satisfied by deleting entries, which is the defect itself. So this
// module's real output is REACHABILITY: how many fiches exist on disk, how
// many resolve from the index (following direct links AND, transitively,
// any `[[slug]]` references inside a linked fiche's own body — the hub
// pattern), and which ones do not resolve by any path.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// An index entry line, per the convention this project's own
// wt-memory-hygiene.md documents: `- [Title](file.md) — one-phrase hook`.
const ENTRY_LINE_RE = /^-\s*\[[^\]]*\]\(([^)]+\.md)\)/;
// Any markdown link to a .md file, anywhere in a line (index or fiche body).
const LINK_RE = /\]\(([^)]+\.md)\)/g;
// A wiki-style hub member reference inside a fiche BODY: `[[slug]]`.
// Uppercase is included deliberately — a lowercase-only class silently
// drops any slug containing capitals (observed against a real store: a
// case-sensitive checker misreported a correctly-linked fiche as dropped).
const HUBLINK_RE = /\[\[([A-Za-z0-9_.-]+)\]\]/g;

/**
 * @param {string} storeDir - absolute or relative path to the memory store
 *   (the directory holding the index file and the fiche .md files). Always
 *   an argument, never guessed — a tool that knows one location only works
 *   on one machine.
 * @param {{ threshold?: number, indexFile?: string }} [opts]
 * @returns {{
 *   store: string, hasIndex: boolean, indexFile: string, threshold: number,
 *   entryLines: number, overThreshold: boolean,
 *   diskFiches: number, reachableFiches: number, unreachableFiches: string[],
 *   flagged: boolean, reasons: string[]
 * }}
 */
export function checkStore(storeDir, opts = {}) {
  const threshold = opts.threshold ?? 200;
  const indexFile = opts.indexFile ?? 'MEMORY.md';

  let storeStat;
  try {
    storeStat = statSync(storeDir);
  } catch {
    throw new Error(`store dir not found: ${storeDir}`);
  }
  if (!storeStat.isDirectory()) {
    throw new Error(`store path is not a directory: ${storeDir}`);
  }

  const indexPath = join(storeDir, indexFile);

  // A store with no index at all is a project that keeps none — silent,
  // never a block an adopter of this project's own hygiene convention
  // cannot satisfy.
  if (!existsSync(indexPath)) {
    return {
      store: storeDir,
      hasIndex: false,
      indexFile,
      threshold,
      entryLines: 0,
      overThreshold: false,
      diskFiches: 0,
      reachableFiches: 0,
      unreachableFiches: [],
      flagged: false,
      reasons: [],
    };
  }

  const indexText = readFileSync(indexPath, 'utf8');
  const indexLines = indexText.split('\n');
  const entryLineCount = indexLines.filter((line) => ENTRY_LINE_RE.test(line.trim())).length;
  const overThreshold = entryLineCount > threshold;

  // Fiches on disk: *.md files directly inside storeDir, excluding the
  // index itself. A subdirectory (e.g. archive/) is NOT descended into —
  // archived fiches were deliberately moved out of the live store by the
  // project's own hygiene convention, so they are excluded from the
  // reachability graph entirely rather than counted as invisible.
  const diskFiches = new Set();
  for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === basename(indexPath)) continue;
    diskFiches.add(entry.name);
  }

  // Direct links: every `(*.md)` target named anywhere in the index file.
  const directLinks = new Set();
  for (const line of indexLines) {
    LINK_RE.lastIndex = 0;
    let match;
    while ((match = LINK_RE.exec(line))) directLinks.add(match[1]);
  }

  // BFS closure: a directly-linked fiche that is itself a hub lists its
  // members as `[[slug]]` in its own body; follow those transitively so a
  // hub-of-hubs still resolves. Depth is unbounded — nothing in the card's
  // design caps hub nesting, and capping it would just move the silent
  // ceiling one layer down instead of removing it.
  const reachable = new Set();
  const queue = [];
  for (const file of directLinks) {
    if (diskFiches.has(file) && !reachable.has(file)) {
      reachable.add(file);
      queue.push(file);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift();
    let body;
    try {
      body = readFileSync(join(storeDir, current), 'utf8');
    } catch {
      continue; // linked but unreadable — treated as not further expandable, not a crash
    }
    HUBLINK_RE.lastIndex = 0;
    let match;
    while ((match = HUBLINK_RE.exec(body))) {
      const candidate = `${match[1]}.md`;
      if (diskFiches.has(candidate) && !reachable.has(candidate)) {
        reachable.add(candidate);
        queue.push(candidate);
      }
    }
  }

  const unreachableFiches = [...diskFiches].filter((f) => !reachable.has(f)).sort();

  const reasons = [];
  if (overThreshold) {
    reasons.push(`index has ${entryLineCount} entry line(s), over threshold ${threshold}`);
  }
  if (unreachableFiches.length > 0) {
    reasons.push(
      `${unreachableFiches.length} fiche(s) on disk are reachable from the index by no path (hub or direct)`,
    );
  }

  return {
    store: storeDir,
    hasIndex: true,
    indexFile,
    threshold,
    entryLines: entryLineCount,
    overThreshold,
    diskFiches: diskFiches.size,
    reachableFiches: reachable.size,
    unreachableFiches,
    flagged: overThreshold || unreachableFiches.length > 0,
    reasons,
  };
}

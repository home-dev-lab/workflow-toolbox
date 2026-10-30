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
//
// An unreachable fiche is not automatically a defect: wt-memory-hygiene.md
// names a deliberate de-indexing (a retraction kept only so old references
// still resolve) as intentional, not an orphan. A well-formed retraction
// block whose forward pointer resolves is therefore EXEMPT from
// unreachableFiches (see retractedFiches below) — but only that narrow
// case: a retraction with a broken pointer earns no exemption and stays
// counted, on top of the brokenRetractions finding it already produces.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseFrontmatter, splitFrontmatter } from './frontmatter.mjs';

// An index entry line, per the convention this project's own
// wt-memory-hygiene.md documents: `- [Title](file.md) — one-phrase hook`.
const ENTRY_LINE_RE = /^-\s*\[[^\]]*\]\(([^)]+\.md)\)/;
// Any markdown link to a .md file, anywhere in a line (index or fiche body).
const LINK_RE = /\]\(([^)]+\.md)\)/g;
// A wiki-style hub member reference inside a fiche BODY: `[[slug]]`.
// Any character except a literal bracket is accepted inside the double
// brackets — an earlier version enumerated a character class
// ([A-Za-z0-9_.-]) and silently dropped any slug outside it (a real gap
// found by cross-model review: a fiche filename containing a space, e.g.
// `[[topic 1]]` -> `topic 1.md`, was falsely reported unreachable even
// though ordinary markdown links already permit spaces). Enumerating a
// filename-character allowlist is the same trap the case-sensitivity fix
// above was meant to close — better to accept whatever the filesystem
// accepts and let diskFiches (the real on-disk listing) be the filter.
const HUBLINK_RE = /\[\[([^[\]]+)\]\]/g;
// A hub-MEMBER line: the whole trimmed line IS a `[[slug]]` list item, e.g.
// `- [[slug]] — hook`. Anchored at the start (after trimming) and NOT
// global — deliberately narrower than HUBLINK_RE above, which matches a
// `[[slug]]` occurrence anywhere in the text (that stays broad on purpose,
// for reachability: a narrative fiche that mentions a neighbour in prose
// still makes it reachable). This one decides hub CLASSIFICATION, where
// "anywhere in the text" is the wrong question — see HUB_MEMBER_LINE_RATIO.
const MEMBER_LINE_RE = /^-\s*\[\[([^[\]]+)\]\]/;
// Declared hub counts are opt-in and parsed only from an explicit frontmatter
// field: `member_count: <integer>`. A frontmatter key is unambiguous and keeps
// this check silent for stores that never adopted the convention; prose like
// "12 members" is too easy to match accidentally in an ordinary note.
//
// Leading whitespace is deliberately optional: real hub files write this key
// BOTH at column 0 (directly under the frontmatter block) AND nested two
// spaces under a `metadata:` key (`  member_count: 11`) — a column-0-only
// anchor never matched the nested shape, so every hub carrying it went
// unchecked: the probe ran at every session start and never once fired on a
// real hub using that shape (measured 2026-08-06).
// A body counts as a hub only when member-shaped lines are a substantial
// share of its non-blank lines — not merely present. Without this ratio, a
// long narrative fiche that cross-references its neighbours in running
// prose (many `[[link]]` occurrences, almost none of them list items) gets
// classified as a hub and its citations counted as "members". Measured on
// the real store: a 2597-line resume-anchor fiche has 75 inline `[[links]]`
// in prose and exactly 1 line shaped like a member — at "any link present"
// that scored as a 48-member hub (a false positive that would fire a
// SessionStart hook on every session against a perfectly healthy store);
// at this ratio it scores ~0.04% and is correctly not a hub at all. 30% is
// a deliberately generous floor — a genuine hub (a body that IS a member
// list) scores near 100%, so the two shapes are nowhere near each other.
const HUB_MEMBER_LINE_RATIO = 0.3;
// The bound this probe is honest about, on EVERY run that actually checked a
// store — including the clean one. "0 unreachable, 0 dangling" reads as "the
// index is fine", and that is not the question this probe answers.
// REACHABLE means a path exists from the index to a fiche (a direct link, or
// transitively through a hub's `[[slug]]` members); it says nothing about
// whether a session SCANNING the index would know that path is there to
// follow. A real store measured at 2 index lines, 0 unreachable, green on
// every run, while one of those two lines fronted a 103 KB note covering
// fifteen subjects and naming three — twelve subjects were written, correct,
// and undiscoverable, and this probe would have called that store healthy.
// Deliberately NOT a new metric (a per-hub "how much of your body did you
// name" score fires on 13 of this project's own 13 hubs at once — see
// wt-memory-hygiene.md's placement-test note — noise that gets switched off
// before it ever earns its keep). This is a naming of the existing green's
// limit, not a new check.
const SCOPE_NOTE =
  'scope: this run verified REACHABILITY (a path exists from the index to every fiche, direct or via a hub) and the index/hub size ceilings — it did NOT verify DISCOVERABILITY (whether a session scanning the index would know a given subject sits behind a given line).';
const RETRACTION_KEYWORD_RE = /\bretract(?:ed|ion)?\b/i;
const RETRACTION_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const ANY_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const MD_PATH_RE = /(?:\.\.?\/)?(?:[^\s`()[\]]+\/)*[^\s`()[\]]+\.md(?:#[^\s`()[\]]+)?/g;

/**
 * @param {string} storeDir - absolute or relative path to the memory store
 *   (the directory holding the index file and the fiche .md files). Always
 *   an argument, never guessed — a tool that knows one location only works
 *   on one machine.
 * @param {{ threshold?: number, sizeThreshold?: number, indexFile?: string, hubMax?: number }} [opts]
 * @returns {{
 *   store: string, hasIndex: boolean, scopeNote?: string, indexFile: string, threshold: number,
 *   sizeThreshold: number, entryLines: number, indexBytes: number,
 *   overThreshold: boolean, overSizeThreshold: boolean,
 *   diskFiches: number, reachableFiches: number, unreachableFiches: string[],
 *   unreadableFiches: string[],
 *   indexEntries: Array<{ line: number, target: string, behindCount: number | null, complete: boolean, blockedBy: string[] }>,
 *   retractedFiches: string[],
 *   danglingRefs: Array<{ from: string, target: string }>,
 *   unresolvedCrossRefs: Array<{ from: string, target: string }>,
 *   archivedRefs: Array<{ from: string, target: string }>,
 *   staleIndexPointers: Array<{ from: string, target: string }>,
 *   brokenRetractions: Array<{ from: string, target: string }>,
 *   hubMax: number, hubCount: number,
 *   hubCountMismatches: Array<{ file: string, declared: number, actual: number }>,
 *   largestHub: { file: string, members: number } | null,
 *   inWarningBand: boolean, notices: string[],
 *   flagged: boolean, reasons: string[]
 * }}
 */
export function checkStore(storeDir, opts = {}) {
  const threshold = opts.threshold ?? 200;
  // Both defaults are OBSERVATIONS of one harness's behaviour, never a read of
  // any loader's source — state which number you applied whenever you report on
  // this, because neither is a documented constant and both may differ elsewhere.
  //
  // 25000 bytes: an index measured at ~24.4 KB was reported truncated at read
  // time, so the ceiling sits at or just below that. The default is placed just
  // ABOVE the observation on purpose — a threshold set below a real, working
  // size would fire on a healthy store, and a check that refuses correct work is
  // worse than no check: it gets switched off, taking its real case with it.
  // Crossing the applied ceiling flags the store; the final 15% of byte
  // headroom emits a notice only. Pass a lower --size-threshold to place
  // both the ceiling and its warning band below the default.
  const sizeThreshold = opts.sizeThreshold ?? 25000;
  const indexFile = opts.indexFile ?? 'MEMORY.md';
  const hubMax = opts.hubMax ?? 45;
  validateStoreDirectory(storeDir);
  const indexPath = join(storeDir, indexFile);
  const state = { storeDir, threshold, sizeThreshold, indexFile, hubMax, indexPath };
  if (!existsSync(indexPath)) return missingIndexReport(state);
  return checkIndexedStore(state);
}

function validateStoreDirectory(storeDir) {
  let storeStat;
  try {
    storeStat = statSync(storeDir);
  } catch {
    throw new Error(`store dir not found: ${storeDir}`);
  }
  if (!storeStat.isDirectory()) throw new Error(`store path is not a directory: ${storeDir}`);
}

// A project without an index convention has nothing to check, never a block.
function missingIndexReport(state) {
  return {
    store: state.storeDir,
    hasIndex: false,
    indexFile: state.indexFile,
    threshold: state.threshold,
    sizeThreshold: state.sizeThreshold,
    entryLines: 0,
    indexBytes: 0,
    overThreshold: false,
    overSizeThreshold: false,
    diskFiches: 0,
    reachableFiches: 0,
    unreachableFiches: [],
    unreadableFiches: [],
    indexEntries: [],
    retractedFiches: [],
    danglingRefs: [],
    unresolvedCrossRefs: [],
    archivedRefs: [],
    staleIndexPointers: [],
    brokenRetractions: [],
    hubMax: state.hubMax,
    hubCount: 0,
    hubCountMismatches: [],
    largestHub: null,
    inWarningBand: false,
    notices: [],
    flagged: false,
    reasons: [],
  };
}

// Keep the synchronous phase order explicit: index, graph, closure, retractions,
// hub sizes, reasons, notices, report. Helpers share only this private state.
function checkIndexedStore(state) {
  readIndex(state);
  prepareResolvers(state);
  collectDirectLinks(state);
  initializeReachability(state);
  while (state.queue.length > 0) expandNextFiche(state);
  measureEntryExposure(state);
  measureRetractions(state);
  state.largestHub = largestHub(state.hubMemberCounts);
  state.reasons = collectReasons(state);
  const { inWarningBand, notices } = indexWarningBands(state);
  state.inWarningBand = inWarningBand;
  state.notices = notices;
  appendInformationalNotices(state);
  return indexedReport(state);
}

function readIndex(state) {
  const { indexPath, threshold, sizeThreshold } = state;
  const indexText = readFileSync(indexPath, 'utf8');
  state.indexBytes = statSync(indexPath).size;
  state.indexLines = indexText.split('\n');
  state.indexEntries = [];
  for (let i = 0; i < state.indexLines.length; i++) {
    const match = ENTRY_LINE_RE.exec(state.indexLines[i].trim());
    if (!match) continue;
    state.indexEntries.push({ line: i + 1, target: match[1] });
  }
  state.entryLineCount = state.indexLines.filter((line) => ENTRY_LINE_RE.test(line.trim())).length;
  state.overThreshold = state.entryLineCount > threshold;
  state.overSizeThreshold = state.indexBytes > sizeThreshold;
}

function liveFiches(storeDir, indexPath) {
  const diskFiches = new Set();
  for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === basename(indexPath)) continue;
    diskFiches.add(entry.name);
  }
  return diskFiches;
}

// Filename convention first; frontmatter name lookup is lazy and reads whole
// files so a late or truncated declared identity cannot silently disappear.
function slugResolver(diskFiches, storeDir) {
  let nameIndex = null;
  return (slug) => {
    const byFilename = `${slug}.md`;
    if (diskFiches.has(byFilename)) return byFilename;
    if (nameIndex === null) nameIndex = buildNameIndex(diskFiches, storeDir);
    return nameIndex.get(slug) ?? null;
  };
}

function buildNameIndex(diskFiches, storeDir) {
  const index = new Map();
  for (const file of diskFiches) {
    let body;
    try {
      body = readFileSync(join(storeDir, file), 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(body);
    if (!fm.ok || typeof fm.data.name !== 'string') continue;
    if (!index.has(fm.data.name)) index.set(fm.data.name, file);
  }
  return index;
}

// Archive membership never makes a fiche live. Body references into archive/
// are valid; index references into it are stale pointers, a separate finding.
function archivedFiches(storeDir) {
  const files = new Set();
  const archiveDir = join(storeDir, 'archive');
  if (existsSync(archiveDir)) {
    for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith('.md')) continue;
      files.add(entry.name);
    }
  }
  return files;
}

function storeLinkResolver(storeDir) {
  return (target) => {
    if (isAbsolute(target)) return null;
    const path = resolve(storeDir, target);
    const pathFromStore = relative(storeDir, path);
    if (pathFromStore === '' || pathFromStore === '..' || pathFromStore.startsWith(`..${sep}`) || isAbsolute(pathFromStore)) {
      return null;
    }
    return existsSync(path) ? pathFromStore : null;
  };
}

function archivedLinkResolver(files, resolveStoreLink) {
  return (target) => {
    if (files.has(target)) return join('archive', target);
    const resolved = resolveStoreLink(target);
    return resolved !== null && (resolved === 'archive' || resolved.startsWith(`archive${sep}`)) ? resolved : null;
  };
}

function prepareResolvers(state) {
  state.diskFiches = liveFiches(state.storeDir, state.indexPath);
  state.resolveSlug = slugResolver(state.diskFiches, state.storeDir);
  const files = archivedFiches(state.storeDir);
  state.resolveStoreLink = storeLinkResolver(state.storeDir);
  state.resolveArchivedLink = archivedLinkResolver(files, state.resolveStoreLink);
}

function collectDirectLinks(state) {
  state.directLinks = new Set();
  state.resolvedDirectLinks = new Map();
  state.danglingRefs = [];
  state.unresolvedCrossRefs = [];
  state.archivedRefs = [];
  state.staleIndexPointers = [];
  state.brokenRetractions = [];
  for (const line of state.indexLines) {
    LINK_RE.lastIndex = 0;
    let match;
    while ((match = LINK_RE.exec(line))) {
      if (state.resolveArchivedLink(match[1]) !== null) {
        state.staleIndexPointers.push({ from: state.indexFile, target: match[1] });
        continue;
      }
      const resolved = state.resolveStoreLink(match[1]);
      if (resolved !== null) {
        state.directLinks.add(resolved);
        state.resolvedDirectLinks.set(match[1], resolved);
      } else state.danglingRefs.push({ from: state.indexFile, target: match[1] });
    }
  }
}

function initializeReachability(state) {
  state.reachable = new Set();
  state.queue = [];
  const queued = new Set();
  state.unreadableFiches = new Set();
  for (const file of state.directLinks) {
    if (!queued.has(file)) {
      queued.add(file);
      if (state.diskFiches.has(file)) state.reachable.add(file);
      state.queue.push(file);
    }
  }
  state.entryMemberCounts = new Map();
  state.hubMemberCounts = new Map();
  state.hubCountMismatches = [];
  state.structuralHubCount = 0;
  state.hubsWithDeclaredCount = 0;
}

function expandNextFiche(state) {
  const current = state.queue.shift();
  let body;
  try {
    body = readFileSync(join(state.storeDir, current), 'utf8');
  } catch {
    state.unreadableFiches.add(current);
    return;
  }
  followBodyLinks(state, body);
  classifyFiche(state, current, body);
}

// Reachability is transitive and accepts references anywhere in the body,
// including prose; hub classification below deliberately remains narrower.
function followBodyLinks(state, body) {
  const bodyLinks = new Set();
  HUBLINK_RE.lastIndex = 0;
  let match;
  while ((match = HUBLINK_RE.exec(body))) {
    const candidate = state.resolveSlug(match[1]);
    if (candidate === null) continue;
    bodyLinks.add(candidate);
    if (!state.reachable.has(candidate)) {
      state.reachable.add(candidate);
      state.queue.push(candidate);
    }
  }
}

function memberReferences(state, bodyLines, current) {
  let memberLineCount = 0;
  const memberLineSlugs = new Set();
  const memberSlugs = new Set();
  const unresolvedMemberLineRefs = [];
  for (const line of bodyLines) {
    const m = MEMBER_LINE_RE.exec(line.trim());
    if (!m) continue;
    memberLineCount++;
    const resolved = state.resolveSlug(m[1]);
    const candidate = resolved ?? `${m[1]}.md`;
    memberLineSlugs.add(candidate);
    if (resolved !== null) memberSlugs.add(candidate);
    else if (state.resolveArchivedLink(candidate) !== null) state.archivedRefs.push({ from: current, target: candidate });
    else unresolvedMemberLineRefs.push({ from: current, target: candidate });
  }
  return { memberLineCount, memberLineSlugs, memberSlugs, unresolvedMemberLineRefs };
}

function classifyFiche(state, current, body) {
  const bodyLines = body.split('\n');
  const nonBlankLineCount = bodyLines.filter((l) => l.trim().length > 0).length;
  const { memberLineCount, memberLineSlugs, memberSlugs, unresolvedMemberLineRefs } = memberReferences(state, bodyLines, current);
  state.entryMemberCounts.set(current, memberSlugs.size);
  const declaredCount = readDeclaredMemberCount(body);
  if (declaredCount !== null && declaredCount !== memberLineSlugs.size) {
    state.hubCountMismatches.push({ file: current, declared: declaredCount, actual: memberLineSlugs.size });
  }
  const isStructuralHub =
    memberLineCount > 0 && nonBlankLineCount > 0 && memberLineCount / nonBlankLineCount >= HUB_MEMBER_LINE_RATIO;
  if (isStructuralHub) {
    state.structuralHubCount++;
    if (declaredCount !== null) state.hubsWithDeclaredCount++;
    for (const ref of unresolvedMemberLineRefs) state.danglingRefs.push(ref);
    state.hubMemberCounts.set(current, memberSlugs.size);
  } else {
    for (const ref of unresolvedMemberLineRefs) state.unresolvedCrossRefs.push(ref);
  }
}

// Exposure counts are one hop and member-shaped, independently of whether a
// fiche's structure qualifies it as a hub. Whole-store reachability is BFS.
function measureEntryExposure(state) {
  state.rawUnreachableFiches = [...state.diskFiches].filter((f) => !state.reachable.has(f)).sort();
  state.perEntryCounts = state.indexEntries.map(({ line, target }) =>
    measureEntryMembers(target, state.resolvedDirectLinks.get(target) ?? target, line, state.diskFiches, state.entryMemberCounts, state.unreadableFiches),
  );
}

// Only a whole-note, well-formed retraction with a resolving forward pointer
// exempts an unreachable fiche. Broken pointers remain findings and orphans.
function measureRetractions(state) {
  const retractedResolving = new Set();
  for (const file of state.diskFiches) {
    let body;
    try {
      body = readFileSync(join(state.storeDir, file), 'utf8');
    } catch {
      continue;
    }
    const target = readRetractionForwardTarget(body);
    if (target === null) continue;
    if (retractionTargetResolves(state.storeDir, target)) {
      retractedResolving.add(file);
      continue;
    }
    state.brokenRetractions.push({ from: file, target });
  }
  state.retractedFiches = state.rawUnreachableFiches.filter((f) => retractedResolving.has(f)).sort();
  state.unreachableFiches = state.rawUnreachableFiches.filter((f) => !retractedResolving.has(f));
}

function largestHub(hubMemberCounts) {
  let largest = null;
  for (const [file, members] of hubMemberCounts) {
    if (!largest || members > largest.members) largest = { file, members };
  }
  return largest;
}

function collectReasons(state) {
  const reasons = [];
  if (state.overThreshold) reasons.push(`index has ${state.entryLineCount} entry line(s), over threshold ${state.threshold}`);
  if (state.overSizeThreshold) reasons.push(`index is ${state.indexBytes} byte(s), over threshold ${state.sizeThreshold}`);
  appendReachabilityReasons(state, reasons);
  appendHubReasons(state, reasons);
  return reasons;
}

function appendReachabilityReasons(state, reasons) {
  if (state.unreachableFiches.length > 0) {
    reasons.push(`${state.unreachableFiches.length} fiche(s) on disk are reachable from the index by no path (hub or direct)`);
  }
  if (state.unreadableFiches.size > 0) {
    reasons.push(`could not fully read ${state.unreadableFiches.size} reachable fiche(s); reachability was verified only where those files could be read`);
  }
  for (const { from, target } of state.danglingRefs) reasons.push(`dangling reference from ${from} to ${target}`);
  for (const { from, target } of state.brokenRetractions) reasons.push(`retraction forward pointer from ${from} to ${target} does not resolve`);
  for (const { from, target } of state.staleIndexPointers) {
    reasons.push(`${from} still points at ${target}, which has been archived — drop the pointer (it may live in a hub body, not the index)`);
  }
}

function appendHubReasons(state, reasons) {
  for (const [file, members] of state.hubMemberCounts) {
    if (members > state.hubMax) reasons.push(`hub ${file} has ${members} member(s), over hubMax ${state.hubMax}`);
  }
  for (const { file, declared, actual } of state.hubCountMismatches) reasons.push(`hub ${file} declared ${declared} member(s); actual ${actual}`);
}

// Each ceiling gets its own countdown notice, suppressed once that ceiling
// is crossed. A band never contributes a reason or changes the exit code.
function indexWarningBands({ entryLineCount, threshold, indexBytes, sizeThreshold, overThreshold, overSizeThreshold }) {
  const headroom = threshold - entryLineCount;
  const bandWidth = Math.max(10, Math.round(threshold * 0.15));
  const inLineBand = !overThreshold && headroom <= bandWidth;
  const notices = [];
  if (inLineBand) {
    notices.push(`index headroom: ${headroom} line(s) before the threshold of ${threshold}`);
  }
  const byteHeadroom = sizeThreshold - indexBytes;
  const inByteBand = !overSizeThreshold && byteHeadroom <= sizeThreshold * 0.15;
  if (inByteBand) {
    notices.push(`index byte headroom: ${byteHeadroom} byte(s) before the size threshold of ${sizeThreshold} (${indexBytes} byte(s) used)`);
  }
  return { inWarningBand: inLineBand || inByteBand, notices };
}

function appendInformationalNotices(state) {
  const { notices, unresolvedCrossRefs, archivedRefs, structuralHubCount, hubsWithDeclaredCount, retractedFiches } = state;
  if (unresolvedCrossRefs.length > 0) {
    notices.push(`informational only: ${unresolvedCrossRefs.length} unresolved cross-reference(s) in non-hub bodies; see unresolvedCrossRefs for per-item detail`);
  }
  if (archivedRefs.length > 0) {
    notices.push(`${archivedRefs.length} reference(s) resolve in archive/ — correct by the hygiene convention, which does not rewrite inbound links when a fiche is archived; no action`);
  }
  if (structuralHubCount > 0 && hubsWithDeclaredCount === 0) {
    notices.push('declared-count cross-check inactive: hubs exist, but none declares member_count; silence here means not measured, not verified');
  }
  if (retractedFiches.length > 0) {
    notices.push(`${retractedFiches.length} fiche(s) excluded from unreachable — a deliberate retraction whose forward pointer resolves (see wt-memory-hygiene.md); not a defect`);
  }
}

function indexedReport(state) {
  return {
    store: state.storeDir,
    hasIndex: true,
    scopeNote: SCOPE_NOTE,
    indexFile: state.indexFile,
    threshold: state.threshold,
    sizeThreshold: state.sizeThreshold,
    entryLines: state.entryLineCount,
    indexBytes: state.indexBytes,
    overThreshold: state.overThreshold,
    overSizeThreshold: state.overSizeThreshold,
    diskFiches: state.diskFiches.size,
    reachableFiches: state.reachable.size,
    unreachableFiches: state.unreachableFiches,
    unreadableFiches: [...state.unreadableFiches].sort(),
    indexEntries: state.perEntryCounts,
    retractedFiches: state.retractedFiches,
    danglingRefs: state.danglingRefs,
    unresolvedCrossRefs: state.unresolvedCrossRefs,
    archivedRefs: state.archivedRefs,
    staleIndexPointers: state.staleIndexPointers,
    brokenRetractions: state.brokenRetractions,
    hubMax: state.hubMax,
    hubCount: state.hubMemberCounts.size,
    hubCountMismatches: state.hubCountMismatches,
    largestHub: state.largestHub,
    inWarningBand: state.inWarningBand,
    notices: state.notices,
    flagged: state.reasons.length > 0,
    reasons: state.reasons,
  };
}

function measureEntryMembers(target, resolvedTarget, line, diskFiches, entryMemberCounts, unreadableFiches) {
  if (!diskFiches.has(resolvedTarget) && !entryMemberCounts.has(resolvedTarget)) {
    return { line, target, behindCount: null, complete: false, blockedBy: [target] };
  }

  if (unreadableFiches.has(resolvedTarget)) {
    return { line, target, behindCount: null, complete: false, blockedBy: [target] };
  }

  if (!entryMemberCounts.has(resolvedTarget)) {
    return { line, target, behindCount: null, complete: false, blockedBy: [target] };
  }

  return {
    line,
    target,
    behindCount: entryMemberCounts.get(resolvedTarget),
    complete: true,
    blockedBy: [],
  };
}

function readDeclaredMemberCount(body) {
  const parsed = parseFrontmatter(body);
  if (!parsed.ok) return null;
  const count = parsed.data.member_count ?? parsed.data.metadata?.member_count;
  return typeof count === 'string' && /^\d+$/.test(count) ? Number(count) : null;
}

function readRetractionForwardTarget(body) {
  const content = stripFrontmatter(body).replace(/^\uFEFF/, '');
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  if (i >= lines.length || !/^\s*>/.test(lines[i])) return null;

  const quoteLines = [];
  while (i < lines.length && /^\s*>/.test(lines[i])) {
    quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
    i++;
  }

  const block = quoteLines.join('\n').trim();
  if (!RETRACTION_KEYWORD_RE.test(block) || !RETRACTION_DATE_RE.test(block)) return null;
  return extractRetractionTarget(block);
}

function extractRetractionTarget(block) {
  ANY_LINK_RE.lastIndex = 0;
  let match;
  while ((match = ANY_LINK_RE.exec(block))) {
    const candidate = match[1].trim();
    if (isResolvableRetractionTarget(candidate)) return candidate;
  }

  INLINE_CODE_RE.lastIndex = 0;
  while ((match = INLINE_CODE_RE.exec(block))) {
    const candidate = match[1].trim();
    if (isResolvableRetractionTarget(candidate)) return candidate;
  }

  MD_PATH_RE.lastIndex = 0;
  match = MD_PATH_RE.exec(block);
  if (match) return match[0];

  return null;
}

function isResolvableRetractionTarget(candidate) {
  if (candidate.length === 0) return false;
  if (/^[a-z]+:\/\//i.test(candidate)) return false;
  return candidate.includes('/') || candidate.endsWith('.md');
}

function retractionTargetResolves(storeDir, target) {
  const normalized = target.replace(/#.*/, '');
  if (normalized.length === 0) return false;
  if (/^[a-z]+:\/\//i.test(normalized)) return true;
  if (normalized.startsWith('/')) return existsSync(normalized);
  return existsSync(join(storeDir, normalized));
}

function stripFrontmatter(body) {
  const split = splitFrontmatter(body);
  return split.ok ? split.body : body;
}

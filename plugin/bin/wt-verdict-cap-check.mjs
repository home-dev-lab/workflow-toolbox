#!/usr/bin/env node
// Verdict-cap check: a verifier report must not present a "clean" best verdict
// when it has itself declared a source UNREACHABLE — the verdict line must carry
// a DEGRADED cap naming the reason. This enforces exactly ONE invariant; it is
// not a general fidelity checker.
//
// Cross-platform: pure `node:fs` + `node:path` + regex over the file text, no
// shell-outs, no POSIX-only assumptions (no /proc, no path-separator literals) —
// this should behave identically on Linux/macOS/Windows.
//
// Usage: node wt-verdict-cap-check.mjs <path-to-report.md>
//
// Exit codes:
//   0 — compliant (capped-when-needed, or no cap needed)
//   1 — VIOLATION: an uncapped "yes" verdict despite a declared-unreachable source
//   2 — malformed: required sections missing, or the file could not be read
//
// Always prints exactly one line of JSON to stdout, in every case.
import { readFileSync } from 'node:fs';
import { handleHelpFlag } from './lib/cli-help.mjs';

const HELP = `wt-verdict-cap-check — enforce ONE invariant: a verifier report must not present a
"clean" best verdict when it has itself declared a source UNREACHABLE — the verdict line must
carry a DEGRADED cap naming the reason.

Usage: node wt-verdict-cap-check.mjs <path-to-report.md>

Exit codes: 0 compliant · 1 VIOLATION (uncapped "yes" despite a declared-unreachable source) ·
2 malformed (required sections missing, or the file could not be read).
`;

handleHelpFlag(process.argv.slice(2), HELP);

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

const path = process.argv[2];
if (!path) {
  out({ ok: false, malformed: true, reason: 'usage: wt-verdict-cap-check.mjs <path-to-report.md>' }, 2);
}

let text;
try {
  text = readFileSync(path, 'utf8');
} catch (err) {
  out({ ok: false, malformed: true, reason: `cannot read file: ${err.message}` }, 2);
}

// --- Locate "## Sources probed" block ---------------------------------------
const sourcesHeadingRe = /^##\s*Sources probed\s*$/m;
const sourcesMatch = sourcesHeadingRe.exec(text);
if (!sourcesMatch) {
  out({ ok: false, malformed: true, reason: 'missing "## Sources probed" heading' }, 2);
}

const afterHeadingStart = sourcesMatch.index + sourcesMatch[0].length;
const rest = text.slice(afterHeadingStart);
// Block ends at the next line starting with "##" (a new heading), the verdict
// line itself, or EOF — whichever comes first. The verdict line is its own
// terminator (not just "##") because a report author may write it directly
// under the bullet list with no blank line in between, and the verdict line
// is never itself a source line, so it must not be handed to the fail-closed
// source-line parser below.
const nextHeadingMatch = /^##\s/m.exec(rest);
const verdictInRestMatch = /^\(A\)\s*Resumable\?\s*(yes|no)\b/im.exec(rest);
const boundaries = [nextHeadingMatch?.index, verdictInRestMatch?.index].filter(
  (i) => typeof i === 'number',
);
const blockEnd = boundaries.length > 0 ? Math.min(...boundaries) : rest.length;
const blockText = rest.slice(0, blockEnd);

// Each source line: "- <label>: REACHABLE" or "- <label>: UNREACHABLE <sep> <reason>"
// Lenient on the separator between UNREACHABLE and the reason (em-dash, "--", "-", ":"),
// lenient on the CASE of the REACHABLE/UNREACHABLE token (report authors are prose,
// not machines — "Reachable"/"reachable" must parse the same as "REACHABLE").
// Whitespace around the separator is deliberately [ \t]* (never \s*): \s
// matches newlines too, which would let the optional trailing group swallow
// the line break and merge the NEXT source line into this one's "reason".
const sourceLineRe = /^-[ \t]*(.+?):[ \t]*(REACHABLE|UNREACHABLE)\b(?:[ \t]*(?:—|--|-|:)[ \t]*(.*))?[ \t]*$/i;
const sources = [];
// Fail CLOSED on unparseable content instead of silently dropping it: every
// non-blank line inside the Sources-probed block must match the source-line
// pattern, or the report is malformed. Without this, a line that fails to
// match for ANY reason (wrong case before this fix, a stray typo, a different
// bullet character, an extra blank field) silently produces zero parsed
// sources — which the decision logic below then reads as "all sources
// reachable", a false-clean result. That is exactly the failure class this
// whole check exists to close, one layer up in the parser itself.
for (const rawLine of blockText.split('\n')) {
  const line = rawLine.replace(/\r$/, '');
  if (line.trim() === '') continue;
  const m = sourceLineRe.exec(line);
  if (!m) {
    out(
      {
        ok: false,
        malformed: true,
        reason: `unparseable line in "## Sources probed" block: ${JSON.stringify(line.trim())}`,
      },
      2,
    );
  }
  const [, label, status, reason] = m;
  sources.push({ label: label.trim(), status: status.toUpperCase(), reason: reason ? reason.trim() : undefined });
}

// --- Locate "(A) Resumable? yes/no" verdict line -----------------------------
const verdictRe = /^\(A\)\s*Resumable\?\s*(yes|no)\b(.*)$/im;
const verdictMatch = verdictRe.exec(text);
if (!verdictMatch) {
  out({ ok: false, malformed: true, reason: 'missing "(A) Resumable? yes/no" verdict line' }, 2);
}

const verdictToken = verdictMatch[1].toLowerCase();
const verdictTrailer = verdictMatch[2] || '';

const unreachable = sources.filter((s) => s.status === 'UNREACHABLE');

if (unreachable.length === 0) {
  out({ ok: true, capped: 'not-needed', reason: 'all declared sources reachable' }, 0);
}

if (verdictToken === 'no') {
  out({ ok: true, capped: 'not-needed', reason: 'verdict already below clean' }, 0);
}

// verdictToken === 'yes' from here on.
const isDegraded = /DEGRADED/i.test(verdictTrailer);
const unreachableLabels = unreachable.map((s) => s.label);

if (!isDegraded) {
  out(
    {
      ok: false,
      violation: true,
      unreachableSources: unreachableLabels,
      reason: `verdict line does not carry a DEGRADED cap despite ${unreachable.length} unreachable source(s)`,
    },
    1,
  );
}

out({ ok: true, capped: true, unreachableSources: unreachableLabels }, 0);

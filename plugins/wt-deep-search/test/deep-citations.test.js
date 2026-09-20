import assert from 'node:assert/strict';
import test from 'node:test';

import { formatResult } from '../src/deep/format.js';

// ⚠ MEASURED on a real deep-lite run, 2026-09-21 00:47 +01:00, $0.012. The prose came back with
// `[1][2][3]` markers and the URLs in a SEPARATE `grounding` field, shaped
//   [{ field: 'content', citations: [{ url, title }], confidence: 'high' }]
// so the markers resolve to nothing unless the sources are rendered beside the prose. The same
// question asked with the claim SCHEMA returned a url and a date on every claim — which settles,
// in the direction the card left open, that a structured schema does buy a source per assertion
// and prose does not.

const grounding = [{
  field: 'content',
  citations: [
    { url: 'https://nodejs.org/en/blog/release/v26.8.2', title: 'Node.js 26.8.2 (Current)' },
    { url: 'https://nodejs.org/en/download/current', title: 'Download Node.js' },
  ],
  confidence: 'high',
}];

test('prose renders the grounded sources, so its [1] markers resolve', () => {
  const answer = formatResult({
    status: 'done',
    engine: 'exa',
    shape: 'prose',
    result: { content: 'Node.js 26.8.2 is current. [1][2]', grounding, costDollars: 0.012 },
  }, { shape: 'prose' });
  assert.match(answer, /\[1\] Node\.js 26\.8\.2 \(Current\) — https:\/\/nodejs\.org\/en\/blog\/release\/v26\.8\.2/);
  assert.match(answer, /\[2\] Download Node\.js — https:\/\/nodejs\.org\/en\/download\/current/);
});

test('a prose run refuses to be read as structured, because the schema is chosen at start', () => {
  assert.throws(
    () => formatResult({
      status: 'done',
      engine: 'exa',
      shape: 'prose',
      result: { content: 'plain prose', grounding, costDollars: 0.012 },
    }, { shape: 'structured' }),
    /started for prose.*start a new run with --shape structured/i,
  );
});

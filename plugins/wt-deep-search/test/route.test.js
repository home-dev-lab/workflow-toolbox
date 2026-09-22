import assert from 'node:assert/strict';
import test from 'node:test';

import { route } from '../src/route.js';

const absent = (reason = 'not configured') => ({ available: false, reason });

function providers(overrides = {}) {
  return {
    mirror: absent(),
    brave: absent(),
    exa: absent(),
    opencode: absent(),
    ...overrides,
  };
}

test('routes Claude Code questions to the local mirror first', () => {
  const result = route(
    'What changed recently in the Claude Code hooks?',
    providers({
      mirror: { available: true, path: '/docs' },
      brave: { available: true },
      opencode: { available: true, path: '/bin/opencode' },
    }),
  );

  assert.deepEqual(result, {
    provider: 'mirror',
    // The literal product name is STRONG evidence: the mirror answers rather than being
    // consulted. A generic noun would give 'weak' here and fall through if it found nothing.
    confidence: 'strong',
    reason: 'Claude Code questions use the free local documentation mirror',
    call: { path: '/docs', query: 'What changed recently in the Claude Code hooks?' },
  });
});

test('does not route a Claude Code question to mirror when it is absent', () => {
  const result = route(
    'How do Claude Code slash commands work?',
    providers({ brave: { available: true } }),
  );

  assert.equal(result.provider, 'none');
  assert.match(result.reason, /mirror.*not configured/i);
});

test('routes a simple current question to Brave', () => {
  const result = route(
    'What is the weather in Paris today?',
    providers({ brave: { available: true }, exa: { available: true } }),
  );

  assert.equal(result.provider, 'brave');
  assert.deepEqual(result.call, {
    query: 'What is the weather in Paris today?',
    options: {},
  });
});

test('falls back from Brave to the cheapest Exa search type', () => {
  const result = route(
    'Who won the latest Formula One race?',
    providers({ exa: { available: true } }),
  );

  assert.equal(result.provider, 'exa');
  assert.deepEqual(result.call, {
    query: 'Who won the latest Formula One race?',
    options: { type: 'fast' },
  });
});

test('routes explicit deep research to opencode', () => {
  const result = route(
    'Provide a comprehensive literature review of solid-state battery research',
    providers({ opencode: { available: true, path: '/tools/opencode' } }),
  );

  assert.equal(result.provider, 'opencode');
  assert.deepEqual(result.call, {
    command: '/tools/opencode',
    args: [
      'run',
      'Provide a comprehensive literature review of solid-state battery research',
    ],
  });
});

test('strong deep-research intent wins over ordinary question words', () => {
  const result = route(
    'What are the trade-offs? Investigate and synthesize evidence from multiple sources',
    providers({ brave: { available: true }, opencode: { available: true, path: 'opencode' } }),
  );

  assert.equal(result.provider, 'opencode');
});

test('natural comparison language is deep-research intent', () => {
  const result = route(
    'Compare the evidence for these two approaches',
    providers({ brave: { available: true }, opencode: { available: true, path: 'opencode' } }),
  );

  assert.equal(result.provider, 'opencode');
});

test('returns none when no simple-search provider is available', () => {
  const result = route('What is the population of Lisbon?', providers());

  assert.deepEqual(result, {
    provider: 'none',
    reason: 'No Brave or Exa provider is available for a simple search',
    call: null,
  });
});

test('returns none when deep research has no opencode provider', () => {
  const result = route(
    'Compare competing theories and synthesize evidence across multiple sources',
    providers({ brave: { available: true } }),
  );

  assert.deepEqual(result, {
    provider: 'none',
    reason: 'opencode is not available for deep research',
    call: null,
  });
});

test('treats an unmarked question as simple to minimize cost', () => {
  const result = route('Capital of Estonia', providers({ exa: { available: true } }));

  assert.equal(result.provider, 'exa');
  assert.equal(result.call.options.type, 'fast');
});

test('returns none for null provider input instead of throwing', () => {
  assert.deepEqual(route('What is the population of Lisbon?', null), {
    provider: 'none',
    reason: 'No Brave or Exa provider is available for a simple search',
    call: null,
  });
});

test('returns none before a whitespace-only question can use a paid provider', () => {
  assert.deepEqual(route('  \t ', providers({ brave: { available: true } })), {
    provider: 'none',
    reason: 'Question must be a non-empty value',
    call: null,
  });
});

test('does not emit a mirror call without a usable path', () => {
  const result = route(
    'How do slash commands work?',
    providers({ mirror: { available: true } }),
  );

  assert.equal(result.provider, 'none');
  assert.match(result.reason, /mirror.*path/i);
});

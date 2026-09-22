import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ProviderFailure,
  createExhaustionMemory,
  route,
  searchBrave,
  searchExa,
} from '../src/index.js';

const fixtures = JSON.parse(await readFile(
  new URL('./fixtures/provider-errors.json', import.meta.url),
  'utf8',
));

function response(status, body, headers = {}) {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    status,
    headers: { get: (name) => normalized.get(name.toLowerCase()) ?? null },
    json: async () => body,
  };
}

async function failureFrom(search, status, body, extra = {}) {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return response(status, body, extra.headers);
  };
  const error = await search('query', { apiKey: 'fixture-key' }, {
    fetch,
    sleep: async () => {},
    now: extra.now,
  }).then(
    () => assert.fail('expected provider failure'),
    (caught) => caught,
  );
  assert.ok(error instanceof ProviderFailure);
  return { error, calls };
}

for (const [provider, search, bodies] of [
  ['brave', searchBrave, {
    rateLimit: fixtures.braveRateLimit,
    insufficient: fixtures.braveInsufficientCredit,
    option: fixtures.braveOptionNotInPlan,
  }],
  ['exa', searchExa, {
    rateLimit: fixtures.exaRateLimit,
    insufficient: fixtures.exaInsufficientCredit,
    option: fixtures.exaOptionNotInPlan,
  }],
]) {
  test(`${provider} retries a real-shaped 429 and preserves its reset declaration`, async () => {
    const now = () => 1_000;
    const { error, calls } = await failureFrom(search, 429, bodies.rateLimit, {
      headers: { 'x-ratelimit-reset': '4' },
      now,
    });

    assert.equal(calls, 3);
    assert.equal(error.classification, 'rate-limit');
    assert.equal(error.provider, provider);
    assert.equal(error.status, 429);
    assert.equal(error.resetAt, 5_000);
  });

  test(`${provider} switches immediately on insufficient credit`, async () => {
    const { error, calls } = await failureFrom(search, 429, bodies.insufficient);

    assert.equal(calls, 1);
    assert.equal(error.classification, 'exhausted');
    assert.equal(error.provider, provider);
    assert.equal(error.status, 429);
  });

  test(`${provider} switches immediately on OPTION_NOT_IN_PLAN`, async () => {
    const { error, calls } = await failureFrom(search, 422, bodies.option);

    assert.equal(calls, 1);
    assert.equal(error.classification, 'exhausted');
  });

  test(`${provider} distinguishes a refused API key from exhaustion`, async () => {
    const { error, calls } = await failureFrom(search, 401, { error: 'invalid API key' });

    assert.equal(calls, 1);
    assert.equal(error.classification, 'refused');
    assert.match(error.message, /API key was refused/i);
  });

  test(`${provider} retries a 5xx as transient without marking exhaustion`, async () => {
    let now = 10_000;
    const memory = createExhaustionMemory({ now: () => now, fallbackMs: 500 });
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return response(503, { error: 'temporarily unavailable' });
    };

    await assert.rejects(
      search('query', { apiKey: 'fixture-key' }, {
        fetch,
        sleep: async () => {},
        now: () => now,
        exhaustion: memory,
      }),
      (error) => error.classification === 'transient',
    );
    assert.equal(calls, 3);
    assert.equal(memory.isExhausted(provider), false);
    now += 1_000;
    assert.equal(memory.isExhausted(provider), false);
  });

  test(`${provider} classifies a network failure as transient`, async () => {
    const fetch = async () => { throw new Error('socket closed'); };

    await assert.rejects(
      search('query', { apiKey: 'fixture-key' }, { fetch, sleep: async () => {} }),
      (error) => error instanceof ProviderFailure
        && error.classification === 'transient'
        && error.provider === provider
        && error.status === null,
    );
  });
}

test('the second search skips an exhausted provider and retries after injected time passes', async () => {
  let now = 20_000;
  const memory = createExhaustionMemory({ now: () => now, fallbackMs: 1_000 });
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) return response(402, fixtures.braveInsufficientCredit);
    return response(200, { web: { results: [] } });
  };
  const deps = { fetch, exhaustion: memory, now: () => now, sleep: async () => {} };

  await assert.rejects(searchBrave('first', { apiKey: 'fixture-key' }, deps));
  await assert.rejects(
    searchBrave('second', { apiKey: 'fixture-key' }, deps),
    (error) => error.classification === 'exhausted',
  );
  assert.equal(calls, 1);

  now += 1_001;
  await searchBrave('third', { apiKey: 'fixture-key' }, deps);
  assert.equal(calls, 2);
});

test('an exhausted Brave cascades to none for ordinary web search', async () => {
  const memory = createExhaustionMemory({ now: () => 0, fallbackMs: 1_000 });
  await assert.rejects(searchBrave('query', { apiKey: 'key' }, {
    fetch: async () => response(402, fixtures.braveInsufficientCredit),
    exhaustion: memory,
    now: () => 0,
    sleep: async () => {},
  }));

  assert.equal(route('query', {
    brave: { available: true },
    exa: { available: true },
  }, { exhaustion: memory }).provider, 'none');
});

test('an exhausted Exa cascades to opencode', async () => {
  const memory = createExhaustionMemory({ now: () => 0, fallbackMs: 1_000 });
  await assert.rejects(searchExa('query', { apiKey: 'key' }, {
    fetch: async () => response(422, fixtures.exaOptionNotInPlan),
    exhaustion: memory,
    now: () => 0,
    sleep: async () => {},
  }));

  const decision = route('query', {
    exa: { available: true },
    opencode: { available: true, path: '/bin/opencode' },
  }, { exhaustion: memory });
  assert.equal(decision.provider, 'opencode');
  assert.deepEqual(decision.call, {
    command: '/bin/opencode',
    args: ['run', 'query'],
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { searchBrave } from '../src/clients/brave.js';
import { searchExa } from '../src/clients/exa.js';

test('Brave builds a GET request and normalizes a successful answer', async () => {
  let request;
  const raw = {
    web: {
      results: [
        {
          title: 'Example result',
          url: 'https://example.com',
          description: 'A useful snippet',
          page_age: '2026-09-01T10:00:00Z',
        },
      ],
    },
  };
  const fetch = async (...args) => {
    request = args;
    return { ok: true, status: 200, json: async () => raw };
  };

  const answer = await searchBrave(
    'space weather',
    { apiKey: 'test-token', count: 5, country: 'US' },
    { fetch },
  );

  const url = new URL(request[0]);
  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(url.searchParams.get('q'), 'space weather');
  assert.equal(url.searchParams.get('count'), '5');
  assert.equal(url.searchParams.get('country'), 'US');
  assert.equal(request[1].method, 'GET');
  assert.equal(request[1].headers['X-Subscription-Token'], 'test-token');
  assert.deepEqual(answer, {
    results: [
      {
        title: 'Example result',
        url: 'https://example.com',
        snippet: 'A useful snippet',
        publishedAt: '2026-09-01T10:00:00Z',
      },
    ],
    raw,
  });
});

test('Brave names its provider and status for a non-2xx answer', async () => {
  const fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });

  await assert.rejects(
    searchBrave('query', { apiKey: 'test-token' }, { fetch }),
    /Brave search failed with status 429/,
  );
});

test('Brave reports a malformed successful body as a protocol failure', async () => {
  const fetch = async () => ({ ok: true, status: 200, json: async () => null });

  await assert.rejects(
    searchBrave('query', { apiKey: 'test-token' }, { fetch }),
    /Brave search returned an invalid response/,
  );
});

test('Brave options cannot replace the positional query', async () => {
  let request;
  const fetch = async (...args) => {
    request = args;
    return { status: 200, json: async () => ({ web: { results: [] } }) };
  };

  await searchBrave('decided query', { apiKey: 'key', q: 'replacement' }, { fetch });

  assert.equal(new URL(request[0]).searchParams.get('q'), 'decided query');
});

test('Brave rejects a successful response whose JSON parser fails', async () => {
  const fetch = async () => ({ status: 200, json: async () => { throw new Error('bad json'); } });

  await assert.rejects(
    searchBrave('query', { apiKey: 'key' }, { fetch }),
    /Brave search returned an invalid response/,
  );
});

test('Brave rejects an oversized GET URL before fetching', async () => {
  let fetched = false;
  const fetch = async () => {
    fetched = true;
  };

  await assert.rejects(
    searchBrave('x'.repeat(3000), { apiKey: 'key' }, { fetch }),
    /Brave search query is too long/,
  );
  assert.equal(fetched, false);
});

test('Exa builds a POST request, passes through type, and normalizes an answer', async () => {
  let request;
  const raw = {
    results: [
      {
        title: 'Research result',
        url: 'https://example.org/paper',
        text: 'Research summary',
        publishedDate: '2026-08-20',
      },
    ],
  };
  const fetch = async (...args) => {
    request = args;
    return { ok: true, status: 201, json: async () => raw };
  };

  const answer = await searchExa(
    'battery research',
    { apiKey: 'exa-test-token', type: 'fast', numResults: 3 },
    { fetch },
  );

  assert.equal(request[0], 'https://api.exa.ai/search');
  assert.equal(request[1].method, 'POST');
  assert.equal(request[1].headers['x-api-key'], 'exa-test-token');
  assert.equal(request[1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request[1].body), {
    query: 'battery research',
    type: 'fast',
    numResults: 3,
  });
  assert.deepEqual(answer, {
    results: [
      {
        title: 'Research result',
        url: 'https://example.org/paper',
        snippet: 'Research summary',
        publishedAt: '2026-08-20',
      },
    ],
    raw,
  });
});

test('Exa names its provider and status for a non-2xx answer', async () => {
  const fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });

  await assert.rejects(
    searchExa('query', { apiKey: 'test-token', type: 'fast' }, { fetch }),
    /Exa search failed with status 401/,
  );
});

test('Exa handles malformed result entries without a TypeError', async () => {
  const raw = { results: [null, 'bad entry'] };
  const fetch = async () => ({ ok: true, status: 200, json: async () => raw });

  assert.deepEqual(await searchExa('query', { apiKey: 'test-token' }, { fetch }), {
    results: [],
    raw,
  });
});

test('Exa options cannot replace the positional query', async () => {
  let request;
  const fetch = async (...args) => {
    request = args;
    return { status: 200, json: async () => ({ results: [] }) };
  };

  await searchExa('decided query', { apiKey: 'key', query: 'replacement' }, { fetch });

  assert.equal(JSON.parse(request[1].body).query, 'decided query');
});

test('Exa rejects a successful response without a JSON method', async () => {
  const fetch = async () => ({ status: 200 });

  await assert.rejects(
    searchExa('query', { apiKey: 'key' }, { fetch }),
    /Exa search returned an invalid response/,
  );
});

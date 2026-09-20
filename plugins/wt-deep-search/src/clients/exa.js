const ENDPOINT = 'https://api.exa.ai/search';
import { requestProvider } from '../provider-failure.js';

async function readJson(response) {
  if (typeof response?.json !== 'function') {
    throw new Error('Exa search returned an invalid response');
  }

  try {
    return await response.json();
  } catch {
    throw new Error('Exa search returned an invalid response');
  }
}

export async function searchExa(query, options = {}, deps = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new TypeError('Exa search query must be a non-empty string');
  }

  const apiKey = options.apiKey;
  const searchOptions = { ...options };
  delete searchOptions.apiKey;
  delete searchOptions.query;
  const body = Object.fromEntries(
    Object.entries({ ...searchOptions, query }).filter(([, value]) => value !== undefined),
  );
  const response = await requestProvider('exa', () => deps.fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
    }), deps);

  const raw = await readJson(response);
  if (!Array.isArray(raw?.results)) {
    throw new Error('Exa search returned an invalid response');
  }
  const sourceResults = raw.results;
  const results = sourceResults
    .filter((result) => typeof result?.title === 'string' && typeof result?.url === 'string')
    .map((result) => ({
      title: result.title ?? '',
      url: result.url ?? '',
      snippet: typeof result.text === 'string'
        ? result.text
        : (typeof result.highlights?.[0] === 'string' ? result.highlights[0] : ''),
      publishedAt: typeof result.publishedDate === 'string' ? result.publishedDate : null,
    }));

  return { results, raw };
}

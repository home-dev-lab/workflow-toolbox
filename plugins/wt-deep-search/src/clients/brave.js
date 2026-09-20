const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_URL_LENGTH = 2048;
import { requestProvider } from '../provider-failure.js';

async function readJson(response) {
  if (typeof response?.json !== 'function') {
    throw new Error('Brave search returned an invalid response');
  }

  try {
    return await response.json();
  } catch {
    throw new Error('Brave search returned an invalid response');
  }
}

export async function searchBrave(query, options = {}, deps = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new TypeError('Brave search query must be a non-empty string');
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);

  for (const [name, value] of Object.entries(options)) {
    if (name !== 'apiKey' && name !== 'q' && value !== undefined && value !== null) {
      url.searchParams.set(name, String(value));
    }
  }

  if (url.toString().length > MAX_URL_LENGTH) {
    throw new RangeError('Brave search query is too long for a GET request');
  }

  const response = await requestProvider('brave', () => deps.fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': options.apiKey,
      },
    }), deps);

  const raw = await readJson(response);
  if (!Array.isArray(raw?.web?.results)) {
    throw new Error('Brave search returned an invalid response');
  }
  const sourceResults = raw.web.results;
  const results = sourceResults
    .filter((result) => typeof result?.title === 'string' && typeof result?.url === 'string')
    .map((result) => ({
      title: result.title ?? '',
      url: result.url ?? '',
      snippet: typeof result.description === 'string' ? result.description : '',
      publishedAt: typeof (result.page_age ?? result.age) === 'string'
        ? (result.page_age ?? result.age)
        : null,
    }));

  return { results, raw };
}

// The deep rungs go through Exa's SEARCH endpoint with a research `type`, never through the
// Research/Agent product.
//
// ⚠ MEASURED 2026-09-21 00:45 +01:00, with the real key: `POST https://api.exa.ai/research/v1`
// answers **410** — `{"error":"The Exa Research API has been retired and is no longer available",
// "tag":"RESEARCH_RETIRED"}`. The first version of this module was written against that endpoint
// from the card's description of it, and every one of its tests passed, because a fixture cannot
// know an endpoint is gone. The first REAL run is what found it.
//
// What the live API does, measured on three calls:
//   POST /search { query, type: 'deep-lite', outputSchema }
//     -> 200 in ~3 s, costDollars.total 0.012, results[10], output { content, grounding }
//   with outputSchema { type: 'text' }        -> output.content is prose
//   with a JSON schema                        -> output.content is that object, and it carried a
//                                                URL and a DATE for every claim
// An `effort` field is ACCEPTED AND IGNORED (same cost, same shape) — it belonged to the retired
// product, so sending it would only make a reader believe it did something.
import { requestProvider } from '../provider-failure.js';
import { buildDeepPrompt } from './prompt.js';

const ENDPOINT = 'https://api.exa.ai/search';

// Exa's six search types. `auto` is a legitimate SEARCH TYPE — the $5-per-run trap this plugin
// used to guard against was `auto` as an AGENT EFFORT, on the product that no longer exists.
const TYPES = new Set(['auto', 'fast', 'instant', 'deep-lite', 'deep', 'deep-reasoning']);

export const STRUCTURED_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          url: { type: 'string' },
          date: { type: ['string', 'null'] },
        },
        required: ['claim', 'url', 'date'],
        additionalProperties: false,
      },
    },
    unverified: { type: 'array', items: { type: 'string' } },
  },
  required: ['claims', 'unverified'],
  additionalProperties: false,
};

export function buildExaSearchRequest({ prompt, mode, outputSchema, contents }) {
  if (!TYPES.has(mode)) throw new Error(`Unknown Exa search type: ${mode}`);
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('Exa search prompt must be a non-empty string');
  }
  // ⚠ deep-reasoning without a schema returns URLs and no prose. An evening was lost to believing
  // the product could not write; the missing parameter was this one.
  if (!outputSchema || typeof outputSchema !== 'object') {
    throw new TypeError('Exa search requires an output schema');
  }
  return {
    query: prompt.trim(),
    type: mode,
    outputSchema,
    ...(contents ? { contents } : {}),
  };
}

async function readJson(response) {
  if (typeof response?.json !== 'function') throw new Error('Exa search returned an invalid response');
  try {
    return await response.json();
  } catch {
    throw new Error('Exa search returned an invalid response');
  }
}

export async function runExaDeepSearch(options, deps = {}) {
  const { mode, question, shape = 'prose', effort, apiKey, contents } = options;
  if (effort !== undefined) {
    throw new Error('Exa search takes no effort: that parameter belonged to the retired Research API');
  }
  if (typeof deps.fetch !== 'function') throw new TypeError('Exa search requires an injected fetch');

  const prompt = buildDeepPrompt({ mode, question });
  const outputSchema = shape === 'structured' ? STRUCTURED_OUTPUT_SCHEMA : { type: 'text' };
  const body = buildExaSearchRequest({ prompt, mode, outputSchema, contents });

  const response = await requestProvider('exa', () => deps.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  }), deps);

  const raw = await readJson(response);
  const content = raw?.output?.content;
  if (content === undefined || content === null) throw new Error('Exa search returned no output');
  return {
    content,
    grounding: raw?.output?.grounding ?? [],
    // The real cost of the call this run made — never a figure quoted from a price list.
    costDollars: raw?.costDollars?.total ?? null,
    results: Array.isArray(raw?.results) ? raw.results.length : 0,
  };
}

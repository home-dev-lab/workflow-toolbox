const RETRY_DELAYS_MS = [100, 250];

export class ProviderFailure extends Error {
  constructor(message, { provider, classification, status = null, resetAt = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderFailure';
    this.provider = provider;
    this.classification = classification;
    this.status = status;
    this.resetAt = resetAt;
  }
}

export function createExhaustionMemory({ now = Date.now, fallbackMs = 5 * 60_000 } = {}) {
  if (typeof now !== 'function') throw new TypeError('Exhaustion memory requires an injected clock');
  if (!Number.isFinite(fallbackMs) || fallbackMs <= 0) {
    throw new TypeError('Exhaustion fallback window must be positive');
  }

  const exhausted = new Map();

  function get(provider) {
    const entry = exhausted.get(provider);
    if (!entry) return null;
    if (now() >= entry.expiresAt) {
      exhausted.delete(provider);
      return null;
    }
    return entry.failure;
  }

  return {
    get,
    isExhausted: (provider) => get(provider) !== null,
    mark(failure) {
      if (!(failure instanceof ProviderFailure)) return;
      if (!['exhausted', 'rate-limit'].includes(failure.classification)) return;
      const currentTime = now();
      const expiresAt = Number.isFinite(failure.resetAt) && failure.resetAt > currentTime
        ? failure.resetAt
        : currentTime + fallbackMs;
      exhausted.set(failure.provider, { expiresAt, failure });
    },
  };
}

function header(response, name) {
  return typeof response?.headers?.get === 'function' ? response.headers.get(name) : null;
}

function declaredResetAt(response, now) {
  const value = header(response, 'x-ratelimit-reset')
    ?? header(response, 'ratelimit-reset')
    ?? header(response, 'retry-after');
  if (typeof value !== 'string' || !value.trim()) return null;

  const numeric = Number.parseFloat(value.split(',')[0]);
  if (Number.isFinite(numeric)) {
    if (numeric >= 1_000_000_000_000) return numeric;
    if (numeric >= 1_000_000_000) return numeric * 1_000;
    return now() + numeric * 1_000;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function errorBody(response) {
  if (typeof response?.json !== 'function') return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function classify(provider, response, body, now) {
  const statusValue = Number(response?.status);
  const status = Number.isFinite(statusValue) ? statusValue : null;
  const text = JSON.stringify(body ?? '');
  let classification = 'fatal';

  if (/OPTION_NOT_IN_PLAN/i.test(text) || /insufficient.{0,30}credits?/i.test(text)) {
    classification = 'exhausted';
  } else if (status === 429) classification = 'rate-limit';
  else if (status !== null && status >= 500) classification = 'transient';

  return new ProviderFailure(
    `${provider === 'brave' ? 'Brave' : 'Exa'} search failed with status ${status ?? 'unknown'}`,
    {
      provider,
      classification,
      status,
      resetAt: declaredResetAt(response, now),
    },
  );
}

function isSuccessful(response) {
  const status = Number(response?.status);
  return Number.isFinite(status) ? status >= 200 && status < 300 : response?.ok === true;
}

function networkFailure(provider, cause) {
  return new ProviderFailure(
    `${provider === 'brave' ? 'Brave' : 'Exa'} search failed: ${cause?.message ?? 'network failure'}`,
    { provider, classification: 'transient', cause },
  );
}

export async function requestProvider(provider, makeRequest, deps) {
  const remembered = deps.exhaustion?.get?.(provider);
  if (remembered) throw remembered;

  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const sleep = typeof deps.sleep === 'function'
    ? deps.sleep
    : (delay) => new Promise((resolve) => setTimeout(resolve, delay));

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let response;
    let failure;
    try {
      response = await makeRequest();
      if (isSuccessful(response)) return response;
      failure = classify(provider, response, await errorBody(response), now);
    } catch (error) {
      failure = error instanceof ProviderFailure ? error : networkFailure(provider, error);
    }

    const retryable = ['rate-limit', 'transient'].includes(failure.classification);
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    deps.exhaustion?.mark?.(failure);
    throw failure;
  }

  throw new Error('Unreachable provider retry state');
}

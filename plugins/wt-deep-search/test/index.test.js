import assert from 'node:assert/strict';
import test from 'node:test';

import * as providerLayer from '../src/index.js';

test('the public module exports only the provider-layer functions', () => {
  assert.deepEqual(Object.keys(providerLayer).sort(), [
    'ProviderFailure',
    'createExhaustionMemory',
    'detectProviders',
    'route',
    'searchBrave',
    'searchExa',
  ]);
});

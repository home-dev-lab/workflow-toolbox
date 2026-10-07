import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realFs } from './store-host-fake.mjs';

test('the real filesystem fake exposes only the measured host members and rejects unknown verbs', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/host-fs-surface.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(realFs).sort(), [...fixture.fs].sort());
  for (const name of [...fixture.absentDeletionVerbs, 'unrecordedVerb', 'then']) {
    assert.equal(Object.hasOwn(realFs, name), false);
    // The host leaves an absent member undefined: a presence probe, typeof or a thenable lookup must see what the host shows.
    assert.equal(realFs[name], undefined, `$.fs.${name} must read as undefined, as on the host`);
    assert.throws(() => realFs[name]('unused'), { name: 'TypeError' });
  }
});

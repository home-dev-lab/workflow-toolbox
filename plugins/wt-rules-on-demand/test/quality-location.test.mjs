import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qualityDataDir } from '../scripts/rule-lifecycle-lib.mjs';
import { qualityCheck } from '../scripts/quality-check.mjs';
import { fileURLToPath } from 'node:url';
const ownRoot = fileURLToPath(new URL('..', import.meta.url));

test('quality data path selects persistent plugin data when supplied, otherwise profile default', () => {
  assert.equal(qualityDataDir('/config', { CLAUDE_PLUGIN_DATA: '/wt-rules-on-demand-data', CLAUDE_PLUGIN_ROOT: ownRoot }), '/wt-rules-on-demand-data/quality');
  assert.equal(qualityDataDir('/config', {}), '/config/plugins/data/wt-rules-on-demand/quality');
});
test('quality reader and failure writer share plugin data location', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-quality-location-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'wt-rules-on-demand-data');
  const before = process.env.CLAUDE_PLUGIN_DATA;
  const beforeRoot = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.env.CLAUDE_PLUGIN_ROOT = ownRoot;
  try {
    await assert.rejects(() => qualityCheck({ configDirs: [join(root, 'config')], projectsDirs: [join(root, 'missing-projects')], project: join(root, 'project') }), /0 transcript files read/);
    const latest = JSON.parse(await readFile(join(data, 'quality/latest.json'), 'utf8'));
    assert.equal(latest.ok, false);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = before;
    if (beforeRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = beforeRoot;
  }
});

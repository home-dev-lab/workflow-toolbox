import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginName, resolvePluginDataDir } from './plugin-data-dir.mjs'

const root = mkdtempSync(join(tmpdir(), 'wt-plugin-data-'))
const name = pluginName()
const fallback = join(root, 'state', name)
const configDir = join(root, 'config')
const canonicalRoot = join(configDir, 'plugins', 'data', `${name}-marketplace`)
const canonical = join(canonicalRoot, name)
const installed = join(configDir, 'plugins', 'installed_plugins.json')

mkdirSync(join(configDir, 'plugins'), { recursive: true })
writeFileSync(installed, JSON.stringify({ [`${name}@marketplace`]: {} }))

assert.deepEqual(resolvePluginDataDir({ env: {}, configDir, pluginName: name, fallback }), {
  dir: canonical, source: 'installed_plugins', reason: `installed_plugins.json selects ${name}@marketplace`, pluginData: 'unset',
})
assert.equal(resolvePluginDataDir({ env: { CLAUDE_PLUGIN_DATA: join(root, 'plugins', 'data', 'codex-openai-codex') }, configDir, pluginName: name, fallback }).pluginData, 'disagrees')
assert.equal(resolvePluginDataDir({ env: { CLAUDE_PLUGIN_DATA: canonicalRoot }, configDir, pluginName: name, fallback }).pluginData, 'agrees')

const inline = join(root, 'plugins', 'data', `${name}-inline`)
assert.deepEqual(resolvePluginDataDir({ env: { CLAUDE_PLUGIN_DATA: inline }, configDir: join(root, 'no-key'), pluginName: name, fallback }), {
  dir: inline, source: 'env', reason: 'CLAUDE_PLUGIN_DATA names an uninstalled plugin session',
})
assert.equal(resolvePluginDataDir({ env: {}, configDir: join(root, 'no-key'), pluginName: name, fallback }).dir, fallback)
const inlineFallback = join(root, 'state', 'inline-legacy')
mkdirSync(inlineFallback, { recursive: true })
writeFileSync(join(inlineFallback, 'journal.ndjson'), '{}\n')
resolvePluginDataDir({ env: { CLAUDE_PLUGIN_DATA: inline }, configDir: join(root, 'no-key'), pluginName: name, fallback: inlineFallback })
assert.equal(existsSync(join(inlineFallback, 'journal.ndjson')), true)
mkdirSync(fallback, { recursive: true })
writeFileSync(join(fallback, 'journal.ndjson'), '{}\n')
assert.equal(resolvePluginDataDir({ env: {}, configDir, pluginName: name, fallback }).dir, canonical)
assert.equal(existsSync(join(canonical, 'journal.ndjson')), true)
// Carry-over, not move-once: an older installed plugin keeps writing the legacy dir until the
// owner updates it, so a later resolution carries each NEW legacy entry into the canonical dir
// (never overwriting a same-named entry, which stays in legacy for a human to reconcile).
mkdirSync(fallback, { recursive: true })
writeFileSync(join(fallback, 'second.ndjson'), '{}\n')
writeFileSync(join(fallback, 'journal.ndjson'), 'stale\n')
assert.equal(resolvePluginDataDir({ env: {}, configDir, pluginName: name, fallback }).dir, canonical)
assert.equal(existsSync(join(canonical, 'second.ndjson')), true)
assert.equal(existsSync(join(fallback, 'second.ndjson')), false)
assert.equal(existsSync(join(fallback, 'journal.ndjson')), true)
assert.notEqual(readFileSync(join(canonical, 'journal.ndjson'), 'utf8'), 'stale\n')
assert.equal(resolvePluginDataDir({ env: { XDG_STATE_HOME: join(root, 'xdg') }, configDir: join(root, 'no-key'), pluginName: name }).dir, join(root, 'xdg', name))
console.log('plugin-data-dir selftest: 11 passed')

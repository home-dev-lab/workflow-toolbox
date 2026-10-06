#!/usr/bin/env node
// Real-writer e2e for legacy carry-over: a child appends numbered rows while the parent
// repeatedly resolves plugin data, then compares written rows with legacy + canonical rows.
// All state lives in one mkdtemp root, removed only after the writer exits.
// Usage: node scripts/legacy-carryover-race-e2e.mjs [--seconds N] [--module PATH]
// Exit 0 = lossless migration/removal observed, 1 = loss/duplicates or experiment error,
// 2 = usage/module error, 3 = inconclusive (no migration or no removal observed).
// Linux, macOS and Windows (Node filesystem APIs). Windows may refuse rmdir on an open
// directory; the resolver leaves it for retry. This experiment does not hold a dir handle.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const WRITER = `
const { mkdirSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const [legacy, seconds] = process.argv.slice(1);
const acknowledged = [];
process.send('ready');
const end = Date.now() + Number(seconds) * 1000;
function batch() {
  for (let i = 0; i < 16 && Date.now() < end; i++) {
    const id = acknowledged.length;
    try {
      mkdirSync(legacy, { recursive: true });
      appendFileSync(join(legacy, 'rows-' + Math.floor(id / 16) + '.ndjson'), JSON.stringify({ id }) + '\\n');
      acknowledged.push(id);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (Date.now() < end) setTimeout(batch, 2);
  else console.log(JSON.stringify(acknowledged));
}
batch();
`

function options(args) {
  let seconds = 5
  let module = resolve(import.meta.dirname, '../../plugin/bin/lib/plugin-data-dir.mjs')
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw new Error('missing option value')
    if (args[i] === '--seconds') seconds = Number(args[i + 1])
    else if (args[i] === '--module') module = resolve(args[i + 1])
    else throw new Error(`unknown option ${args[i]}`)
  }
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('seconds must be positive')
  return { seconds, module }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-legacy-race-'))
  const configDir = join(root, 'config')
  const name = 'workflow-toolbox'
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
    [`${name}@marketplace`]: { version: '999.0.0' },
  }))
  return { root, configDir, name, legacy: join(root, 'state', name),
    canonical: join(configDir, 'plugins', 'data', `${name}-marketplace`, name) }
}

function rowsIn(dir) {
  if (!existsSync(dir)) return { ids: [], files: 0 }
  const names = readdirSync(dir)
  const ids = names.flatMap((name) => {
    const rows = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)
    return rows.map((row) => {
      const { id } = JSON.parse(row)
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('invalid row id')
      return id
    })
  })
  return { ids, files: names.length }
}

function writer(legacy, seconds) {
  const child = spawn(process.execPath, ['-e', WRITER, legacy, String(seconds)], {
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  })
  let output = ''
  let done = false
  child.stdout.on('data', (data) => { output += data })
  const ready = new Promise((accept, reject) => {
    child.once('message', accept)
    child.once('error', reject)
    child.once('exit', () => reject(new Error('writer exited before readiness')))
  })
  const exited = new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('close', (code) => { done = true; accept(code) })
  })
  return { child, ready, exited, done: () => done, written: () => JSON.parse(output.trim()) }
}

function verdict(state, written, iterations, removals) {
  if (!Array.isArray(written) || written.length === 0
    || written.some((id) => !Number.isSafeInteger(id) || id < 0)
    || new Set(written).size !== written.length) throw new Error('invalid writer acknowledgements')
  const canonical = rowsIn(state.canonical)
  const found = [...rowsIn(state.legacy).ids, ...canonical.ids]
  const expected = new Set(written)
  const surviving = new Set(found)
  const missing = written.filter((id) => !surviving.has(id)).length
  const duplicates = found.length - surviving.size
  const unexpected = [...surviving].filter((id) => !expected.has(id)).length
  console.log(`written=${written.length} found=${found.length} missing=${missing} duplicates=${duplicates} migrated_files=${canonical.files} legacy_dir_removals=${removals} iterations=${iterations}`)
  if (unexpected > 0) throw new Error(`unexpected row ids: ${unexpected}`)
  if (missing > 0 || duplicates > 0) return 1
  return canonical.files > 0 && removals > 0 ? 0 : 3
}

async function experiment(resolvePluginDataDir, seconds) {
  const state = fixture()
  const task = writer(state.legacy, seconds)
  let iterations = 0
  let removals = 0
  try {
    await task.ready
    while (!task.done()) {
      for (let i = 0; i < 100; i += 1) {
        const present = existsSync(state.legacy)
        resolvePluginDataDir({ env: {}, configDir: state.configDir, pluginName: state.name,
          fallback: state.legacy, minimumVersion: '1.0.0', stderr: { write() {} } })
        if (present && !existsSync(state.legacy)) removals++
        iterations++
      }
      await new Promise((accept) => setImmediate(accept))
    }
    if (await task.exited !== 0) throw new Error('writer failed')
    return verdict(state, task.written(), iterations, removals)
  } finally {
    if (!task.done()) task.child.kill()
    await task.exited
    rmSync(state.root, { recursive: true, force: true })
  }
}

let settings
let resolver
try {
  settings = options(process.argv.slice(2))
  resolver = (await import(pathToFileURL(settings.module).href)).resolvePluginDataDir
  if (typeof resolver !== 'function') throw new Error('module must export resolvePluginDataDir')
} catch (error) {
  console.error(`legacy-carryover-race-e2e: ${error.message}`)
  console.error('usage: legacy-carryover-race-e2e.mjs [--seconds N] [--module PATH]')
  process.exit(2)
}
try {
  process.exitCode = await experiment(resolver, settings.seconds)
} catch (error) {
  console.error(`legacy-carryover-race-e2e: ${error.message}`)
  process.exitCode = 1
}

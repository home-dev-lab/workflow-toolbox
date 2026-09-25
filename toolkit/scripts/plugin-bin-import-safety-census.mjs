import { readFileSync, readdirSync, statSync } from 'node:fs'
import path, { dirname, extname, join, relative, resolve } from 'node:path'

// Census for the "importing a plugin/bin module must never run its CLI/hook entry" invariant.
// A module under plugin/bin/ can end with an unconditional call to its own main()/entry
// function (a hook or a CLI). If a test statically imports that module — to reach a pure
// helper it also exports — the import itself executes the entry, including any stdin read.
// On a host where the test runner's stdin is an open pipe that is never closed (observed on
// hosted Windows CI), that stdin read blocks forever and the whole suite hangs.
//
// This census finds every such import, independent of a hand-maintained list, so a NEW import
// added later is covered automatically: it walks every test file this project's own vitest
// config collects, not a fixed set.

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const TOOLKIT_ROOT = resolve(import.meta.dirname, '..')
const PLUGIN_BIN = join(REPO_ROOT, 'plugin', 'bin')

// Same test roots vitest.config.mts globs (packages/*/test, packages/*/src, examples/test,
// scripts/test), walked directly rather than re-parsed from the config file.
function testFiles() {
  const roots = []
  const packagesDir = join(TOOLKIT_ROOT, 'packages')
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const sub of ['test', 'src']) {
      const dir = join(packagesDir, entry.name, sub)
      try {
        if (statSync(dir).isDirectory()) roots.push(dir)
      } catch {
        // package has no test/src subdir — nothing to walk
      }
    }
  }
  roots.push(join(TOOLKIT_ROOT, 'examples', 'test'))
  roots.push(join(TOOLKIT_ROOT, 'scripts', 'test'))

  const files = []
  function walk(directory) {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(path)
    }
  }
  for (const root of roots) walk(root)
  return files
}

// Matches both `from '...plugin/bin/...'` (ESM/TS import) and `require('...plugin/bin/...')`
// (CJS), relative-path specifiers only — a bare package import can never reach plugin/bin.
const IMPORT_RE = /(?:from\s+|require\()\s*['"]((?:\.\.\/)+plugin\/bin\/[^'"]+)['"]/g

function importedBinModules(testFile) {
  const source = readFileSync(testFile, 'utf8')
  const specifiers = new Set()
  for (const match of source.matchAll(IMPORT_RE)) specifiers.add(match[1])
  const resolved = []
  for (const specifier of specifiers) {
    const absolute = resolve(dirname(testFile), specifier)
    resolved.push(absolute)
  }
  return resolved
}

// The census answers "which files a test statically imports", so it is restricted to modules
// that can actually be imported as JS: .mjs/.js/.cjs. A specifier resolving to anything else
// (there are none today) would not be import-safe to begin with and is out of this census's
// scope.
const IMPORTABLE_EXT = new Set(['.mjs', '.js', '.cjs'])

export function isWithinPluginBin(modulePath, pluginBin = PLUGIN_BIN, pathApi = path) {
  const fromRoot = pathApi.relative(pluginBin, modulePath)
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(fromRoot)
}

export function census() {
  const found = new Set()
  for (const testFile of testFiles()) {
    for (const modulePath of importedBinModules(testFile)) {
      if (!isWithinPluginBin(modulePath)) continue
      if (!IMPORTABLE_EXT.has(extname(modulePath))) continue
      found.add(modulePath)
    }
  }
  return [...found].sort().map((absolute) => ({
    absolute,
    relative: relative(REPO_ROOT, absolute),
  }))
}

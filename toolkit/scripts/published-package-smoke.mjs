#!/usr/bin/env node
// published-package-smoke.mjs — pack a workspace package the way npm will publish it, install
// that tarball into a clean directory, and LOAD every entry point it advertises.
//
// WHY THIS EXISTS, and why it is NOT part of `pnpm test`.
//
// The suite already asserts two things about the published shape: that no shipped `.d.ts`
// imports something absent from the package's runtime dependencies, and that the CLI bundle
// loads in a sandbox reproducing a consumer's module resolution. Both are offline and
// deterministic, and both work from the SOURCE manifest.
//
// Neither can see a defect that exists only in what npm actually serves:
//   - a dependency range that resolves here and not from the registry;
//   - a file the code needs and `files`/`publishConfig` excludes from the tarball;
//   - a wrong `publishConfig` — the sandbox READS it, so it reproduces the error faithfully;
//   - a transitive dependency present in the workspace and absent for a consumer.
//
// Each ships silently and surfaces at an adopter's install. One of that class was found by hand
// on 2026-08-18 (@workflow-toolbox/build shipped a declaration importing a devDependency); it had
// no automated detector at any stage, which is what this script is.
//
// ⚠ It needs the NETWORK, because that is the whole point: `npm install <tarball>` resolves the
// package's declared dependencies from the registry. That is exactly why it must not be wired into
// `pnpm test` — a suite that needs egress breaks offline, breaks on a runner without it, and turns
// a red into "npm was slow". Same reasoning this repo already applies to the adopt-overlap audit.
// It belongs in the pre-release checklist, run deliberately, before a publish.
//
// Usage:  node scripts/published-package-smoke.mjs [<package-dir> ...]
//         (default: every non-private package under packages/ that has a CHANGELOG.md)
// Exit:   0 all packages loaded · 1 at least one failed · 2 usage/setup error

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = path.join(TOOLKIT, 'packages')

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** A CHANGELOG is this repo's release anchor: a public package without one has never shipped. */
function releasedPackageDirs() {
  return fs
    .readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(PACKAGES, e.name))
    .filter((dir) => {
      if (!fs.existsSync(path.join(dir, 'package.json'))) return false
      const m = readJson(path.join(dir, 'package.json'))
      return m.private !== true && fs.existsSync(path.join(dir, 'CHANGELOG.md'))
    })
}

/** Every subpath a consumer may import, from the manifest npm will actually publish. */
function entrySubpaths(manifest) {
  const published = manifest.publishConfig ?? {}
  const exports = published.exports ?? manifest.exports
  if (exports && typeof exports === 'object') {
    const keys = Object.keys(exports).filter((k) => k.startsWith('.'))
    if (keys.length > 0) return keys
  }
  return ['.']
}

function smokeOne(dir) {
  const manifest = readJson(path.join(dir, 'package.json'))
  const name = manifest.name
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-publish-smoke-'))
  const consumer = path.join(root, 'consumer')
  fs.mkdirSync(consumer, { recursive: true })

  // pnpm pack, never npm pack: only pnpm applies publishConfig, and without it the tarball keeps
  // `workspace:*` ranges that no consumer can install.
  execFileSync('pnpm', ['pack', '--pack-destination', root], { cwd: dir, stdio: 'pipe' })
  const tarball = fs.readdirSync(root).find((f) => f.endsWith('.tgz'))
  if (!tarball) throw new Error(`pnpm pack produced no tarball for ${name}`)

  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'publish-smoke-consumer', private: true, type: 'module', version: '1.0.0' }, null, 2),
  )
  // ⚠ An install failure is a FINDING about the package, not a broken harness — a dependency range
  // the registry cannot satisfy fails exactly here. Labelling it "setup" would send the reader
  // looking at this script instead of at the manifest, which is the failure class this check exists
  // to catch in the first place.
  try {
    execFileSync('npm', ['install', path.join(root, tarball)], { cwd: consumer, stdio: 'pipe' })
  } catch (err) {
    const detail = String(err.stderr ?? err.message)
    const line = detail.split('\n').find((l) => /notarget|ETARGET|No matching version|404/i.test(l)) ?? detail.split('\n')[0]
    return {
      name,
      version: manifest.version,
      entries: 0,
      failures: [{ spec: '<install>', reason: `a consumer cannot install this package: ${line.trim().slice(0, 200)}` }],
      sandbox: root,
    }
  }

  const failures = []
  for (const sub of entrySubpaths(manifest)) {
    const spec = sub === '.' ? name : `${name}/${sub.replace(/^\.\//, '')}`
    try {
      execFileSync(process.execPath, ['-e', `import(${JSON.stringify(spec)}).then(()=>{},e=>{console.error(e.message);process.exit(1)})`], {
        cwd: consumer,
        stdio: 'pipe',
      })
    } catch (err) {
      failures.push({ spec, reason: String(err.stderr ?? err.message).slice(0, 300) })
    }
  }
  return { name, version: manifest.version, entries: entrySubpaths(manifest).length, failures, sandbox: root }
}

// ⚠ A precondition that must NAME ITS REMEDY. `pnpm pack` runs each package's `prepack`, which
// builds it — so without an installed workspace the failure surfaces as `tsup: not found`, which
// sends the reader looking for a missing tool rather than a missing install.
function requireInstalledWorkspace() {
  if (fs.existsSync(path.join(TOOLKIT, 'node_modules'))) return
  console.error('published-package-smoke: the workspace is not installed, so `pnpm pack` cannot run')
  console.error('                         each package\'s prepack builds it, and the build tools live in node_modules')
  console.error(`                         fix: cd ${TOOLKIT} && pnpm install`)
  process.exit(2)
}
requireInstalledWorkspace()

const args = process.argv.slice(2)
const targets = args.length > 0 ? args.map((a) => path.resolve(a)) : releasedPackageDirs()
if (targets.length === 0) {
  console.error('published-package-smoke: no released packages found')
  process.exit(2)
}

let bad = 0
for (const dir of targets) {
  let r
  try {
    r = smokeOne(dir)
  } catch (err) {
    console.error(`FAIL  ${path.basename(dir)} — setup: ${String(err.message).slice(0, 200)}`)
    bad++
    continue
  }
  if (r.failures.length === 0) {
    console.log(`ok    ${r.name}@${r.version} — ${r.entries} entry point(s) loaded from a clean install`)
  } else {
    bad++
    console.error(
      r.entries === 0
        ? `FAIL  ${r.name}@${r.version} — could not be installed at all`
        : `FAIL  ${r.name}@${r.version} — ${r.failures.length} of ${r.entries} entry point(s) failed`,
    )
    for (const f of r.failures) console.error(`        ${f.spec}: ${f.reason.split('\n')[0]}`)
    console.error(`        sandbox kept for inspection: ${r.sandbox}`)
  }
}
console.log(bad === 0 ? 'published-package-smoke: all packages load' : `published-package-smoke: ${bad} package(s) failed`)
process.exit(bad === 0 ? 0 : 1)

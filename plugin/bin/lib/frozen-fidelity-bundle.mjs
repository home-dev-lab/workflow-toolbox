// Mechanical receipt freezer. It validates bytes and identity only; Main judges claims.
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { treeSignature } from './gate-evidence.mjs'

const MANIFEST = 'fidelity-manifest.json'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function safeName(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\0') && !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function within(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function receiptFields(name, bytes) {
  const text = bytes.toString('utf8')
  const lane = /^\.lane\/([^/]+)-run\.log$/.exec(name)
  const report = /^\.lane\/(pilot|[^/]+-report)\.md$/.exec(name)
  const gate = /^\.lane\/([^/]+)\.log$/.exec(name)
  if (lane) {
    const exit = /^EXIT=([^\r\n]+)$/m.exec(text.split(/\r?\n/).filter(Boolean).at(-1) ?? '')?.[1]
    if (!exit) throw new Error(`lane receipt lacks terminal EXIT=: ${name}`)
    return { kind: 'lane', phase: lane[1], exit }
  }
  if (report) return { kind: 'report', phase: report[1] === 'pilot' ? 'pilot' : report[1].slice(0, -'-report'.length) }
  if (name === '.lane/summary.json') {
    let summary
    try { summary = JSON.parse(text) } catch { throw new Error(`invalid commit summary: ${name}`) }
    if (typeof summary?.commit !== 'string' || summary.commit.length === 0) throw new Error(`commit summary lacks head: ${name}`)
    return { kind: 'commit', head: summary.commit }
  }
  if (gate) {
    const exit = /^EXIT=([^\r\n]+)$/m.exec(text.split(/\r?\n/).filter(Boolean).at(-1) ?? '')?.[1]
    if (!exit) throw new Error(`gate receipt lacks terminal EXIT=: ${name}`)
    // The entry's required name is its root-relative receipt path; its basename identifies the gate.
    return { kind: 'gate', exit }
  }
  return { kind: 'other' }
}

function signature(files) {
  const fields = files.map((file) => `${Buffer.byteLength(file.name)}\n${file.name}\n${Buffer.byteLength(file.sha256)}\n${file.sha256}\n`).sort()
  return sha256(fields.join(''))
}

function gitHead(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function readEntry(root, name, snapshot) {
  const rootReal = fs.realpathSync(root)
  const parentReal = fs.realpathSync(path.dirname(path.join(root, name)))
  if (!within(rootReal, parentReal)) throw new Error(`fidelity bundle input escapes root: ${name}`)
  const source = path.join(parentReal, path.basename(name))
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(source)
    const resolved = fs.realpathSync(path.resolve(parentReal, target))
    if (!within(rootReal, resolved)) throw new Error(`fidelity bundle symlink escapes root: ${name}`)
    return { name, kind: 'symlink', target, sha256: sha256(target), snapshot }
  }
  if (!stat.isFile()) throw new Error(`fidelity bundle refuses non-file input: ${name}`)
  const bytes = fs.readFileSync(source)
  return { name, sha256: sha256(bytes), bytes: bytes.length, snapshot, ...receiptFields(name, bytes) }
}

function validEntry(file, snapshot) {
  return file && safeName(file.name) && file.snapshot === snapshot && typeof file.kind === 'string' && typeof file.sha256 === 'string'
}

export function freezeFidelityBundle({ root, outDir, card, session, base, head, files }) {
  if (!card || !session || !base || !head) throw new Error('fidelity bundle requires card, session, base, and head')
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => !safeName(file)) || new Set(files).size !== files.length) throw new Error('fidelity bundle files must be unique safe relative names')
  fs.mkdirSync(outDir, { recursive: true })
  const snapshot = randomUUID()
  const entries = [...files].sort().map((name) => readEntry(root, name, snapshot))
  for (const entry of entries) {
    if (entry.kind === 'symlink') continue
    const bytes = fs.readFileSync(path.join(root, entry.name))
    const target = path.join(outDir, entry.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes, { flag: 'wx' })
  }
  const manifest = { version: 2, card, session, base, head, tree: treeSignature(root), snapshot, dirty: true, files: entries, signature: signature(entries) }
  fs.writeFileSync(path.join(outDir, MANIFEST), canonicalJson(manifest), { flag: 'wx' })
  return manifest
}

export function verifyFidelityBundle({ root, dir, requireCleanTree = false, requireHead = false }) {
  const manifestPath = path.join(dir, MANIFEST)
  const raw = fs.readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw)
  if (canonicalJson(manifest) !== raw) throw new Error('fidelity manifest is not canonical JSON')
  if (manifest?.version !== 2 || !manifest.card || !manifest.session || !manifest.base || !manifest.head || typeof manifest.snapshot !== 'string' || !Array.isArray(manifest.files) || typeof manifest.signature !== 'string') throw new Error('invalid fidelity manifest')
  if (manifest.signature !== signature(manifest.files)) throw new Error('fidelity bundle signature mismatch')
  const expected = new Set([MANIFEST, ...manifest.files.filter((file) => file.kind !== 'symlink').map((file) => file.name)])
  const actual = new Set()
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error(`unsafe fidelity bundle entry: ${name}`)
      if (entry.isDirectory()) walk(name)
      else actual.add(name)
    }
  }
  walk()
  if (actual.size !== expected.size || [...actual].some((name) => !expected.has(name))) throw new Error('fidelity bundle has missing or extra files')
  for (const file of manifest.files) {
    if (!validEntry(file, manifest.snapshot)) throw new Error(`invalid fidelity manifest entry: ${file?.name ?? 'unknown'}`)
    if (file.kind === 'symlink') {
      const current = readEntry(root, file.name, manifest.snapshot)
      if (current.kind !== 'symlink' || current.target !== file.target || current.sha256 !== file.sha256) throw new Error(`fidelity bundle symlink mismatch: ${file.name}`)
      continue
    }
    const bytes = fs.readFileSync(path.join(dir, file.name))
    const current = { name: file.name, sha256: sha256(bytes), bytes: bytes.length, snapshot: manifest.snapshot, ...receiptFields(file.name, bytes) }
    if (canonicalJson(current) !== canonicalJson(file)) throw new Error(`fidelity bundle entry mismatch: ${file.name}`)
  }
  if (requireCleanTree && treeSignature(root) !== manifest.tree) throw new Error('fidelity bundle tree identity no longer matches root')
  if (requireHead && gitHead(root) !== manifest.head) throw new Error('fidelity bundle head identity no longer matches root')
  return manifest
}

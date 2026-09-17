// Mechanical receipt freezer. It validates bytes and identity only; Main judges claims.
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { treeSignature } from './gate-evidence.mjs'
import { PHASES } from './lifecycle-state-machine.mjs'

const MANIFEST = 'fidelity-manifest.json'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const GATES = new Set(['typecheck', 'lint', 'test'])
const LIFECYCLE_PHASES = new Set(PHASES)
const INTEGER_EXIT = /^-?\d+$/

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

function recognizedKind(name) {
  const lane = /^\.lane\/([^/]+)-run\.log$/.exec(name)
  const report = /^\.lane\/(pilot-report|[^/]+-report)\.md$/.exec(name)
  const gate = /^\.lane\/(typecheck|lint|test)\.log$/.exec(name)
  if (lane && LIFECYCLE_PHASES.has(lane[1])) return 'lane'
  if (report) {
    const phase = report[1] === 'pilot-report' ? 'report' : report[1].slice(0, -'-report'.length)
    if (LIFECYCLE_PHASES.has(phase)) return 'report'
  }
  if (name === '.lane/summary.json') return 'commit'
  if (gate) return 'gate'
  return null
}

function classifyName(name, otherFiles = new Set()) {
  const kind = recognizedKind(name)
  if (kind) return kind
  if (otherFiles.has(name)) return 'other'
  throw new Error(`unknown fidelity bundle input: ${name}`)
}

function receiptFields(name, bytes, otherFiles = new Set()) {
  const text = bytes.toString('utf8')
  const kind = classifyName(name, otherFiles)
  const lane = /^\.lane\/([^/]+)-run\.log$/.exec(name)
  const report = /^\.lane\/(pilot-report|[^/]+-report)\.md$/.exec(name)
  if (kind === 'lane') {
    const exit = /^EXIT=([^\r\n]+)$/m.exec(text.split(/\r?\n/).filter(Boolean).at(-1) ?? '')?.[1]
    if (!LIFECYCLE_PHASES.has(lane[1])) throw new Error(`unknown fidelity bundle input: ${name}`)
    if (!exit || !INTEGER_EXIT.test(exit)) throw new Error(`lane receipt lacks integer terminal EXIT=: ${name}`)
    return { kind: 'lane', phase: lane[1], exit }
  }
  if (kind === 'report') {
    const phase = report[1] === 'pilot-report' ? 'report' : report[1].slice(0, -'-report'.length)
    if (!LIFECYCLE_PHASES.has(phase)) throw new Error(`unknown fidelity bundle input: ${name}`)
    return { kind: 'report', phase }
  }
  if (kind === 'commit') {
    let summary
    try { summary = JSON.parse(text) } catch { throw new Error(`invalid commit summary: ${name}`) }
    if (typeof summary?.commit !== 'string' || summary.commit.length === 0) throw new Error(`commit summary lacks head: ${name}`)
    return { kind: 'commit', head: summary.commit }
  }
  if (kind === 'gate') {
    const exit = /^EXIT=([^\r\n]+)$/m.exec(text.split(/\r?\n/).filter(Boolean).at(-1) ?? '')?.[1]
    if (!exit || !INTEGER_EXIT.test(exit)) throw new Error(`gate receipt lacks integer terminal EXIT=: ${name}`)
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

function validBase(root, base) {
  if (typeof base !== 'string' || !/^[a-f0-9]{40}$/.test(base)) throw new Error('fidelity bundle base must be a full 40-hex commit SHA')
  try {
    execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: root, stdio: 'ignore' })
  } catch {
    throw new Error(`fidelity bundle base commit does not exist in repository: ${base}`)
  }
}

function readEntry(root, name, snapshot, otherFiles = new Set()) {
  const rootReal = fs.realpathSync(root)
  const parentReal = fs.realpathSync(path.dirname(path.join(root, name)))
  if (!within(rootReal, parentReal)) throw new Error(`fidelity bundle input escapes root: ${name}`)
  const source = path.join(parentReal, path.basename(name))
  const stat = fs.lstatSync(source)
  const evidence = classifyName(name, otherFiles)
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(source)
    const resolved = fs.realpathSync(path.resolve(parentReal, target))
    if (!within(rootReal, resolved)) throw new Error(`fidelity bundle symlink escapes root: ${name}`)
    return { name, kind: 'symlink', evidence, target, sha256: sha256(target), snapshot }
  }
  if (!stat.isFile()) throw new Error(`fidelity bundle refuses non-file input: ${name}`)
  const bytes = fs.readFileSync(source)
  return { name, sha256: sha256(bytes), bytes: bytes.length, snapshot, ...receiptFields(name, bytes, otherFiles) }
}

const ENTRY_FIELDS = {
  gate: ['bytes', 'exit', 'kind', 'name', 'sha256', 'snapshot'],
  lane: ['bytes', 'exit', 'kind', 'name', 'phase', 'sha256', 'snapshot'],
  report: ['bytes', 'kind', 'name', 'phase', 'sha256', 'snapshot'],
  commit: ['bytes', 'head', 'kind', 'name', 'sha256', 'snapshot'],
  symlink: ['evidence', 'kind', 'name', 'sha256', 'snapshot', 'target'],
  other: ['bytes', 'kind', 'name', 'sha256', 'snapshot'],
}

function validEntry(file, snapshot) {
  const fields = file && ENTRY_FIELDS[file.kind]
  if (!fields || Object.keys(file).sort().join('\0') !== fields.join('\0')) return false
  if (!safeName(file.name) || file.snapshot !== snapshot || !/^[a-f0-9]{64}$/.test(file.sha256)) return false
  if (file.kind === 'symlink') return typeof file.target === 'string' && file.evidence === (recognizedKind(file.name) ?? 'other')
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) return false
  if (file.kind === 'gate') return GATES.has(path.basename(file.name, '.log')) && file.name === `.lane/${path.basename(file.name)}` && typeof file.exit === 'string' && INTEGER_EXIT.test(file.exit)
  if (file.kind === 'lane') return typeof file.phase === 'string' && LIFECYCLE_PHASES.has(file.phase) && file.name === `.lane/${file.phase}-run.log` && typeof file.exit === 'string' && INTEGER_EXIT.test(file.exit)
  if (file.kind === 'report') return typeof file.phase === 'string' && LIFECYCLE_PHASES.has(file.phase) && file.name === (file.phase === 'report' ? '.lane/pilot-report.md' : `.lane/${file.phase}-report.md`)
  if (file.kind === 'commit') return typeof file.head === 'string' && file.head.length > 0
  return file.kind === 'other'
}

export function freezeFidelityBundle({ root, outDir, card, session, base, head, files, otherFiles = [] }) {
  if ([card, session, base, head].some((value) => typeof value !== 'string' || value.length === 0)) throw new Error('fidelity bundle requires card, session, base, and head as non-empty strings')
  validBase(root, base)
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => !safeName(file)) || new Set(files).size !== files.length) throw new Error('fidelity bundle files must be unique safe relative names')
  if (!Array.isArray(otherFiles) || otherFiles.some((file) => !files.includes(file))) throw new Error('fidelity bundle otherFiles must name explicit inputs')
  fs.mkdirSync(outDir, { recursive: true })
  const snapshot = randomUUID()
  const explicitOther = new Set(otherFiles)
  const entries = [...files].sort().map((name) => readEntry(root, name, snapshot, explicitOther))
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

export function verifyFidelityBundle({ root, dir, requireSameTree = false, requireCleanTree = false, requireHead = false }) {
  const manifestPath = path.join(dir, MANIFEST)
  const raw = fs.readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw)
  if (canonicalJson(manifest) !== raw) throw new Error('fidelity manifest is not canonical JSON')
  if (manifest?.version !== 2 || [manifest.card, manifest.session, manifest.base, manifest.head, manifest.tree, manifest.snapshot, manifest.signature].some((value) => typeof value !== 'string' || value.length === 0) || typeof manifest.dirty !== 'boolean' || !Array.isArray(manifest.files)) throw new Error('invalid fidelity manifest')
  validBase(root, manifest.base)
  const names = manifest.files.map((file) => file?.name)
  if (new Set(names).size !== names.length) throw new Error('duplicate fidelity manifest entry name')
  for (const file of manifest.files) {
    if (!validEntry(file, manifest.snapshot)) throw new Error(`invalid fidelity manifest entry: ${file?.name ?? 'unknown'}`)
    if (file.kind === 'commit' && file.head !== manifest.head) throw new Error(`fidelity commit head differs from manifest head: ${file.name}`)
  }
  if (manifest.signature !== signature(manifest.files)) throw new Error('fidelity bundle signature mismatch')
  const expected = new Set([MANIFEST, ...manifest.files.filter((file) => file.kind !== 'symlink').map((file) => file.name)])
  const actual = new Set()
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name).replaceAll('\\', '/')
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error(`unsafe fidelity bundle entry: ${name}`)
      if (entry.isDirectory()) walk(name)
      else actual.add(name)
    }
  }
  walk()
  if (actual.size !== expected.size || [...actual].some((name) => !expected.has(name))) throw new Error('fidelity bundle has missing or extra files')
  for (const file of manifest.files) {
    if (file.kind === 'symlink') {
      const current = readEntry(root, file.name, manifest.snapshot, file.evidence === 'other' ? new Set([file.name]) : new Set())
      if (canonicalJson(current) !== canonicalJson(file)) throw new Error(`fidelity bundle symlink mismatch: ${file.name}`)
      continue
    }
    const bytes = fs.readFileSync(path.join(dir, file.name))
    const current = { name: file.name, sha256: sha256(bytes), bytes: bytes.length, snapshot: manifest.snapshot, ...receiptFields(file.name, bytes, file.kind === 'other' ? new Set([file.name]) : new Set()) }
    if (canonicalJson(current) !== canonicalJson(file)) throw new Error(`fidelity bundle entry mismatch: ${file.name}`)
  }
  if ((requireSameTree || requireCleanTree) && treeSignature(root) !== manifest.tree) throw new Error('fidelity bundle tree identity no longer matches root')
  if (requireHead && gitHead(root) !== manifest.head) throw new Error('fidelity bundle head identity no longer matches root')
  return manifest
}

// Mechanical receipt freezer. It deliberately validates bytes and identity only; Main judges claims.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { treeSignature } from './gate-evidence.mjs'

const MANIFEST = 'fidelity-manifest.json'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function safeName(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\0') && !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..')
}

export function freezeFidelityBundle({ root, outDir, card, session, base, head, files }) {
  if (!card || !session || !base || !head) throw new Error('fidelity bundle requires card, session, base, and head')
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => !safeName(file))) throw new Error('fidelity bundle files must be safe relative names')
  fs.mkdirSync(outDir, { recursive: true })
  const entries = []
  for (const name of [...files].sort()) {
    const source = path.join(root, name)
    const stat = fs.lstatSync(source)
    if (!stat.isFile()) throw new Error(`fidelity bundle refuses non-file input: ${name}`)
    const bytes = fs.readFileSync(source)
    const target = path.join(outDir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes, { flag: 'wx' })
    entries.push({ name, sha256: sha256(bytes), bytes: bytes.length })
  }
  const manifest = { version: 1, card, session, base, head, tree: treeSignature(root), dirty: true, files: entries }
  fs.writeFileSync(path.join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  return manifest
}

export function verifyFidelityBundle({ root, dir }) {
  const manifestPath = path.join(dir, MANIFEST)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest?.version !== 1 || !manifest.card || !manifest.session || !manifest.base || !manifest.head || !Array.isArray(manifest.files)) throw new Error('invalid fidelity manifest')
  const expected = new Set([MANIFEST, ...manifest.files.map((file) => file.name)])
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
    if (!safeName(file.name)) throw new Error(`unsafe fidelity manifest path: ${file.name}`)
    const bytes = fs.readFileSync(path.join(dir, file.name))
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`fidelity bundle hash mismatch: ${file.name}`)
  }
  if (treeSignature(root) !== manifest.tree) throw new Error('fidelity bundle tree identity no longer matches root')
  return manifest
}

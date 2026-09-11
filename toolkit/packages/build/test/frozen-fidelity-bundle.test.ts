import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error plugin runtime helper
import { freezeFidelityBundle, verifyFidelityBundle } from '../../../../plugin/bin/lib/frozen-fidelity-bundle.mjs'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-fidelity-')); roots.push(root)
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  mkdirSync(join(root, '.lane'), { recursive: true })
  writeFileSync(join(root, '.lane', 'typecheck.log'), 'typecheck\nEXIT=0\n')
  writeFileSync(join(root, '.lane', 'tdd-run.log'), 'lane\nEXIT=0\n')
  writeFileSync(join(root, '.lane', 'tdd-report.md'), '## Implemented\n- lock\n')
  writeFileSync(join(root, '.lane', 'pilot-report.md'), '## Implemented\n- final\n')
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD').stdout.trim()
  writeFileSync(join(root, '.lane', 'summary.json'), JSON.stringify({ commit: head }))
  const bundle = mkdtempSync(join(tmpdir(), 'wt-fidelity-bundle-')); roots.push(bundle)
  const files = ['.lane/typecheck.log', '.lane/tdd-run.log', '.lane/tdd-report.md', '.lane/pilot-report.md', '.lane/summary.json']
  const manifest = freezeFidelityBundle({ root, outDir: bundle, card: '186', session: 'sdk-1', base: 'base', head, files })
  return { root, bundle, manifest, files, git }
}

function writeManifest(bundle: string, manifest: unknown) {
  writeFileSync(join(bundle, 'fidelity-manifest.json'), canonical(manifest))
}

it('round-trips canonical typed fidelity evidence', () => {
  const { root, bundle, manifest } = fixture()
  expect(readFileSync(join(bundle, 'fidelity-manifest.json'), 'utf8')).toBe(canonical(manifest))
  expect(manifest.files.map((file: { kind: string }) => file.kind)).toEqual(['report', 'commit', 'report', 'lane', 'gate'])
  expect(verifyFidelityBundle({ root, dir: bundle, requireCleanTree: true, requireHead: true })).toMatchObject({ card: '186', session: 'sdk-1' })
})

it('B1 lock: refuses a typed entry whose fields no longer match its receipt', () => {
  const { root, bundle } = fixture()
  const manifest = JSON.parse(readFileSync(join(bundle, 'fidelity-manifest.json'), 'utf8'))
  manifest.files.find((file: { kind: string }) => file.kind === 'gate').kind = 'report'
  writeManifest(bundle, manifest)
  expect(() => verifyFidelityBundle({ root, dir: bundle })).toThrow('invalid fidelity manifest entry')
})

it.each([
  ['unknown kind', (manifest: { files: Array<Record<string, unknown>> }) => { manifest.files[0]!.kind = 'invented' }, 'invalid fidelity manifest entry'],
  ['extra field', (manifest: { files: Array<Record<string, unknown>> }) => { manifest.files[0]!.extra = true }, 'invalid fidelity manifest entry'],
  ['duplicate name', (manifest: { files: Array<Record<string, unknown>> }) => { manifest.files[1]!.name = manifest.files[0]!.name }, 'duplicate fidelity manifest entry name'],
  ['commit head mismatch', (manifest: { files: Array<Record<string, unknown>> }) => { manifest.files.find((file) => file.kind === 'commit')!.head = 'different' }, 'commit head differs from manifest head'],
])('H4 schema lock: refuses %s', (_name, mutate, expected) => {
  const { root, bundle } = fixture()
  const manifest = JSON.parse(readFileSync(join(bundle, 'fidelity-manifest.json'), 'utf8'))
  mutate(manifest)
  manifest.signature = manifest.signature
  writeManifest(bundle, manifest)
  expect(() => verifyFidelityBundle({ root, dir: bundle })).toThrow(expected)
})

it('refuses unknown freeze inputs unless explicitly classified as other', () => {
  const { root, manifest } = fixture()
  writeFileSync(join(root, '.lane', 'notes.txt'), 'notes\n')
  const refused = mkdtempSync(join(tmpdir(), 'wt-fidelity-refused-')); roots.push(refused)
  expect(() => freezeFidelityBundle({ root, outDir: refused, card: '186', session: 'sdk-1', base: 'base', head: manifest.head, files: ['.lane/notes.txt'] })).toThrow('unknown fidelity bundle input')
  const accepted = mkdtempSync(join(tmpdir(), 'wt-fidelity-other-')); roots.push(accepted)
  expect(freezeFidelityBundle({ root, outDir: accepted, card: '186', session: 'sdk-1', base: 'base', head: manifest.head, files: ['.lane/notes.txt'], otherFiles: ['.lane/notes.txt'] }).files[0].kind).toBe('other')
})

it('B2 lock: refuses an entry from another snapshot', () => {
  const { root, bundle } = fixture()
  const manifest = JSON.parse(readFileSync(join(bundle, 'fidelity-manifest.json'), 'utf8'))
  manifest.files[0].snapshot = 'another-snapshot'
  writeManifest(bundle, manifest)
  expect(() => verifyFidelityBundle({ root, dir: bundle })).toThrow('invalid fidelity manifest entry')
})

it('B3 lock: refuses swapped names even when the manifest remains canonical', () => {
  const { root, bundle } = fixture()
  const manifest = JSON.parse(readFileSync(join(bundle, 'fidelity-manifest.json'), 'utf8'))
  const first = manifest.files[0].name
  manifest.files[0].name = manifest.files[1].name
  manifest.files[1].name = first
  writeManifest(bundle, manifest)
  expect(() => verifyFidelityBundle({ root, dir: bundle })).toThrow('signature mismatch')
})

it('B4 lock: records a contained link and refuses an escaping input link without reading it', () => {
  const { root, files } = fixture()
  symlinkSync('typecheck.log', join(root, '.lane', 'inside.log'))
  const contained = mkdtempSync(join(tmpdir(), 'wt-fidelity-contained-')); roots.push(contained)
  const manifest = freezeFidelityBundle({ root, outDir: contained, card: '186', session: 'sdk-1', base: 'base', head: readFileSync(join(root, '.lane', 'summary.json'), 'utf8').match(/[a-f0-9]{40,64}/)![0], files: [...files, '.lane/inside.log'] })
  expect(manifest.files.find((file: { name: string }) => file.name === '.lane/inside.log')).toMatchObject({ kind: 'symlink', target: 'typecheck.log' })
  expect(verifyFidelityBundle({ root, dir: contained })).toBeTruthy()
  symlinkSync('/etc/passwd', join(root, '.lane', 'outside.log'))
  const escaped = mkdtempSync(join(tmpdir(), 'wt-fidelity-escaped-')); roots.push(escaped)
  expect(() => freezeFidelityBundle({ root, outDir: escaped, card: '186', session: 'sdk-1', base: 'base', head: 'head', files: ['.lane/outside.log'] })).toThrow('symlink escapes root: .lane/outside.log')
})

it('only enforces tree and head identity when their verify flags are requested', () => {
  const { root, bundle, git } = fixture()
  writeFileSync(join(root, 'changed.txt'), 'changed\n')
  expect(verifyFidelityBundle({ root, dir: bundle })).toBeTruthy()
  expect(() => verifyFidelityBundle({ root, dir: bundle, requireCleanTree: true })).toThrow('tree identity no longer matches root')
  git('add', 'changed.txt'); git('commit', '-qm', 'changed')
  expect(() => verifyFidelityBundle({ root, dir: bundle, requireHead: true })).toThrow('head identity no longer matches root')
})

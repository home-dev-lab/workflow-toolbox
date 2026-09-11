import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error plugin runtime helper
import { freezeFidelityBundle, verifyFidelityBundle } from '../../../../plugin/bin/lib/frozen-fidelity-bundle.mjs'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it('freezes and rejects changed, extra, and symlinked fidelity evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-fidelity-')); roots.push(root)
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  mkdirSync(join(root, '.lane'), { recursive: true }); writeFileSync(join(root, '.lane', 'report.md'), '## Implemented\n- lock\n')
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
  const bundle = mkdtempSync(join(tmpdir(), 'wt-fidelity-bundle-')); roots.push(bundle)
  freezeFidelityBundle({ root, outDir: bundle, card: '186', session: 'sdk-1', base: 'base', head: 'head', files: ['.lane/report.md'] })
  expect(verifyFidelityBundle({ root, dir: bundle })).toMatchObject({ card: '186', session: 'sdk-1' })
  writeFileSync(join(bundle, '.lane', 'report.md'), 'tampered\n')
  expect(() => verifyFidelityBundle({ root, dir: bundle })).toThrow('hash mismatch')
})

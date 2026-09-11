import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const REPO_ROOT = new URL('../../../..', import.meta.url).pathname
const CLI = join(REPO_ROOT, 'plugin/bin/wt-pilot-fidelity.mjs')

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-pilot-fidelity-root-')); roots.push(root)
  const bundle = mkdtempSync(join(tmpdir(), 'wt-pilot-fidelity-bundle-')); rmSync(bundle, { recursive: true }); roots.push(bundle)
  mkdirSync(join(root, '.lane'), { recursive: true })
  writeFileSync(join(root, '.lane', 'pilot-report.md'), '## Implemented\n- receipt\n')
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  const head = git('rev-parse', 'HEAD').stdout.trim()
  const freeze = run(['freeze', '--root', root, '--out-dir', bundle, '--card', '186', '--session', 'sdk-1', '--base', 'base', '--head', head, '--file', '.lane/pilot-report.md'])
  expect(freeze.status, freeze.stderr).toBe(0)
  return { root, bundle, run }
}

describe('wt-pilot-fidelity CLI', () => {
  it('freezes then verifies a lane receipt bundle', () => {
    const { root, bundle, run } = fixture()
    const result = run(['verify', '--root', root, '--dir', bundle, '--require-clean-tree', '--require-head'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('VERIFIED card=186 session=sdk-1 files=1')
  })

  it.each([
    ['tampered', (bundle: string) => writeFileSync(join(bundle, '.lane', 'pilot-report.md'), 'altered\n')],
    ['missing', (bundle: string) => unlinkSync(join(bundle, '.lane', 'pilot-report.md'))],
    ['extra', (bundle: string) => writeFileSync(join(bundle, 'extra.log'), 'unexpected\n')],
    ['symlinked', (bundle: string) => { unlinkSync(join(bundle, '.lane', 'pilot-report.md')); symlinkSync('/outside-root', join(bundle, '.lane', 'pilot-report.md')) }],
    ['escaped manifest path', (bundle: string) => {
      const manifest = JSON.parse(readFileSync(join(bundle, 'fidelity-manifest.json'), 'utf8'))
      manifest.files[0].name = '../escape'
      writeFileSync(join(bundle, 'fidelity-manifest.json'), `${JSON.stringify(manifest)}\n`)
    }],
  ])('refuses %s evidence with a non-zero exit', (_name, mutate) => {
    const { root, bundle, run } = fixture()
    mutate(bundle)
    const result = run(['verify', '--root', root, '--dir', bundle])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('wt-pilot-fidelity:')
  })

  it('refuses a bundle once the recorded worktree identity changes', () => {
    const { root, bundle, run } = fixture()
    writeFileSync(join(root, '.lane', 'pilot-report.md'), 'changed after freeze\n')
    const result = run(['verify', '--root', root, '--dir', bundle, '--require-clean-tree'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('tree identity no longer matches root')
  })
})

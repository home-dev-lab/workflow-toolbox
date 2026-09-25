import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const RULES = [
  'wt-concurrent-sessions-worktree',
  'wt-delegation-ladder',
  'wt-proportionate-verification',
  'wt-sdlc',
  'wt-task-tracking',
  'wt-verify-by-ground-truth',
] as const
const SPLIT_LOCKS = {
  'wt-concurrent-sessions-worktree': { lines: 50, union: 'effcf924b2232d98780d858d8ef1fc050c82c429a74a2244393a90e9d667d9a6', core: '60b005add619f737d92252a470056488a0a437c5fde189e4d211fda1f8211dea', act: 'f910d31b5ca4267af9a0e3ab6b9e79a279b3978f7efdb9ac20fba196bca449fb' },
  'wt-delegation-ladder': { lines: 375, union: '089e342446a543919acf41f6ee103cea7b0285cfb951548e5ac4852fdc3055d4', core: 'a36c950c39b0a98855099e9be3c9e33610aa8421e4218ac7491a6a858bcf9c2b', act: '5f68f8e9792e9bae05830dda0bd6760015d862ccce856bbfa97399ea32f4948d' },
  'wt-proportionate-verification': { lines: 130, union: '2443ca2df2e2b0941211f5b18856dcd580f05dcb3794097659bda5c9b147378e', core: 'ddf0645dc374d0d502fa3a83ff078e24deb8eabe555c10215e236bea4dd39235', act: 'ffb96d2c2cbf1dc558d2015aea5e15d06c9be76ac4804991957323de314d2174' },
  'wt-sdlc': { lines: 85, union: '1eed1690e088140915ca9362497e033dea21ce3d7c8da0cb3e06c9b3f5473ac2', core: '2cc47c34e65aa35c7682bf6aa042d8fd9f5aff189ecc54fbf19ef270551ae488', act: '34d69ddf86e51cde733b06a8cf9f5018dba7c266c03cb4c0c4fe7cb6a1a4231b' },
  'wt-task-tracking': { lines: 64, union: '4596f598a9972d55a6c821142378883eb5b5d1c64a1956bcb4552e9bd3605931', core: '691d083c515162b47d424e0eb3c1e2b9e04ddda7384c1f964ce20831198c2b21', act: 'eccdd3e27e8ba0f9e352744a8fa737734c9ffb4e27d25baafbf1e75d45bb1700' },
  'wt-verify-by-ground-truth': { lines: 185, union: 'a759051b5170f8d2669f84ef1f9613e5d2f52ee535e23a155c2da2b88183bdf2', core: 'ba771ee4446584f5f6045e9ca58550293eeecae2ff5660537f850fc35134dcf2', act: '98d8f2c917ddecca4fe22e984d8786ea9ab2ff8e1e3e9d0d3178f0d6a3dff919' },
} as const

const digest = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex')
const nonBlank = (file: string) => readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')

let target: string | undefined
afterEach(() => {
  if (target) rmSync(target, { recursive: true, force: true })
  target = undefined
})

describe('shipped split rules', () => {
  it('keeps every original nonblank line exactly once and preserves each half order', () => {
    for (const name of RULES) {
      const core = nonBlank(join(ROOT, 'plugin/rules', `${name}.md`)).filter((line) => !line.startsWith('The act-bound half'))
      const act = nonBlank(join(ROOT, 'plugin/rules', `${name}-at-act.md`)).slice(1)
      const lock = SPLIT_LOCKS[name]
      expect(core.length + act.length, `${name} line count`).toBe(lock.lines)
      expect(digest([...core, ...act].sort()), `${name} lossless multiset`).toBe(lock.union)
      expect(digest(core), `${name} core order`).toBe(lock.core)
      expect(digest(act), `${name} act order`).toBe(lock.act)
    }
  })

  it('ships machine-triggered at-act halves and adopts both halves statically', () => {
    target = mkdtempSync(join(tmpdir(), 'wt-rule-splits-'))
    const env = sealedPluginCliEnv(join(target, 'env'), { CLAUDE_PLUGIN_ROOT: join(ROOT, 'plugin') })
    const install = spawnSync(process.execPath, [SCRIPT, '--set', 'rules', '--install', '--dir', target], {
      encoding: 'utf8',
      env,
    })
    expect(install.status, install.stderr).toBe(0)

    for (const name of RULES) {
      const atAct = `${name}-at-act.md`
      const specPath = join(ROOT, 'plugin/rules', `${name}-at-act.spec.json`)
      expect(existsSync(join(target, `${name}.md`)), `${name} core`).toBe(true)
      expect(existsSync(join(target, atAct)), `${name} at-act`).toBe(true)
      expect(install.stdout).toContain(`${atAct}: WROTE`)

      const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { 'on-demand'?: { triggers?: unknown[] } }
      expect(spec['on-demand']?.triggers?.length, `${name} trigger spec`).toBeGreaterThan(0)
    }

    const check = spawnSync(process.execPath, [SCRIPT, '--set', 'rules', '--check', '--dir', target], {
      encoding: 'utf8',
      env,
    })
    expect(check.status, check.stderr).toBe(0)
    for (const name of RULES) expect(check.stdout).toContain(`${name}-at-act.md: UP-TO-DATE`)
  })
})

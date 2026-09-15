import crypto from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import { effectiveSkillDiscoveryRefusal, opencodeChildEnv, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from '../../../../plugin/bin/lib/opencode-skill-fence.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function stub(mode: 'honor' | 'ignore' | 'invisible-allow') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wt-skill-fence-')); roots.push(root)
  const bin = path.join(root, 'opencode')
  const calls = path.join(root, 'calls')
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.2.3\\n'; exit 0; fi
printf 'probe\\n' >> ${JSON.stringify(calls)}
if [ ${JSON.stringify(mode)} = ignore ]; then printf '[{"name":"workflow-toolbox-fence-sentinel"}]\\n'; elif [ ${JSON.stringify(mode)} = invisible-allow ]; then printf '[]\\n'; else printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\\n'; fi
`)
  chmodSync(bin, 0o755)
  return { root, bin, calls, stateDir: path.join(root, 'state') }
}

describe('OpenCode Claude-skill fence', () => {
  it('forces true after an inherited false value', () => {
    expect(opencodeChildEnv({ OPENCODE_CONFIG: '/unsafe.json', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'false', KEEP: 'yes' })).toMatchObject({
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true', KEEP: 'yes',
    })
    expect(opencodeChildEnv({ OPENCODE_CONFIG: '/unsafe.json' })).not.toHaveProperty('OPENCODE_CONFIG')
  })

  it('uses uncached effective discovery with the exact cwd, environment, and non-pure flags', () => {
    const calls: unknown[][] = []
    const spawnSyncFn = (...args: unknown[]) => {
      calls.push(args)
      return { status: 0, stdout: '[{"name":"allowed","location":"/allowed/SKILL.md"}]', stderr: '' }
    }
    const env = { MARKER: 'same' }
    expect(verifyEffectiveOpencodeSkillDiscovery('/bin/opencode', { cwd: '/lane', env, spawnSyncFn })).toMatchObject({ ok: true })
    expect(verifyEffectiveOpencodeSkillDiscovery('/bin/opencode', { cwd: '/lane', env, spawnSyncFn })).toMatchObject({ ok: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[1]).toEqual(['debug', 'skill'])
    expect(calls[0]?.[2]).toMatchObject({ cwd: '/lane', env })
  })

  it('refuses every discovered single-writer name with its reported location', () => {
    const stdout = JSON.stringify([
      { name: 'save-memory', location: '/one/SKILL.md' },
      { name: 'planka-tracking', location: '/two/SKILL.md' },
      { name: 'what-next', location: '/three/SKILL.md' },
    ])
    const result = verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => ({ status: 0, stdout, stderr: '' }) })
    expect(result).toMatchObject({ ok: false, refused: expect.arrayContaining([expect.objectContaining({ name: 'save-memory', location: '/one/SKILL.md' })]) })
    expect(effectiveSkillDiscoveryRefusal(result)).toBe('wt-lane: Refused: effective OpenCode skill discovery found save-memory at /one/SKILL.md, planka-tracking at /two/SKILL.md, what-next at /three/SKILL.md; refusing to launch.')
  })

  it.each(['Save-Memory', 'save_memory', 'SAVE-MEMORY'])('refuses the OpenCode-visible %s identity variant', (name) => {
    const stdout = JSON.stringify([{ name, location: `/lane/${name}/SKILL.md` }])
    expect(verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => ({ status: 0, stdout, stderr: '' }) })).toMatchObject({
      ok: false,
      refused: [{ name }],
    })
  })

  it('fails closed when effective discovery fails or returns invalid JSON', () => {
    expect(verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => ({ status: 1, stdout: '', stderr: 'bad' }) })).toMatchObject({ ok: false, reason: expect.stringContaining('failed') })
    expect(verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => ({ status: 0, stdout: 'nope', stderr: '' }) })).toMatchObject({ ok: false, reason: expect.stringContaining('invalid JSON') })
  })

  it('refuses a binary that still lists the synthetic Claude skill', () => {
    const f = stub('ignore')
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: false, reason: expect.stringContaining('still listed') })
  })

  it('accepts an honoring binary and skips the probe on a cache hit', () => {
    const f = stub('honor')
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: false })
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: true })
    expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toEqual(['probe'])
  })

  it('refuses a binary that cannot expose the materialised allowed skill', () => {
    const f = stub('invisible-allow')
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, allowOk: false, allowReason: expect.stringContaining('allow-list half') })
  })

  it('does not treat a pre-allow-list cache entry as a hit', () => {
    const f = stub('honor')
    const oldKey = crypto.createHash('sha256').update(`${realpathSync(f.bin)}\0${'1.2.3'}\0opencode-config-skills-paths\0allow-list-v1`).digest('hex')
    // The legacy entry is deliberately stored under the old contract key.
    mkdirSync(f.stateDir, { recursive: true })
    writeFileSync(path.join(f.stateDir, oldKey + '.json'), JSON.stringify({ ok: true, binary: realpathSync(f.bin), version: '1.2.3' }))
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, allowOk: true, cached: false })
  })

  it('retains only the newest 64 capability results when writing a cache miss', () => {
    const f = stub('honor')
    mkdirSync(f.stateDir, { recursive: true })
    for (let index = 0; index < 80; index += 1) {
      const file = path.join(f.stateDir, `${index.toString(16).padStart(64, '0')}.json`)
      writeFileSync(file, '{}')
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index))
      utimesSync(file, timestamp, timestamp)
    }
    writeFileSync(path.join(f.stateDir, 'keep.txt'), 'not a fence cache entry')

    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: false })

    const cacheFiles = readdirSync(f.stateDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    expect(cacheFiles).toHaveLength(64)
    expect(cacheFiles).not.toContain(`${'0'.repeat(64)}.json`)
    expect(cacheFiles).toContain(`${(79).toString(16).padStart(64, '0')}.json`)
    expect(readFileSync(path.join(f.stateDir, 'keep.txt'), 'utf8')).toBe('not a fence cache entry')
  })
})

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import { effectiveSkillDiscoveryRefusal, opencodeChildEnv, pruneOpencodeSkillFenceCache, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from '../../../../plugin/bin/lib/opencode-skill-fence.mjs'

const FENCE_MODULE = new URL('../../../../plugin/bin/lib/opencode-skill-fence.mjs', import.meta.url).href

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

function pruneWorker(stateDir: string, events: string) {
  const source = `
    import fs from 'node:fs'
    import path from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const [stateDir, events] = process.argv.slice(1)
    const remove = fs.rmSync
    let delayed = false
    fs.rmSync = (file, options) => {
      if (!delayed && /^[a-f0-9]{64}\\.json$/.test(path.basename(String(file)))) {
        delayed = true
        fs.appendFileSync(events, 'prune-start\\n')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
        const result = remove(file, options)
        fs.appendFileSync(events, 'prune-end\\n')
        return result
      }
      return remove(file, options)
    }
    syncBuiltinESMExports()
    const { pruneOpencodeSkillFenceCache } = await import(${JSON.stringify(FENCE_MODULE)})
    pruneOpencodeSkillFenceCache({ stateDir, maxEntries: 64 })
  `
  return spawn(process.execPath, ['--input-type=module', '-e', source, stateDir, events], { stdio: 'inherit' })
}

function publishWorker(bin: string, stateDir: string, events: string) {
  const source = `
    import fs from 'node:fs'
    import path from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const [bin, stateDir, events] = process.argv.slice(1)
    const rename = fs.renameSync
    fs.renameSync = (from, to) => {
      const result = rename(from, to)
      if (/^[a-f0-9]{64}\\.json$/.test(path.basename(String(to)))) fs.appendFileSync(events, 'publish\\n')
      return result
    }
    syncBuiltinESMExports()
    const { verifyOpencodeSkillFence } = await import(${JSON.stringify(FENCE_MODULE)})
    if (!verifyOpencodeSkillFence(bin, { stateDir }).ok) process.exitCode = 1
  `
  return spawn(process.execPath, ['--input-type=module', '-e', source, bin, stateDir, events], { stdio: 'inherit' })
}

function exited(child: ReturnType<typeof spawn>) {
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (readFileSync(file, { encoding: 'utf8', flag: 'a+' }).includes('prune-start')) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${file}`)
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
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: false })
    for (const name of readdirSync(f.stateDir)) if (/^[a-f0-9]{64}\.json$/.test(name)) rmSync(path.join(f.stateDir, name))
    writeFileSync(path.join(f.stateDir, oldKey + '.json'), JSON.stringify({ ok: true, binary: realpathSync(f.bin), version: '1.2.3' }))
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, allowOk: true, cached: false })
  })

  it('retains only the newest 64 capability results when writing a cache miss', () => {
    const f = stub('honor')
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: false })
    const currentKey = crypto.createHash('sha256').update(`${realpathSync(f.bin)}\0${'1.2.3'}\0opencode-config-skills-paths\0allow-list-v2-two-half`).digest('hex')
    rmSync(path.join(f.stateDir, currentKey + '.json'))
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

  it('serializes cache-miss publication against pruning across processes', async () => {
    const f = stub('honor')
    const events = path.join(f.root, 'events')
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: false })
    for (const name of readdirSync(f.stateDir)) if (/^[a-f0-9]{64}\.json$/.test(name)) rmSync(path.join(f.stateDir, name))
    for (let index = 0; index < 80; index += 1) writeFileSync(path.join(f.stateDir, `${index.toString(16).padStart(64, '0')}.json`), '{}')

    const pruner = pruneWorker(f.stateDir, events)
    await waitForFile(events)
    const publisher = publishWorker(f.bin, f.stateDir, events)

    expect(await Promise.all([exited(pruner), exited(publisher)])).toEqual([0, 0])
    expect(readFileSync(events, 'utf8').trim().split('\n')).toEqual(['prune-start', 'prune-end', 'publish'])
  })

  it('refuses to prune an unmarked directory and leaves an unrelated lock tree intact', () => {
    const f = stub('honor')
    const nested = path.join(f.stateDir, '.retention.lock', 'unrelated', 'data')
    mkdirSync(path.dirname(nested), { recursive: true })
    writeFileSync(nested, 'keep')

    expect(() => pruneOpencodeSkillFenceCache({ stateDir: f.stateDir })).toThrow(/refusing unowned/)
    expect(readFileSync(nested, 'utf8')).toBe('keep')
  })
})

import crypto from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import { opencodeChildEnv, verifyOpencodeSkillFence } from '../../../../plugin/bin/lib/opencode-skill-fence.mjs'

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
    expect(opencodeChildEnv({ OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'false', KEEP: 'yes' })).toMatchObject({
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true', KEEP: 'yes',
    })
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
})

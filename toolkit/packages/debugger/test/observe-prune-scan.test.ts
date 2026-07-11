import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanRunsForPrune } from '../src/observe-cli.js'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'prune-scan-'))
  made.push(root)
  return root
}
function touch(p: string, body = '{}'): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}

describe('scanRunsForPrune (impure scanner)', () => {
  it('LIVE-RUN SAFETY: emits a COMPLETED run (json present) but SKIPS a live run (no json yet)', () => {
    const cfg = fixture()
    const sess = join(cfg, 'projects', 'slugA', 'sessX')
    // completed run: json + script + sidecar
    touch(join(sess, 'workflows', 'wf_done.json'))
    touch(join(sess, 'workflows', 'scripts', 'probe-thing-wf_done.js'), '// script')
    mkdirSync(join(sess, 'subagents', 'workflows', 'wf_done'), { recursive: true })
    // live run: script + sidecar, but NO completion json (harness writes json only at completion)
    touch(join(sess, 'workflows', 'scripts', 'probe-live-wf_live.js'), '// script')
    mkdirSync(join(sess, 'subagents', 'workflows', 'wf_live'), { recursive: true })

    const records = scanRunsForPrune([cfg])
    expect(records.map((r) => r.runId)).toEqual(['wf_done']) // wf_live invisible → never deletable while running
    const done = records[0]!
    expect(done.name).toBe('probe-thing')
    expect(done.jsonPath).toBe(join(sess, 'workflows', 'wf_done.json'))
    expect(done.scriptPath).toBe(join(sess, 'workflows', 'scripts', 'probe-thing-wf_done.js'))
    expect(done.sidecarDir).toBe(join(sess, 'subagents', 'workflows', 'wf_done'))
  })

  it('cross-slug: a script under a DIFFERENT slug than the json still resolves the name; sidecar stays with the json session', () => {
    const cfg = fixture()
    const jsonSess = join(cfg, 'projects', 'slugJson', 'sessX')
    const scriptSess = join(cfg, 'projects', 'slugScript', 'sessX')
    touch(join(jsonSess, 'workflows', 'wf_x.json'))
    touch(join(scriptSess, 'workflows', 'scripts', 'probe-cross-wf_x.js'), '// s')

    const records = scanRunsForPrune([cfg])
    expect(records).toHaveLength(1)
    expect(records[0]!.name).toBe('probe-cross')
    expect(records[0]!.jsonPath).toBe(join(jsonSess, 'workflows', 'wf_x.json'))
    // sidecar is co-located with the JSON's session, NOT the script's — the verifier's slug concern is by-design
    expect(records[0]!.sidecarDir).toBe(join(jsonSess, 'subagents', 'workflows', 'wf_x'))
  })

  it('a run with no script → name null (prefix-unmatchable; prunable only by --run)', () => {
    const cfg = fixture()
    const sess = join(cfg, 'projects', 's', 'sess')
    touch(join(sess, 'workflows', 'wf_noscript.json'))

    const records = scanRunsForPrune([cfg])
    expect(records).toHaveLength(1)
    expect(records[0]!.name).toBeNull()
  })

  it('ignores non-run files in workflows/ (only wf_*.json)', () => {
    const cfg = fixture()
    const sess = join(cfg, 'projects', 's', 'sess')
    touch(join(sess, 'workflows', 'wf_real.json'))
    touch(join(sess, 'workflows', 'notes.json'))
    touch(join(sess, 'workflows', 'wf_real.txt'))

    const records = scanRunsForPrune([cfg])
    expect(records.map((r) => r.runId)).toEqual(['wf_real'])
  })
})

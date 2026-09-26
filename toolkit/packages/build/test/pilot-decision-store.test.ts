import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { decidePilotRun, initializePilotDecisionStore, pilotDecisionStateRoot, readPilotDecisions, registerPilotDecisionRequest } from '../../../../plugin/bin/lib/host/pilot-decision-store.mjs'

const CLI = fileURLToPath(new URL('../../../../plugin/bin/wt-pilot-runner.mjs', import.meta.url))

describe('pilot parent decision store', () => {
  it('accepts only a registered criterion and exposes one shared atomic record', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-decisions-'))
    const file = initializePilotDecisionStore('card-123', { root })
    registerPilotDecisionRequest(file, { requestId: 'request-1', criteria: [2] })

    expect(() => decidePilotRun({ runId: 'card-123', criterion: 1, reading: 'forged', root })).toThrow('no open decision request for DoD 1')
    decidePilotRun({ runId: 'card-123', criterion: 2, reading: 'literal parent reading', root, decidedAt: 0 })

    expect(readPilotDecisions(file)).toEqual([{ requestId: 'request-1', criterion: 2, reading: 'literal parent reading', decidedAt: '1970-01-01T00:00:00.000Z' }])
    expect(readFileSync(file, 'utf8')).not.toContain('.tmp')
  })

  it('writes through the public decide CLI', () => {
    const stateHome = mkdtempSync(join(tmpdir(), 'wt-pilot-cli-'))
    const file = initializePilotDecisionStore('card-456', { env: { XDG_STATE_HOME: stateHome }, platform: 'linux', home: stateHome })
    registerPilotDecisionRequest(file, { requestId: 'request-2', criteria: [1] })
    const result = spawnSync(process.execPath, [CLI, 'decide', '--run', 'card-456', '--dod', '1', '--reading', 'parent via cli'], { env: { ...process.env, XDG_STATE_HOME: stateHome }, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(readPilotDecisions(file)[0]).toMatchObject({ criterion: 1, reading: 'parent via cli' })
  })

  it('resolves host state roots on Linux, macOS, and Windows', () => {
    expect(pilotDecisionStateRoot({ platform: 'linux', env: { XDG_STATE_HOME: '/state' }, home: '/home/u' })).toBe('/state/workflow-toolbox/pilot-runs')
    expect(pilotDecisionStateRoot({ platform: 'darwin', env: {}, home: '/Users/u' })).toBe('/Users/u/Library/Application Support/workflow-toolbox/pilot-runs')
    expect(pilotDecisionStateRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u' })).toContain('workflow-toolbox')
  })

  it('refuses a run id that could escape the state root', () => {
    expect(() => initializePilotDecisionStore('../lane-forgery', { root: tmpdir() })).toThrow('invalid pilot run id')
  })
})

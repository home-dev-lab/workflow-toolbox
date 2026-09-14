import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import { runObserverLane } from '../../../../plugin/bin/lib/observer-lane.mjs'

const ROOT = path.join(__dirname, '..', '..', '..', '..')
const ENVELOPE = path.join(ROOT, 'plugin/bin/wt-opencode-envelope.mjs')
const HOOK = path.join(ROOT, 'plugin/bin/wt-envelope-intercept-hook.mjs')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wt-skill-fence-paths-')); roots.push(root)
  const binDir = path.join(root, 'bin'); const bin = path.join(binDir, 'opencode'); const record = path.join(root, 'record')
  mkdirSync(binDir)
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fixture-1\n'; exit 0; fi
if [ "$1" = "--pure" ]; then printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\n'; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then printf 'probe|%s|%s|%s\n' "$PWD" "$IDENTITY_MARKER" "\${OPENCODE_CONFIG-unset}" >> "$RECORD"; printf '[]\n'; exit 0; fi
if [ "$1" = "providers" ]; then exit 0; fi
printf 'run|%s|%s|%s\n' "$PWD" "$IDENTITY_MARKER" "\${OPENCODE_CONFIG-unset}" >> "$RECORD"
printf '%s\n' '{"type":"text","part":{"text":"{\\"status\\":\\"clean\\"}"}}'
`)
  chmodSync(bin, 0o755)
  const home = path.join(root, 'home')
  mkdirSync(home)
  writeFileSync(path.join(home, '.zprofile'), `export OPENCODE_CONFIG=${path.join(root, 'shell-startup-unsafe.json')}\n`)
  const env = { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}`, RECORD: record, IDENTITY_MARKER: 'same', OPENCODE_CONFIG: path.join(root, 'unsafe.json'), XDG_STATE_HOME: path.join(root, 'state'), OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'false' }
  return { root, bin, record, env }
}

describe('all toolbox-owned OpenCode launch paths', () => {
  it('uses one sanitized cwd/environment/config context for envelope probe and fan-out spawns', () => {
    const f = fixture()
    const tasks = path.join(f.root, 'tasks.json')
    writeFileSync(tasks, JSON.stringify([{ id: 'one', prompt: 'answer' }, { id: 'two', prompt: 'answer' }]))
    expect(spawnSync(process.execPath, [ENVELOPE, tasks, '--dir', f.root], { encoding: 'utf8', env: f.env }).status).toBe(0)
    expect(readFileSync(f.record, 'utf8').trim().split('\n')).toEqual([
      `probe|${f.root}|same|unset`,
      `run|${f.root}|same|unset`,
      `run|${f.root}|same|unset`,
    ])
  })

  it('uses one sanitized cwd/environment/config context for intercept probe and spawn', () => {
    const f = fixture()
    const hookInput = { hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: f.root, tool_input: { subagent_type: 'workflow-toolbox:opencode-verifier', prompt: 'review' } }
    expect(spawnSync(process.execPath, [HOOK], { input: JSON.stringify(hookInput), encoding: 'utf8', env: f.env }).status).toBe(0)
    expect(readFileSync(f.record, 'utf8').trim().split('\n')).toEqual([
      `probe|${f.root}|same|unset`,
      `run|${f.root}|same|unset`,
    ])
  })

  it('uses one sanitized cwd/environment/config context for observer probe and direct spawn', () => {
    const f = fixture()
    const keys = ['PATH', 'RECORD', 'IDENTITY_MARKER', 'OPENCODE_CONFIG', 'XDG_STATE_HOME', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS'] as const
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) process.env[key] = f.env[key]
    try {
      expect(runObserverLane({ projectDir: f.root, prompt: 'observe', timeoutSeconds: 5, model: 'test/model', binPath: f.bin }).outcome).toEqual({ kind: 'clean' })
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
    expect(readFileSync(f.record, 'utf8').trim().split('\n')).toEqual([
      `probe|${f.root}|same|unset`,
      `run|${f.root}|same|unset`,
    ])
  })
})

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LAUNCHER = join(ROOT, 'plugin/bin/wt-lane.mjs')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lane-launcher-')); roots.push(root)
  const dir = join(root, 'worktree'); const bin = join(root, 'bin'); const config = join(root, 'config')
  mkdirSync(join(dir, '.lane'), { recursive: true }); mkdirSync(bin); mkdirSync(config)
  writeFileSync(join(dir, 'brief.md'), '# brief\n')
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fixture-1\n'; exit 0; fi
if [ "$1" = "--pure" ]; then if [ "$IGNORE_FENCE" = "1" ]; then printf '[{"name":"workflow-toolbox-fence-sentinel"}]\n'; elif [ "$INVISIBLE_ALLOW" = "1" ]; then printf '[]\n'; else printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\n'; fi; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then if [ -n "$IDENTITY_RECORD" ]; then printf 'probe|%s|%s|%s\n' "$PWD" "$IDENTITY_MARKER" "\${OPENCODE_CONFIG-unset}" >> "$IDENTITY_RECORD"; fi; printf '%s\n' "\${EFFECTIVE_SKILLS:-[]}"; exit 0; fi
${script}\n`)
  spawnSync('chmod', ['+x', join(bin, 'opencode')])
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: config, XDG_STATE_HOME: join(root, 'state') }
  return { root, dir, config, env }
}
function run(f: ReturnType<typeof fixture>, extra: string[] = []) {
  return spawnSync(process.execPath, [LAUNCHER, '--dir', f.dir, '--model', 'test/model', '--brief', join(f.dir, 'brief.md'), '--allow-no-git', ...extra], { encoding: 'utf8', env: f.env })
}
function waitFor(log: string, ms = 3000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (existsSync(log) && /EXIT=/.test(readFileSync(log, 'utf8'))) return; spawnSync('sleep', ['0.05']) }
}
function waitForFile(file: string, ms = 3000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (existsSync(file)) return; spawnSync('sleep', ['0.05']) }
}

describe('wt-lane detached launcher', () => {
  it('returns immediately, leaves the worker alive, closes stdin, and writes EXIT=0', () => {
    const f = fixture('IFS= read -r x; test -z "$x"; sleep 0.2; echo done')
    const res = run(f); const log = join(f.dir, '.lane', 'run.log')
    expect(res.status).toBe(0); expect(res.stdout).toMatch(/pid=\d+\nlog=/)
     const pid = Number(/pid=(\d+)/.exec(res.stdout)?.[1]); expect(() => process.kill(pid, 0)).not.toThrow()
     expect(readFileSync(join(f.dir, '.lane', 'pid'), 'utf8').trim()).toBe(String(pid))
    waitFor(log); expect(readFileSync(log, 'utf8')).toMatch(/EXIT=0\n$/)
  })
  it('enforces the timeout with EXIT=124', () => {
    const f = fixture('sleep 30')
    const res = run(f, ['--timeout', '1']); expect(res.status).toBe(0)
    const log = join(f.dir, '.lane', 'run.log'); waitFor(log, 3000)
    expect(readFileSync(log, 'utf8')).toMatch(/EXIT=124\n$/)
  })
  it('a SIGTERM to the worker takes the opencode process with it and writes EXIT=143 (a killed launcher used to leave the lane running)', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const worker = Number(/pid=(\d+)/.exec(res.stdout)?.[1])
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    const opencodePid = Number(readFileSync(pidFile, 'utf8').trim())
    process.kill(worker, 'SIGTERM')
    const log = join(f.dir, '.lane', 'run.log'); waitFor(log, 4000)
    expect(readFileSync(log, 'utf8')).toMatch(/EXIT=143\n$/)
    const until = Date.now() + 4000; let alive = true
    while (Date.now() < until) { try { process.kill(opencodePid, 0) } catch { alive = false; break } spawnSync('sleep', ['0.05']) }
    expect(alive).toBe(false)
  })
  it('an external SIGTERM after the lane wrote its own EXIT line does not append a second one (a lifecycle group kill used to turn EXIT=0 into EXIT=143)', () => {
    const f = fixture('printf "lane done\\nEXIT=0\\n" >> "$PWD/.lane/run.log"; echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const worker = Number(/pid=(\d+)/.exec(res.stdout)?.[1])
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    process.kill(worker, 'SIGTERM')
    const log = join(f.dir, '.lane', 'run.log')
    const until = Date.now() + 4000
    while (Date.now() < until) { try { process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0); spawnSync('sleep', ['0.05']) } catch { break } }
    expect(readFileSync(log, 'utf8')).toMatch(/EXIT=0\n$/)
    expect((readFileSync(log, 'utf8').match(/^EXIT=/gm) ?? []).length).toBe(1)
  })
  it('passes --variant through to opencode and refuses a malformed one', () => {
    const f = fixture('printf "%s\\n" "$@" > "$PWD/argv"; IFS= read -r x; echo done')
    const res = run(f, ['--variant', 'high']); expect(res.status).toBe(0)
    const log = join(f.dir, '.lane', 'run.log'); waitFor(log)
    expect(readFileSync(join(f.dir, 'argv'), 'utf8')).toMatch(/--variant\nhigh\n/)
    const bad = run(f, ['--variant', 'hi gh']); expect(bad.status).toBe(2); expect(bad.stderr).toContain('--variant')
  })
  it('fences Claude Code skills while preserving the opencode argv contract and launch options', () => {
    const f = fixture('printf "%s\\n" "$OPENCODE_DISABLE_CLAUDE_CODE_SKILLS" > "$PWD/claude-skills-fence"; printf "%s\\n" "$@" > "$PWD/argv"')
    f.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'false'
    const res = run(f, ['--variant', 'high', '--timeout', '1']); expect(res.status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'claude-skills-fence'), 'utf8')).toBe('true\n')
    expect(readFileSync(join(f.dir, 'argv'), 'utf8')).toBe([
      'run',
      `Read and execute the complete brief at ${join(f.dir, 'brief.md')}.`,
      '--auto',
      '--dir',
      f.dir,
      '--model',
      'test/model',
      '--variant',
      'high',
      '',
    ].join('\n'))
  })
  it('refuses before launch when OpenCode ignores the fence', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.IGNORE_FENCE = '1'
    const res = run(f)
    expect(res.status).toBe(1)
    expect(res.stderr).toBe('OPENCODE_SKILL_FENCE_UNAVAILABLE: the synthetic Claude skill is still listed under the forced fence; update OpenCode or workflow-toolbox before launching.\n')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('refuses before spawn when effective discovery reports a project-native refused skill', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.EFFECTIVE_SKILLS = '[{"name":"save-memory","location":"/lane/.opencode/skills/save-memory/SKILL.md"}]'
    const res = run(f)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('save-memory at /lane/.opencode/skills/save-memory/SKILL.md')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })

  it.each(['Save-Memory', 'save_memory', 'SAVE-MEMORY'])('refuses the discovered %s variant before spawn', (name) => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.EFFECTIVE_SKILLS = JSON.stringify([{ name, location: `/lane/.opencode/skills/${name}/SKILL.md` }])
    const res = run(f)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain(`${name} at /lane/.opencode/skills/${name}/SKILL.md`)
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })

  it('drops an inherited OPENCODE_CONFIG before both effective discovery and spawn', () => {
    const f = fixture('printf "run|%s|%s|%s\\n" "$PWD" "$IDENTITY_MARKER" "${OPENCODE_CONFIG-unset}" >> "$IDENTITY_RECORD"; printf spawned > "$PWD/spawned"')
    f.env.IDENTITY_RECORD = join(f.root, 'identity-record')
    f.env.IDENTITY_MARKER = 'same'
    f.env.OPENCODE_CONFIG = join(f.root, 'unsafe.json')
    expect(run(f).status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
    expect(readFileSync(f.env.IDENTITY_RECORD, 'utf8').trim().split('\n').slice(-2)).toEqual([
      `probe|${f.dir}|same|unset`,
      `run|${f.dir}|same|unset`,
    ])
  })
  it('keeps an empty allow-list launchable when the allow half is unavailable', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.INVISIBLE_ALLOW = '1'
    const res = run(f)
    expect(res.status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
  })
  it('refuses requested single-writer, missing, and unavailable allow-list skills before launch', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.WT_LANE_SKILLS = 'save-memory'
    expect(run(f).stderr).toContain('save-memory is a single-writer memory/board-writing skill')
    f.env.WT_LANE_SKILLS = 'missing'
    expect(run(f).stderr).toContain('missing: missing-source (skill source is missing: missing)')
    mkdirSync(join(f.config, 'skills', 'allowed'), { recursive: true })
    writeFileSync(join(f.config, 'skills', 'allowed', 'SKILL.md'), '---\nname: allowed\ndescription: allowed\n---\n')
    f.env.WT_LANE_SKILLS = 'allowed'; f.env.INVISIBLE_ALLOW = '1'
    const unavailable = run(f)
    expect(unavailable.status).toBe(1)
    expect(unavailable.stderr).toContain('allow-list half failed for opencode-config-skills-paths')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it.each(['save_memory', 'SAVE-MEMORY'])('refuses requested single-writer variant %s', (name) => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.WT_LANE_SKILLS = name
    expect(run(f).stderr).toContain('single-writer memory/board-writing skill')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('passes the materialised mechanism only for requested allowed skills', () => {
    const f = fixture('printf "%s" "$OPENCODE_CONFIG" > "$PWD/opencode-config"')
    mkdirSync(join(f.config, 'skills', 'allowed'), { recursive: true })
    writeFileSync(join(f.config, 'skills', 'allowed', 'SKILL.md'), '---\nname: allowed\ndescription: allowed\n---\n')
    f.env.WT_LANE_SKILLS = 'allowed'
    expect(run(f).status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'opencode-config'), 'utf8')).toBe(join(f.dir, '.lane', 'opencode-skills.json'))
  })
  it('refuses absent consent before spawning', () => {
    const f = fixture('echo spawned > "$PWD/spawned"')
    writeFileSync(join(f.config, 'settings.json'), '{}')
    const res = run(f); expect(res.status).not.toBe(0); expect(res.stderr).toContain('Refused:')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('rejects missing required arguments', () => {
    const f = fixture('true')
    const res = spawnSync(process.execPath, [LAUNCHER, '--model', 'test/model', '--brief', join(f.dir, 'brief.md')], { encoding: 'utf8', env: f.env })
    expect(res.status).toBe(2); expect(res.stderr).toContain('missing required')
  })
  it('writes a redacted environment snapshot and launching session when the worker starts', () => {
    const f = fixture('sleep 0.2')
    delete f.env.CLAUDE_CODE_SESSION_ID
    writeFileSync(join(f.root, 'bin', 'ssh-add'), '#!/bin/sh\nprintf \'ssh-rsa AAAA fingerprint\n\'\nexit 0\n')
    spawnSync('chmod', ['+x', join(f.root, 'bin', 'ssh-add')])
    const res = run(f); expect(res.status).toBe(0)
    const envLog = join(f.dir, '.lane', 'env.log'); waitForFile(envLog)
    const lines = readFileSync(envLog, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('CLAUDE_CODE_SESSION_ID=')
    expect(lines[1]).toMatch(/^SSH_AUTH_SOCK=(present|absent)$/)
    expect(lines[2]).toBe('ssh-add -l: exit=0 keys=1')
    expect(lines[3]).toMatch(/^HOME=(present|absent) USER=(present|absent)$/)
    expect(lines[4]).toMatch(/^node=v\d+\.\d+\.\d+$/)
    expect(lines[5]).toMatch(/^at=\d{4}-\d\d-\d\dT.*Z$/)
    expect(readFileSync(envLog, 'utf8')).not.toMatch(/ssh-rsa|fingerprint|AAAA|\/home\//)
  })

  it('records the launching Claude session id and an empty value when absent', () => {
    const withSession = fixture('sleep 0.2')
    withSession.env.CLAUDE_CODE_SESSION_ID = 'session-under-test'
    expect(run(withSession).status).toBe(0)
    const withSessionLog = join(withSession.dir, '.lane', 'env.log'); waitForFile(withSessionLog)
    expect(readFileSync(withSessionLog, 'utf8')).toContain('CLAUDE_CODE_SESSION_ID=session-under-test\n')

    const withoutSession = fixture('sleep 0.2')
    delete withoutSession.env.CLAUDE_CODE_SESSION_ID
    expect(run(withoutSession).status).toBe(0)
    const withoutSessionLog = join(withoutSession.dir, '.lane', 'env.log'); waitForFile(withoutSessionLog)
    expect(readFileSync(withoutSessionLog, 'utf8')).toContain('CLAUDE_CODE_SESSION_ID=\n')
  })
  it('records an ssh-add exit without exposing probe output', () => {
    const f = fixture('sleep 0.2')
    writeFileSync(join(f.root, 'bin', 'ssh-add'), '#!/bin/sh\nexit 2\n')
    spawnSync('chmod', ['+x', join(f.root, 'bin', 'ssh-add')])
    expect(run(f).status).toBe(0)
    const envLog = join(f.dir, '.lane', 'env.log'); waitForFile(envLog)
    expect(readFileSync(envLog, 'utf8')).toContain('ssh-add -l: exit=2 keys=0')
    expect(readFileSync(envLog, 'utf8')).not.toMatch(/ssh-ed25519|SHA256:|secret|AAAA/)
  })
  it('reports keys=0 when ssh-add fails while still printing a sentence', () => {
    const f = fixture('sleep 0.2')
    writeFileSync(join(f.root, 'bin', 'ssh-add'), '#!/bin/sh\nprintf \'The agent has no identities.\\n\'\nexit 1\n')
    spawnSync('chmod', ['+x', join(f.root, 'bin', 'ssh-add')])
    expect(run(f).status).toBe(0)
    const envLog = join(f.dir, '.lane', 'env.log'); waitForFile(envLog)
    expect(readFileSync(envLog, 'utf8')).toContain('ssh-add -l: exit=1 keys=0')
    expect(readFileSync(envLog, 'utf8')).not.toContain('identities')
  })
})

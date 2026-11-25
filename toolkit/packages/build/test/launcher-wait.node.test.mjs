import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import { appendLauncherEvent, takeLauncherEvent } from '../../../../plugin/bin/lib/host/launcher-events.mjs'
import { waitForLauncher } from '../../../../plugin/bin/lib/launcher-wait.mjs'
import { deadlineCases, runDeadlineCase } from './helpers/lane-wait-deadline-cases.mjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

for (const scenario of deadlineCases) {
  test(`existing deadline harness: ${scenario.title}`, () => {
    let result
    assert.doesNotThrow(() => { result = runDeadlineCase(scenario) }, 'the unchanged deadline harness must remain compatible')
    assert.deepEqual(result, { status: scenario.status, stdout: scenario.output }, scenario.title)
  })
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'launcher-wait-')); roots.push(root)
  return { root, stateRoot: path.join(root, 'host'), poll: 1, timeout: 10 }
}

function runWaiter(f, closed = false) {
  const cli = fileURLToPath(new URL('../../../../plugin/bin/wt-lane-wait.mjs', import.meta.url))
  const program = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; import { pathToFileURL } from 'node:url';
    const read = fs.readFileSync; fs.readFileSync = (file, ...args) => file === '/proc/self/uid_map'
      ? '0 0 4294967295' : read(file, ...args);
     const write = fs.writeFileSync; fs.writeFileSync = (file, ...args) => {
       if (file === 1 && ${closed}) throw new Error('fake EPIPE'); return write(file, ...args);
     }; const writeSync = fs.writeSync; fs.writeSync = (fd, ...args) => {
       if (fd === 1 && ${closed}) throw new Error('fake EPIPE'); return writeSync(fd, ...args);
     }; syncBuiltinESMExports(); process.argv = [process.execPath, ...process.argv.slice(1)];
    await import(pathToFileURL(process.argv[1]).href);`
  return spawnSync(process.execPath, ['--input-type=module', '-e', program, cli,
    '--launcher-agent', 'first', '--poll', '0.01', '--timeout', '1'], {
    env: { ...process.env, WT_LANE_HOST_STATE: f.stateRoot, HOME: f.root, USERPROFILE: f.root,
      CLAUDE_CONFIG_DIR: path.join(f.root, 'config'), CLAUDE_PLUGIN_DATA: path.join(f.root, 'data') }, encoding: 'utf8', timeout: 5_000,
  })
}

test('waiter wakes for its first new event, ignoring other launcher events', async () => {
  const f = fixture(), lines = []; let now = 0, sleeps = 0
  const result = await waitForLauncher('first', { ...f, clock: () => now, write: (line) => lines.push(line),
    sleep: async () => {
      now += 1_000; sleeps++
      const id = sleeps === 1 ? 'other' : 'first'
      appendLauncherEvent(id, { key: 'exit', line: `event ${id}` }, f)
    } })
  assert.equal(result, 0)
  assert.equal(sleeps, 2, 'another launcher must not wake this waiter')
  assert.deepEqual(lines, ['event first'], 'waiter must print exactly the first matching event')
})

test('persistent acknowledgement does not reannounce an event on the next waiter', async () => {
  const f = fixture(), lines = []
  appendLauncherEvent('first', { key: 'one', line: 'first event' }, f)
  await waitForLauncher('first', { ...f, write: (line) => lines.push(line) })
  assert.equal(takeLauncherEvent('first', f), null, 'consumed event must not be replayed')
  appendLauncherEvent('first', { key: 'two', line: 'second event' }, f)
  await waitForLauncher('first', { ...f, write: (line) => lines.push(line) })
  assert.deepEqual(lines, ['first event', 'second event'])
  const done = path.join(f.root, 'wt-launcher-events/first/done')
  if (process.platform !== 'win32') assert.equal(statSync(path.join(done, readdirSync(done)[0])).mode & 0o777, 0o600)
})

test('wait budget expires with 125 and no invented completion', async () => {
  const f = fixture(); let now = 0
  assert.equal(await waitForLauncher('first', { ...f, clock: () => now, sleep: async (ms) => { now += ms },
    write: () => assert.fail('no event was published') }), 125)
})

test('failed waiter output does not consume its pending event', async () => {
  const f = fixture()
  appendLauncherEvent('first', { key: 'one', line: 'pending event' }, f)
  await assert.rejects(waitForLauncher('first', { ...f, write: () => { throw new Error('fake output closed') } }), /fake output closed/)
  assert.equal(takeLauncherEvent('first', f)?.line, 'pending event', 'failed delivery must leave the event pending')
})

test('launcher waiter CLI returns its pending event on stdout', () => {
  const f = fixture()
  appendLauncherEvent('first', { key: 'one', line: 'LANE exited: runId=fake launcher-agent=first' }, f)
  const result = runWaiter(f)
  assert.equal(result.status, 0, 'launcher waiter CLI must return on its first pending event')
  assert.equal(result.stdout, 'LANE exited: runId=fake launcher-agent=first\n')
  assert.equal(takeLauncherEvent('first', f), null)
})

test('CLI stdout failure leaves its event pending', () => {
  const f = fixture()
  appendLauncherEvent('first', { key: 'one', line: 'pending event' }, f)
  const result = runWaiter(f, true)
  assert.equal(result.status, 1, 'failed CLI stdout must report delivery unknown')
  assert.match(result.stderr, /launcher delivery unknown: fake EPIPE/)
  assert.equal(takeLauncherEvent('first', f)?.line, 'pending event', 'failed CLI stdout must not consume its event')
})

test('waiter remains evaluable as a script by the existing deadline harness', () => {
  const source = readFileSync(new URL('../../../../plugin/bin/wt-lane-wait.mjs', import.meta.url), 'utf8').replace(/^import .*\n/gm, '')
  const process = { argv: ['node', 'waiter', '--help'], stdout: { write() {} }, stderr: { write() {} } }
  assert.doesNotThrow(() => runInNewContext(source, { process, Map }), 'the deadline harness must not encounter top-level await')
  assert.equal(process.exitCode, 0)
})

test('launcher waiter defaults to a bounded 55-minute wake channel', () => {
  const source = readFileSync(new URL('../../../../plugin/bin/wt-lane-wait.mjs', import.meta.url), 'utf8').replace(/^import .*\n/gm, '')
  let observed
  const process = { argv: ['node', 'waiter', '--launcher-agent', 'delegate'], env: {}, stdout: { write() {} }, stderr: { write() {} } }
  const context = { process, Map, launcherId: (id) => id,
    waitForLauncher: (_id, opts) => { observed = opts.timeout; return 0 }, startLauncherWait: (_id, opts) => { observed = opts.timeout; return 0 } }
  try { runInNewContext(source, context) } catch { /* the separate harness lock names syntax regressions */ }
  assert.equal(observed, 3300, 'the launcher wake waiter defaults to 3300 seconds')
})

test('waitForLauncher itself defaults to 3300 seconds when timeout is omitted', async () => {
  const f = fixture(); delete f.timeout
  let now = 0
  const result = await waitForLauncher('first', { ...f, poll: 4000, clock: () => now,
    sleep: async (ms) => { now += ms }, write: () => assert.fail('no event was published') })
  assert.equal(result, 125)
  assert.equal(now, 3_300_000, 'waitForLauncher fallback must expire at exactly 3300 seconds')
})

test('the earlier orchestrator wake contract explicitly excepts its own launcher waiter', () => {
  const text = readFileSync(new URL('../../../../plugin/agent-templates/pilot-orchestrator.md', import.meta.url), 'utf8')
  const contract = text.slice(text.indexOf('## Wake-up contract'), text.indexOf('## File-report contract'))
  assert.match(contract, /[Ll]auncher-waiter exception:.*your own.*background.*launcher waiter/s,
    'the main-owned disk watcher rule must explicitly allow the orchestrator launcher waiter')
  assert.match(contract, /not a self-scheduled re-check.*launcher-waiter exception/s,
    'the no-self-recheck rule must point to the launcher-waiter exception')
})

test('agent templates and skill agree on the bounded background launcher wake channel', () => {
  const read = (file) => readFileSync(new URL(`../../../../plugin/${file}`, import.meta.url), 'utf8')
  for (const name of readdirSync(new URL('../../../../plugin/agent-templates/', import.meta.url)).filter((name) => name.endsWith('.md'))) {
    assert.equal(read(`agent-templates/${name}`), read(`launch-agents/agents/${name}`), 'every agent template twin must remain byte-identical')
  }
  for (const name of ['pilot', 'pilot-orchestrator']) {
    const text = read(`agent-templates/${name}.md`)
    assert.equal(text, read(`launch-agents/agents/${name}.md`), 'agent template twins must remain byte-identical')
    assert.match(text, /launcher waiter.*wake channel/s, 'templates must distinguish the background launcher wake channel')
    assert.match(text, /other external CLI.*HARD CAP/s, 'other external CLI waits retain the in-turn hard cap')
    assert.doesNotMatch(text, /never arm your own background watcher and yield/, 'the external-lane rule must not prohibit the launcher waiter')
  }
  const skill = read('skills/external-lane/SKILL.md')
  assert.match(skill, /wt-lane-wait\.mjs --launcher-agent <id> --poll 2 --timeout 3300/, 'the example wait must be bounded at 3300 seconds')
  assert.match(skill, /[Rr]e-arm.*expiry/, 'wait-budget expiry must explicitly re-arm the wake channel')
})

test('event staging is unique, exclusive and nofollow where available', () => {
  const f = fixture(), module = new URL('../../../../plugin/bin/lib/host/launcher-events.mjs', import.meta.url).href
  const program = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const opened = [], open = fs.openSync; fs.openSync = (file, flags, ...args) => {
      const writing = typeof flags === 'number' ? flags & fs.constants.O_WRONLY : String(flags).startsWith('w');
      if (/\\.(?:tmp|ready)$/.test(String(file)) && writing) opened.push({file, flags, mode:args[0]});
      return open(file, flags, ...args);
    }; syncBuiltinESMExports(); const m = await import(${JSON.stringify(module)});
    const delivered = [], opts = {stateRoot: ${JSON.stringify(f.stateRoot)}, deliver:event=>{delivered.push(event.line)}};
    for (const key of ['one', 'two']) { m.appendLauncherEvent('first', {key, line:key}, opts); m.takeLauncherEvent('first', opts); }
    console.log(JSON.stringify({opened, delivered, exclusive:fs.constants.O_EXCL, nofollow:fs.constants.O_NOFOLLOW ?? 0}));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const { opened, delivered, exclusive, nofollow } = JSON.parse(result.stdout)
  assert.deepEqual(delivered, ['one', 'two'], 'fixture delivery must be captured separately from its JSON diagnostic')
  assert.equal(opened.length, 4, 'each publication must create both its retained staging file and its ready source')
  assert.equal(new Set(opened.map(({ file }) => file)).size, 4, 'all staging and ready names must be unique even in one process')
  for (const suffix of ['.tmp', '.ready']) {
    assert.equal(opened.filter(({ file }) => file.endsWith(suffix)).length, 2, `each publication must create a ${suffix} file`)
  }
  for (const { flags, mode } of opened) {
    assert.ok(flags & exclusive, 'staging must be created with O_EXCL (wx)')
    if (nofollow) assert.ok(flags & nofollow, 'staging must use O_NOFOLLOW where available')
    assert.equal(mode, 0o600, 'staging and ready sources must be private at creation')
  }
})

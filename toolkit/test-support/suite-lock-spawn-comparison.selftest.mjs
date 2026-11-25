import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import tseslint from 'typescript-eslint'

// Inert snapshot from before the spawn-options extraction. Never executed as a CLI.
const before = String.raw`
function spawnCommand(command, leaseLost = null, marker = null, envOverrides, timing = {}) {
  return new Promise((resolve, reject) => {
    const refusal = windowsShimArgumentRefusal(command)
    if (refusal) { reject(new Error(refusal)); return }
    const group = Boolean(leaseLost)
    const started = performance.now()
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      ...spawnParkEnvironment(marker, envOverrides, process.env),
      shell: spawnNeedsShell(command[0]),
      ...coveredCommandSpawnOptions({ broker: group }),
    })
    let forwardedSignal = null
    let lockLost = false
    let treeStopped = null
    child.once('spawn', () => { timing.started = true })
    const forward = (signal) => {
      forwardedSignal = signal
      recordForwardedCommand(timing, signal)
      if (marker) signalCoveredCommand(child, signal, { group })
      else child.kill(signal)
    }
    const stopSignals = installCommandForwarding(forward, timing)
    leaseLost?.then((reason) => {
      lockLost = true
      timing.lost = true
      process.stderr.write(` + '`wt-suite-lock: suite lock lost (${reason || \'broker gone\'}); command stopped\n`' + String.raw`)
      treeStopped = stopLeasedCommandTree(child, group, timing)
    })
    child.once('error', (error) => { stopSignals(); reject(error) })
    child.once('exit', async (code, signal) => {
      timing.heldMs = performance.now() - started
      stopSignals()
      if (lockLost) { treeStopped.then(() => resolve(75)); return }
      if (group && timing.reservation) await stopLeasedCommandTree(child, group, timing)
      if (code !== null) resolve(code)
      else resolve(parkSignalExit(signal ?? forwardedSignal))
    })
  })
}`

const source = readFileSync(new URL('../../plugin/bin/wt-suite-lock.mjs', import.meta.url), 'utf8')
const ast = tseslint.parser.parseForESLint(source, { sourceType: 'module', range: true }).ast
const names = new Set(['spawnCommand', 'spawnOwnedCommand'])
let after = ast.body.filter((node) => node.type === 'FunctionDeclaration' && names.has(node.id.name))
  .map((node) => source.slice(...node.range)).join('\n')
if (process.env.WT_SPAWN_COMPARE_MUTATE === '1') after = after.replace("stdio: 'inherit'", "stdio: 'pipe'")

function observed(value, trace, label) {
  return new Proxy(value, {
    get(target, key, receiver) { trace.push(['get', label, String(key)]); return Reflect.get(target, key, receiver) },
    set(target, key, field, receiver) { trace.push(['set', label, String(key), field]); return Reflect.set(target, key, field, receiver) },
  })
}

async function execute(body, variant) {
  const trace = []
  const handlers = {}
  const timing = { reservation: variant.group }
  let forward
  let lose
  const call = (name, implementation = () => undefined) => function (...args) {
    trace.push([name, this === undefined ? 'undefined' : Object.keys(this).sort(), JSON.parse(JSON.stringify(args.map((arg) => arg === child ? '[child]' : arg)))])
    return implementation(...args)
  }
  const child = { once: (event, handler) => { trace.push(['once', event]); handlers[event] = handler }, kill: call('kill') }
  const globals = {
    performance: { now: call('now', () => 123.5) },
    process: { env: observed({ BASE: 'inherited', COLLISION: 'base' }, trace, 'env'), stderr: { write: call('stderr') } },
    windowsShimArgumentRefusal: call('refusal', () => variant.mode === 'refused' ? 'refused shim' : null),
    spawnParkEnvironment: call('environment', (marker, overrides, env) => ({ env: { ...env, ...overrides, MARKER: marker } })),
    spawnNeedsShell: call('shell', (command) => command.endsWith('.cmd')),
    coveredCommandSpawnOptions: call('options', ({ broker }) => ({ detached: broker })),
    spawn: call('spawn', () => { if (variant.mode === 'throw') throw new Error('spawn threw'); return child }),
    recordForwardedCommand: call('recordSignal'), signalCoveredCommand: call('signalGroup'),
    installCommandForwarding: (callback, state) => { trace.push(['forwarding', { ...state }]); forward = callback; return call('close') },
    stopLeasedCommandTree: call('stopTree', () => Promise.resolve(true)),
    parkSignalExit: call('signalExit', (signal) => signal === 'SIGINT' ? 130 : 143),
  }
  const run = vm.runInNewContext(`${body}\nspawnCommand`, globals)
  const lost = variant.group ? new Promise((resolve) => { lose = resolve }) : null
  const result = run(observed([variant.shell ? 'fixture.cmd' : 'node', 'a b', '"quoted"', ''], trace, 'command'),
    lost, variant.marker ? 'lease-marker' : null,
    observed({ COLLISION: 'override', WT_SUITE_LEASE_MODE: 'reservation' }, trace, 'overrides'), observed(timing, trace, 'timing'))
    .then((value) => ({ value }), (error) => ({ error: { name: error.name, message: error.message } }))
  await finishChild(handlers, variant, forward, lose)
  return { result: await result, trace, timing }
}

async function finishChild(handlers, variant, forward, lose) {
  if (!handlers.spawn) return
  handlers.spawn()
  if (variant.mode === 'forwarded') forward('SIGINT')
  if (variant.mode === 'lost' && lose) { lose('watchdog gone'); await Promise.resolve() }
  if (variant.mode === 'error') handlers.error(new Error('spawn event error'))
  else await handlers.exit(variant.mode === 'signal' || variant.mode === 'forwarded' ? null : variant.mode === 'nonzero' ? 7 : 0,
    variant.mode === 'signal' ? 'SIGTERM' : null)
}

test('spawn extraction preserves arguments, environment, exits, errors and ordered effects', async () => {
  let count = 0
  for (const group of [false, true]) for (const marker of [false, true]) for (const shell of [false, true]) {
    for (const mode of ['ok', 'nonzero', 'signal', 'forwarded', 'lost', 'error', 'throw', 'refused']) {
      const variant = { group, marker, shell, mode }
      const baseline = await execute(before, variant)
      const current = await execute(after, variant)
      assert.deepEqual(current, baseline, `spawnCommand ${JSON.stringify(variant)} must preserve its execution trace`)
      count++
    }
  }
  console.log(`DIFFERENTIAL_CASES=${count} FUNCTIONS=1`)
})

#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runPilot } from '../../plugin/bin/lib/pilot-runner-core.mjs'
import { resolveAgentSdk, resolvedAgentSdkCodePaths } from '../../plugin/bin/lib/sdk-resolution.mjs'
import { validateParentWakeOptions, assertParentWakeProof } from '../../plugin/bin/lib/pilot-parent-wake.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const USAGE = 'Usage: node toolkit/scripts/sdk-parent-wake-e2e.mjs --parent-session "name [ref]" --parent-mode bypass|prompting [--wait-ms 240000] [--pilot-model sonnet] [--keep-fixture]'
const CRITERION = 'The PARTIAL names the cycle documents'
const VALUE_FLAGS = new Map([['--parent-session', 'parentSession'], ['--parent-mode', 'parentMode'], ['--wait-ms', 'waitMs'], ['--pilot-model', 'pilotModel']])
const LAUNCHER = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv
const log = args[args.indexOf('--log') + 1]
const brief = readFileSync(args[args.indexOf('--brief') + 1], 'utf8')
const report = /Write the report to \x60([^\x60]+)\x60/.exec(brief)[1]
const digest = /plan sha256: ([a-f0-9]{64})/.exec(brief)?.[1]
writeFileSync(report, 'VERDICT: changes-requested\\nFINDINGS:\\n- [blocking][anchor: DoD 1][location: plan.md:1] The cycle documents reading must be resolved\\n' + (digest ? 'plan sha256: ' + digest + '\\n' : ''))
appendFileSync(log, 'stub critic complete\\nEXIT=0\\n')
process.stdout.write('pid=' + process.pid + '\\n')
`

function parseArgs(argv) {
  const options = { waitMs: 240_000, pilotModel: 'sonnet', keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--help') return { help: true }
    if (argv[i] === '--keep-fixture') { options.keep = true; continue }
    readValueFlag(argv, i, options)
    i += 1
  }
  assertFlags(options)
  return options
}

function readValueFlag(argv, index, options) {
  const field = VALUE_FLAGS.get(argv[index])
  const value = argv[index + 1]
  if (!field || !value || value.startsWith('--')) throw new Error(USAGE)
  options[field] = field === 'waitMs' ? Number(value) : value
}

function assertFlags(options) {
  const error = validateParentWakeOptions(options)
  if (error || !options.parentSession) throw new Error(error ?? USAGE)
  if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 1 || options.waitMs > 900_000) throw new Error('--wait-ms must be an integer from 1 to 900000')
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sdk-parent-wake-e2e-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  try {
    writeFileSync(join(root, '.gitignore'), '.lane/\n.claude/reports/\n')
    writeFileSync(join(root, 'tracked.txt'), 'fixture\n')
    git('init', '-q'); git('add', '-A')
    git('-c', 'user.name=SDK Wake Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture')
    const dir = join(root, 'worktree'); git('worktree', 'add', '-q', '--detach', dir)
    mkdirSync(join(dir, '.lane'), { recursive: true })
    const cardFile = join(root, 'card.md'); const launcher = join(root, 'critic-launcher.mjs'); const contract = join(root, 'contract.md')
    writeFileSync(cardFile, `Route: FULL\n## Definition of done\n- ${CRITERION}\n`)
    writeFileSync(launcher, LAUNCHER)
    const instructions = `\n\n## Wake fixture\nThis is a decision-request transport fixture. Write the plan with a Card terms: reading chosen entry for "cycle documents". Use the stub critic through run; do not fix away its disputed term between the first two critic rounds. Transition the critic with changes-requested after each blocking report. After the decision binds, finish with a partial report if the stub still blocks; do not run external model lanes.\n`
    writeFileSync(contract, readFileSync(join(ROOT, 'plugin/autonomy/PILOT-CONTRACT.md'), 'utf8') + instructions)
    return { root, dir, cardFile, launcher, contract }
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error }
}

async function assertAccount(sdk, cwd) {
  const prompt = (async function* () {})()
  const abortController = new AbortController()
  const stream = sdk.query({ prompt, options: { cwd, tools: [], settingSources: [], persistSession: false, abortController } })
  let timer
  try {
    const account = await Promise.race([stream.accountInfo(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No Claude account available: account check timed out.')), 30_000) })])
    if (!account?.email && (!account?.tokenSource || account.tokenSource === 'none')) throw new Error('No Claude account available: log in before running this fixture.')
  } catch { throw new Error('No Claude account available: log in before running this fixture.') }
  finally { clearTimeout(timer); abortController.abort(); await closeAccountProbe(stream) }
}

async function closeAccountProbe(stream) {
  let timer
  try { await Promise.race([Promise.resolve().then(() => stream.close()).catch(() => {}), new Promise((done) => { timer = setTimeout(done, 5_000) })]) }
  finally { clearTimeout(timer) }
}

function runOptions(f, flags) {
  return {
    card: 'wake-fixture', cardFile: f.cardFile, dir: f.dir, archiveRoot: f.root, knowledgeBaseProjectRoot: f.root,
    contract: f.contract, parentSession: flags.parentSession, parentMode: flags.parentMode,
    timeout: Math.ceil(flags.waitMs / 1000) + 300, timeoutExplicit: true,
  }
}

function dependencies(f, flags, sdk, resolution) {
  return {
    query: sdk.query, loadedCodePaths: resolvedAgentSdkCodePaths(resolution), rules: [],
    resolvePilotModels: () => ({ sdkPilot: { value: flags.pilotModel, effective: flags.pilotModel } }),
    resolveExecutorProfile: () => ({ executor: 'gpt-lane', models: { critic: 'openai/gpt-6-sol', code: 'openai/gpt-6.1-sol', review: 'openai/gpt-6-astra', refutation: 'openai/gpt-6-astra' } }),
    decisionStateRoot: join(f.root, 'decision-state'),
    lifecycleOptions: { sdk, sdkRequire: resolution.require, laneLauncher: f.launcher, laneWaitMs: 30_000, dodDecisions: { waitMs: flags.waitMs, pollMs: 250 } },
    log: (line) => { if (line.startsWith('decision request:') || line.startsWith('parent wake:')) process.stdout.write(`${line}\n`) },
  }
}

async function runFixture(flags) {
  const f = fixture()
  try {
    const resolution = resolveAgentSdk({ projectDir: f.dir, writableRoots: [f.dir] })
    const sdk = await import(pathToFileURL(resolution.entryPath).href)
    await assertAccount(sdk, f.dir)
    const result = await captureRun(f, flags, sdk, resolution)
    printRun(result)
    assertParentWakeProof(result.summary)
    if (result.exitCode === 1) throw new Error('Runner did not finish the fixture; inspect the retained summary.')
    process.stdout.write('Transport accepted; verify the receiver transcript with no watcher armed. A parent decide is the only accepted decision.\n')
    return 0
  } finally {
    if (flags.keep) process.stdout.write(`Fixture retained: ${f.root}\n`)
    else rmSync(f.root, { recursive: true, force: true })
  }
}

async function captureRun(f, flags, sdk, resolution) {
  try { return await runPilot(runOptions(f, flags), dependencies(f, flags, sdk, resolution)) }
  catch (error) {
    let summary = { parent_wakes: [], dod_disputes: [] }
    try { summary = JSON.parse(readFileSync(join(f.dir, '.lane', 'summary.json'), 'utf8')) } catch { /* Preflight can fail before summary publication. */ }
    printRun({ exitCode: 1, summary })
    throw error
  }
}

function printRun({ exitCode, summary }) {
  process.stdout.write(`run EXIT=${exitCode}\nparent_wakes=${JSON.stringify(summary.parent_wakes)}\ndod_disputes=${JSON.stringify(summary.dod_disputes)}\n`)
}

async function main() {
  try {
    const flags = parseArgs(process.argv.slice(2))
    if (flags.help) { process.stdout.write(`${USAGE}\n`); return 0 }
    return await runFixture(flags)
  } catch (error) { process.stderr.write(`${error.message}\n`); return 1 }
}

process.exitCode = await main()
setTimeout(() => process.exit(process.exitCode), 2_000).unref()

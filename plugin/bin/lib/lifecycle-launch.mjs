// Owns receipts, attestations, and lane/gate launch; it must not decide lifecycle transitions or report commits.
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { treeSignature } from './gate-evidence.mjs'
import { launchProcess, launchProcessWithOutput, terminateProcessGroup, waitForLaneReceipt } from './lifecycle-receipts.mjs'

export const sha256 = (content) => createHash('sha256').update(content).digest('hex')
export const MAX_LANE_REPORT_BYTES = 256 * 1024

function terminalExit(content) {
  return /(?:^|\n)EXIT=([^\s\n]+)\s*$/.exec(content)?.[1] ?? null
}

export function regularFile(file) {
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

export function readRegularFile(file) {
  if (!regularFile(file)) return null
  return fs.readFileSync(file, 'utf8')
}

export function writeRegularFile(file, content, options = {}) {
  if (fs.existsSync(file) && !regularFile(file)) throw new Error(`unsafe file: ${file}`)
  fs.writeFileSync(file, content, options)
}

export function readAttestation(file) {
  const stat = regularFile(file)
  if (!stat) return null
  const content = fs.readFileSync(file, 'utf8')
  return {
    path: file,
    size: Buffer.byteLength(content),
    sha256: sha256(content),
    mtime: stat.mtimeMs,
    exit: terminalExit(content),
  }
}

export function createLifecycleLaunch({
  root,
  laneDir,
  executor,
  executorEnv,
  knowledgeBaseIndex,
  frozenModels,
  state,
  laneBriefContexts,
  prepareLaneBrief,
  assertLaneDir,
  refusal,
  lanePhases,
  phases,
  gates,
  laneLauncher,
  lanePollMs,
  laneWaitMs,
  gateRunner,
}) {
  const evidencePath = path.join(laneDir, 'evidence.json')
  const attestations = new Map()

  function audit() {
    assertLaneDir()
    writeRegularFile(
      evidencePath,
      `${JSON.stringify({ version: 1, entries: Object.fromEntries(attestations), verify_snapshot: state.verifySnapshot }, null, 2)}\n`,
    )
  }

  function attest(file, extra = {}) {
    assertLaneDir()
    const entry = readAttestation(file)
    if (!entry) return null
    const saved = { ...entry, ...extra }
    attestations.set(file, saved)
    audit()
    return saved
  }

  function verified(file) {
    assertLaneDir()
    const saved = attestations.get(file)
    const current = readAttestation(file)
    return saved && current && saved.size === current.size && saved.sha256 === current.sha256 && saved.mtime === current.mtime
      ? saved
      : null
  }

  function laneEvidence(phase, allowFailed = false) {
    assertLaneDir()
    const log = path.join(laneDir, `${phase}-run.log`)
    const report = path.join(laneDir, `${phase}-report.md`)
    const logEntry = verified(log)
    if (!logEntry) return refusal(`${phase}->next`, 'lane receipt unchanged', log)
    if (logEntry.exit !== '0' && !allowFailed) {
      return refusal(`${phase}->next`, `lane receipt EXIT=${logEntry.exit ?? 'missing'}`, log)
    }
    const reportEntry = verified(report)
    if (!reportEntry || reportEntry.size === 0) {
      return refusal(`${phase}->next`, 'non-empty unchanged lane report', report)
    }
    return null
  }

  function gatesEvidence(edge) {
    assertLaneDir()
    const currentTree = treeSignature(root)
    for (const name of gates) {
      const file = path.join(laneDir, `${name}.log`)
      const item = verified(file)
      if (!item) return refusal(edge, 'unchanged gate receipt', file)
      if (item.exit !== '0') return refusal(edge, `gate receipt EXIT=${item.exit ?? 'missing'}`, file)
      if (item.tree !== currentTree) return refusal(edge, 'current tree signature', file)
      if (item.mtime <= state.lastLaneMtime) return refusal(edge, 'gate newer than lane receipt', file)
    }
    return null
  }

  function verifySnapshot(edge) {
    const receipt = gatesEvidence(edge)
    if (receipt) return receipt
    const gateSnapshot = {}
    for (const name of gates) {
      const item = attestations.get(path.join(laneDir, `${name}.log`))
      gateSnapshot[name] = { path: item.path, sha256: item.sha256 }
    }
    state.verifySnapshot = { tree: treeSignature(root), gates: gateSnapshot }
    audit()
    return null
  }

  function snapshotEvidence(edge) {
    assertLaneDir()
    const snapshot = state.verifySnapshot
    if (!snapshot) return refusal(edge, 'verify digest snapshot', evidencePath)
    if (treeSignature(root) !== snapshot.tree) return refusal(edge, 'tree signature unchanged since verify', root)
    for (const saved of Object.values(snapshot.gates)) {
      const current = readAttestation(saved.path)
      if (!current || current.sha256 !== saved.sha256) {
        return refusal(edge, `gate digest changed (${saved.sha256} != ${current?.sha256 ?? 'missing'})`, saved.path)
      }
    }
    return null
  }

  async function run(args) {
    try { assertLaneDir() } catch (error) { return refusal(`${state.phase}->next`, error.message, laneDir) }
    if (!args || typeof args !== 'object') return refusal(`${state.phase}->next`, 'run arguments object', laneDir)
    if (args.kind === 'lane') {
      if (!lanePhases.has(state.phase) || args.phase !== state.phase) {
        return refusal(`${state.phase}->next`, 'lane for current admitted phase', path.join(laneDir, `${args.phase ?? 'unknown'}-run.log`))
      }
      const phase = args.phase
      const brief = path.join(laneDir, `${phase}-brief.md`)
      if (!laneBriefContexts.has(phase)) {
        return refusal(`${state.phase}->next`, 'brief not written through write_artifact', brief)
      }
      const canonicalLog = path.join(laneDir, `${phase}-run.log`)
      const canonicalReport = path.join(laneDir, `${phase}-report.md`)
      const timeout = Math.min(args.timeout ?? 5400, 5400)
      const launchedAt = Date.now()
      const nonce = randomUUID()
      const log = path.join(laneDir, `${phase}-run.${nonce}.log`)
      const report = path.join(laneDir, `${phase}-report.${nonce}.md`)
      if (fs.existsSync(canonicalLog) && !regularFile(canonicalLog)) {
        return refusal(`${state.phase}->next`, 'regular lane receipt', canonicalLog)
      }
      if (fs.existsSync(canonicalReport) && !regularFile(canonicalReport)) {
        return refusal(`${state.phase}->next`, 'regular lane report', canonicalReport)
      }
      fs.rmSync(canonicalLog, { force: true })
      fs.rmSync(canonicalReport, { force: true })
      let snapshot = null
      let group = 'already-gone'
      try {
        snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-lane-launch-'))
        fs.chmodSync(snapshot, 0o700)
        const launchBriefs = prepareLaneBrief(phase, laneBriefContexts.get(phase), report, snapshot)
        fs.rmSync(brief, { force: true })
        writeRegularFile(brief, launchBriefs.canonical, { flag: 'wx' })
        const snapshotBrief = path.join(snapshot, 'brief.md')
        fs.writeFileSync(snapshotBrief, launchBriefs.launch, { flag: 'wx', mode: 0o400 })
        fs.writeFileSync(log, `LANE_NONCE=${nonce}\n`, { flag: 'wx' })
        let launch
        try {
          const launcher = laneLauncher ?? path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            '..',
            executor === 'claude-sdk' ? 'wt-claude-executor.mjs' : 'wt-lane.mjs',
          )
          const model = phase === 'tdd' || phase === 'harden'
            ? frozenModels.code
            : phase === 'refutation'
              ? frozenModels.refutation
              : phase === 'critic'
                ? frozenModels.critic
                : frozenModels.review
          launch = await launchProcessWithOutput(
            process.execPath,
            [
              launcher,
              '--dir', root,
              '--model', model,
              '--brief', snapshotBrief,
              '--log', log,
              '--timeout', String(timeout),
              // The lifecycle knows the phase; the Claude executor derives read-only from it, never from brief text.
              ...(executor === 'claude-sdk' ? ['--role', phase] : []),
              ...(executor === 'claude-sdk' && ['critic', 'review', 'refutation'].includes(phase) && knowledgeBaseIndex
                ? ['--knowledge-base-index', knowledgeBaseIndex]
                : []),
            ],
            { cwd: root, ...(executor === 'claude-sdk' ? { env: executorEnv } : {}) },
          )
        } catch (error) {
          return refusal(`${state.phase}->next`, `lane spawn (${error instanceof Error ? error.message : String(error)})`, log)
        }
        const workerPid = Number(/^pid=(\d+)$/m.exec(launch.stdout)?.[1])
        if (!Number.isSafeInteger(workerPid) || workerPid <= 1) return refusal(`${state.phase}->next`, 'launcher pid', log)
        const logEntry = await waitForLaneReceipt({
          log,
          nonce,
          timeoutMs: laneWaitMs ?? timeout * 1000,
          launchedAt,
          pollMs: lanePollMs,
          readAttestation,
          readRegularFile,
        })
        group = await terminateProcessGroup(workerPid)
        const reportStat = regularFile(report)
        if (!logEntry || !regularFile(log) || !reportStat) return `lane ${phase} EXIT=missing`
        if (reportStat.size > MAX_LANE_REPORT_BYTES) {
          return refusal(`${phase}->next`, `lane report exceeds ${MAX_LANE_REPORT_BYTES}-byte limit`, report)
        }
        assertLaneDir()
        if (fs.existsSync(canonicalLog) && !regularFile(canonicalLog)) {
          return refusal(`${state.phase}->next`, 'regular lane receipt', canonicalLog)
        }
        fs.rmSync(canonicalLog, { force: true })
        fs.rmSync(canonicalReport, { force: true })
        try {
          fs.copyFileSync(log, canonicalLog, fs.constants.COPYFILE_EXCL)
          fs.copyFileSync(report, canonicalReport, fs.constants.COPYFILE_EXCL)
        } catch (error) {
          fs.rmSync(canonicalLog, { force: true })
          fs.rmSync(canonicalReport, { force: true })
          return refusal(`${state.phase}->next`, `publish lane pair (${error instanceof Error ? error.message : String(error)})`, canonicalLog)
        }
        attest(canonicalReport)
        attest(canonicalLog, { group })
        state.lastLaneMtime = logEntry.mtime
        return `lane ${phase} EXIT=${logEntry.exit}`
      } catch (error) {
        fs.rmSync(path.join(laneDir, `${phase}-input.diff`), { force: true })
        fs.rmSync(brief, { force: true })
        return `review input unavailable: ${error instanceof Error ? error.message : String(error)}`
      } finally {
        if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true })
      }
    }
    if (args.kind === 'gate') {
      if (!gates.has(args.name)) {
        return refusal(`${state.phase}->next`, 'gate typecheck|lint|test', path.join(laneDir, `${args.name ?? 'unknown'}.log`))
      }
      const log = path.join(laneDir, `${args.name}.log`)
      if (fs.existsSync(log) && !regularFile(log)) return refusal(`${state.phase}->next`, 'regular gate receipt', log)
      fs.rmSync(log, { force: true })
      fs.writeFileSync(log, '', { flag: 'wx' })
      let code
      try {
        if (gateRunner) code = await gateRunner({ name: args.name, log, root })
        else {
          const out = fs.openSync(log, 'a')
          const err = fs.openSync(log, 'a')
          try {
            code = await launchProcess('pnpm', [args.name], { cwd: path.join(root, 'toolkit'), stdio: ['ignore', out, err] })
          } finally {
            fs.closeSync(out)
            fs.closeSync(err)
          }
        }
      } catch (error) {
        return refusal(`${state.phase}->next`, `gate spawn (${error instanceof Error ? error.message : String(error)})`, log)
      }
      fs.appendFileSync(log, `\nEXIT=${code}\n`)
      attest(log, { tree: treeSignature(root) })
      return `gate ${args.name} EXIT=${code}`
    }
    if (args.kind === 'inspect') {
      const allowed = [...gates]
        .map((name) => `${name}.log`)
        .concat(phases.filter((phase) => lanePhases.has(phase)).flatMap((phase) => [`${phase}-run.log`, `${phase}-report.md`]))
      if (!['diff', 'status', 'log'].includes(args.what)) return refusal(`${state.phase}->next`, 'inspect diff|status|log', laneDir)
      if (args.what === 'log' && !allowed.includes(args.name)) {
        return refusal(`${state.phase}->next`, `log name ${allowed.join('|')}`, laneDir)
      }
      if (args.what === 'log' && !regularFile(path.join(laneDir, args.name))) {
        return refusal(`${state.phase}->next`, 'regular inspect log', path.join(laneDir, args.name))
      }
      return execFileSync(
        args.what === 'log' ? 'tail' : 'git',
        args.what === 'log'
          ? ['-n', '1', path.join(laneDir, args.name)]
          : args.what === 'diff' ? ['diff', '--stat'] : ['status', '--short'],
        { cwd: root, encoding: 'utf8' },
      )
    }
    return refusal(`${state.phase}->next`, 'run kind lane|gate|inspect', laneDir)
  }

  return { audit, evidencePath, laneEvidence, run, snapshotEvidence, verifySnapshot }
}

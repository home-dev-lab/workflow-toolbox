// Owns receipts, attestations, and lane/gate launch; it must not decide lifecycle transitions or report commits.
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { treeSignature } from './gate-evidence.mjs'
import { launchProcess, launchProcessWithOutput, waitForLaneReceipt } from './lifecycle-receipts.mjs'
import { resolveRoleVariant } from './lane-model-allowlist.mjs'
import { classifyLane, shellQuote, supervisionPaths } from './lane-supervisor-core.mjs'

export const sha256 = (content) => createHash('sha256').update(content).digest('hex')
export const MAX_LANE_REPORT_BYTES = 256 * 1024
const LANE_PREFLIGHT_BOUND_MS = 3_000 + 3 * 30_000 + 7_000
const CONTROL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'wt-lane-control.mjs')

function launchVariant(phase, model, env) {
  const role = ['tdd', 'harden'].includes(phase) ? 'code' : phase
  return { role, ...resolveRoleVariant(role, model, { env }) }
}

function launchVariantArgs(executor, variant) {
  return executor === 'claude-sdk'
    ? ['--variant', variant.value, '--variant-origin', variant.origin]
    : ['--role', variant.role]
}

function terminalExit(content) {
  return /(?:^|\n)EXIT=([^\s\n]+)\s*$/.exec(content)?.[1] ?? null
}

function reportFinding(line) {
  if (!['-', '*', '+'].includes(line[0]) || line[1] !== ' ' || !line.slice(2).trim()) return null
  return line.slice(2).trim()
}

function combinedCriticReport(reports) {
  const parsed = reports.map((content) => {
    const outcome = /^VERDICT:\s*(approved|changes-requested)\s*$/mi.exec(content)?.[1]
    const findingsText = /^FINDINGS:\s*$([\s\S]*)/mi.exec(content)?.[1] ?? ''
    const lines = findingsText.split(/\r?\n/)
    const sectionEnd = lines.findIndex((line) => /^#/.test(line))
    const findings = (sectionEnd < 0 ? lines : lines.slice(0, sectionEnd)).map(reportFinding).filter(Boolean)
    const attackAccount = /(?:^|\n)## No-finding attack account\s*\r?\n\s*\S[\s\S]*?(?=\r?\n## |$)/i.exec(content)?.[0].trim() ?? null
    return { outcome, findings, attackAccount }
  })
  if (parsed.some((report) => !report.outcome || report.outcome === 'changes-requested' && report.findings.length === 0)) return null
  const findings = [...new Set(parsed.flatMap((report) => report.findings))]
  const outcome = parsed.every((report) => report.outcome === 'approved') ? 'approved' : 'changes-requested'
  const digest = reports.map((content) => /^plan sha256:\s*[a-f0-9]{64}\s*$/mi.exec(content)?.[0]).find(Boolean)
  const findingLines = findings.map((finding) => `- ${finding}`).join('\n')
  const attackAccount = outcome === 'approved' && parsed.every((report) => report.attackAccount)
    ? `\n## No-finding attack account\n${parsed.map((report, index) => `### Lane ${index + 1}\n${report.attackAccount.replace(/^## No-finding attack account\s*/i, '').trim()}`).join('\n\n')}\n`
    : ''
  return `VERDICT: ${outcome}\nFINDINGS:\n${findingLines}${findings.length ? '\n' : ''}${digest ?? ''}\n${attackAccount}`
}

function criticLaneLaunchIdentity(laneId, executorEnv) {
  if (!laneId) return { suffix: '', noncePart: '', slot: null, env: executorEnv }
  const slot = `critic-${laneId}`
  return { suffix: `-${laneId}`, noncePart: `.${laneId}`, slot, env: { ...executorEnv, WT_LANE_SUPERVISION_SLOT: slot } }
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
  lanePlatform,
  gateRunner,
  now = () => Date.now(),
  recordLaneStart = () => null,
  recordLaneEnd = () => {},
}) {
  const evidencePath = path.join(laneDir, 'evidence.json')
  const attestations = new Map()

  const controlRemedy = (token) => `pilot: run { kind: 'control', decision: 'abandon' } or run { kind: 'control', decision: 'extend' }; human: extend with node ${shellQuote(CONTROL)} --dir ${shellQuote(root)} --decision extend --owner-token ${shellQuote(token)}, or abandon with node ${shellQuote(CONTROL)} --dir ${shellQuote(root)} --decision abandon --owner-token ${shellQuote(token)}`
  const timeoutResult = (phase, detail, token) => {
    state.pendingControl = { phase, token }
    return `lane ${phase} TIMEOUT: ${detail}; ${controlRemedy(token)}; after abandon completes, re-run this lifecycle lane phase to launch a fresh owner-bound lane and brief`
  }

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

  async function runParallelCritics(args) {
    const laneIds = ['A', 'B']
    const results = await Promise.all(laneIds.map((criticLane) => runSingle({ ...args, criticLane })))
    const laneLogs = laneIds.map((criticLane) => path.join(laneDir, `critic-${criticLane}-run.log`))
    const laneReports = laneIds.map((criticLane) => path.join(laneDir, `critic-${criticLane}-report.md`))
    const receipts = laneLogs.map(readAttestation)
    if (receipts.some((receipt) => !receipt) || laneReports.some((report) => !regularFile(report))) {
      return results.find((result) => result !== 'lane critic EXIT=0') ?? 'lane critic EXIT=missing'
    }
    const failed = receipts.find((receipt) => receipt.exit !== '0')
    const exit = failed?.exit ?? '0'
    const canonicalLog = path.join(laneDir, 'critic-run.log')
    const canonicalReport = path.join(laneDir, 'critic-report.md')
    const laneLogSections = laneIds.map((laneId, index) => `LANE=${laneId}\n${readRegularFile(laneLogs[index])}`)
    writeRegularFile(canonicalLog, `${laneLogSections.join('\n')}\nEXIT=${exit}\n`)
    const combinedReport = combinedCriticReport(laneReports.map(readRegularFile))
    if (!combinedReport) return refusal('critic->next', 'valid verdict blocks from both critic lanes', canonicalReport)
    writeRegularFile(canonicalReport, combinedReport)
    attest(canonicalReport)
    attest(canonicalLog, { group: 'worker-owned' })
    state.lastLaneMtime = Math.max(...receipts.map((receipt) => receipt.mtime))
    return `lane critic EXIT=${exit}`
  }

  async function runSingle(args) {
    try { assertLaneDir() } catch (error) { return refusal(`${state.phase}->next`, error.message, laneDir) }
    if (!args || typeof args !== 'object') return refusal(`${state.phase}->next`, 'run arguments object', laneDir)
    if (args.kind === 'lane') {
      if (!lanePhases.has(state.phase) || args.phase !== state.phase) {
        return refusal(`${state.phase}->next`, 'lane for current admitted phase', path.join(laneDir, `${args.phase ?? 'unknown'}-run.log`))
      }
      const phase = args.phase
      const identity = criticLaneLaunchIdentity(args.criticLane, executorEnv)
      const brief = path.join(laneDir, `${phase}${identity.suffix}-brief.md`)
      if (!laneBriefContexts.has(phase)) {
        return refusal(`${state.phase}->next`, 'brief not written through write_artifact', brief)
      }
      const canonicalLog = path.join(laneDir, `${phase}${identity.suffix}-run.log`)
      const canonicalReport = path.join(laneDir, `${phase}${identity.suffix}-report.md`)
      const timeout = Math.min(args.timeout ?? 5400, 5400)
      const launchedAt = now()
      const nonce = randomUUID()
      const log = path.join(laneDir, `${phase}-run${identity.noncePart}.${nonce}.log`)
      const report = path.join(laneDir, `${phase}-report${identity.noncePart}.${nonce}.md`)
      if (fs.existsSync(canonicalLog) && !regularFile(canonicalLog)) {
        return refusal(`${state.phase}->next`, 'regular lane receipt', canonicalLog)
      }
      if (fs.existsSync(canonicalReport) && !regularFile(canonicalReport)) {
        return refusal(`${state.phase}->next`, 'regular lane report', canonicalReport)
      }
      fs.rmSync(canonicalLog, { force: true })
      fs.rmSync(canonicalReport, { force: true })
      let snapshot = null
      let group = 'worker-owned'
      let laneRecord = null
      try {
        snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-lane-launch-'))
        fs.chmodSync(snapshot, 0o700)
        const launchBriefs = prepareLaneBrief(phase, laneBriefContexts.get(phase), report, snapshot)
        fs.rmSync(brief, { force: true })
        writeRegularFile(brief, launchBriefs.canonical, { flag: 'wx' })
        const snapshotBrief = path.join(snapshot, 'brief.md')
        fs.writeFileSync(snapshotBrief, launchBriefs.launch, { flag: 'wx', mode: 0o400 })
        fs.writeFileSync(log, `LANE_NONCE=${nonce}\n`, { flag: 'wx' })
        const model = phase === 'tdd' || phase === 'harden'
          ? frozenModels.code
          : phase === 'refutation'
            ? frozenModels.refutation
            : phase === 'critic'
              ? frozenModels.critic
              : frozenModels.review
        let launch
        try {
          const variant = launchVariant(phase, model, executorEnv)
          const launcher = laneLauncher ?? path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            '..',
            executor === 'claude-sdk' ? 'wt-claude-executor.mjs' : 'wt-lane.mjs',
          )
          laneRecord = recordLaneStart({ phase, model, startedAt: launchedAt, usageFile: `${path.basename(log)}.usage.json`, laneId: args.criticLane })
          launch = await launchProcessWithOutput(
            process.execPath,
            [
              launcher,
              '--dir', root,
              '--model', model,
              '--brief', snapshotBrief,
              '--log', log,
              '--timeout', String(timeout),
              ...launchVariantArgs(executor, variant),
              ...(executor === 'claude-sdk' ? [] : ['--owner', 'pilot', '--owner-token', nonce, '--brief-cleanup-dir', snapshot]),
              // The lifecycle knows the phase; the Claude executor derives read-only from it, never from brief text.
              ...(executor === 'claude-sdk' ? ['--role', phase] : []),
              ...(executor === 'claude-sdk' && ['critic', 'review', 'refutation'].includes(phase) && knowledgeBaseIndex
                ? ['--knowledge-base-index', knowledgeBaseIndex]
                : []),
            ],
            {
              cwd: root,
              stdoutPath: path.join(snapshot, 'launcher.stdout'),
              stderrPath: path.join(snapshot, 'launcher.stderr'),
              env: identity.env,
            },
          )
        } catch (error) {
          return refusal(`${state.phase}->next`, `lane spawn (${error instanceof Error ? error.message : String(error)})`, log)
        }
        const workerPid = Number(/^pid=(\d+)$/m.exec(launch.stdout)?.[1])
        if (!Number.isSafeInteger(workerPid) || workerPid <= 1) return refusal(`${state.phase}->next`, 'launcher pid', log)
        let logEntry = await waitForLaneReceipt({
          log,
          nonce,
          timeoutMs: laneWaitMs ?? timeout * 1000,
          launchedAt,
          pollMs: lanePollMs,
          readAttestation,
          readRegularFile,
        })
        if (!logEntry) {
          const runId = /^run=(\d+-\d+)$/m.exec(launch.stdout)?.[1] ?? null
          const supervisionFile = runId ? supervisionPaths(root, runId, identity.slot).record : null
          const supervisionPointer = runId ? supervisionPaths(root, null, identity.slot).pointer : null
          let status = supervisionFile ? readRegularFile(supervisionFile) : null
          if (runId) {
            let pointerRunId = null
            try { pointerRunId = JSON.parse(readRegularFile(supervisionPointer)).runId } catch {}
            const preflightDeadline = Date.now() + LANE_PREFLIGHT_BOUND_MS
            const workerLaunching = () => { try { return JSON.parse(status).state === 'launching' } catch { return false } }
            while ((!status || pointerRunId !== runId || workerLaunching()) && Date.now() < preflightDeadline) {
              await new Promise((resolve) => setTimeout(resolve, 25))
              try { pointerRunId = JSON.parse(readRegularFile(supervisionPointer)).runId } catch {}
              status = readRegularFile(supervisionFile)
            }
          }
          let parsed = null
          try {
            parsed = JSON.parse(status)
            let verdict = classifyLane(parsed, { platform: lanePlatform })
            if (parsed.workerPid === workerPid && parsed.owner === 'pilot' && verdict.status === 'running') {
              const transitionDueAt = Date.parse(parsed.decisionTransitionDueAt)
              while (!logEntry && verdict.status === 'running' && parsed.workerPid === workerPid && Date.now() <= transitionDueAt) {
                logEntry = await waitForLaneReceipt({
                  log,
                  nonce,
                  timeoutMs: Math.min(25, Math.max(0, transitionDueAt - Date.now())),
                  launchedAt,
                  pollMs: lanePollMs,
                  readAttestation,
                  readRegularFile,
                })
                status = readRegularFile(supervisionFile)
                parsed = JSON.parse(status)
                verdict = classifyLane(parsed, { platform: lanePlatform })
              }
            }
            verdict = classifyLane(parsed, { platform: lanePlatform })
            if (!logEntry && parsed.workerPid === workerPid && parsed.owner === 'pilot' && verdict.status === 'decision-needed') {
              const detail = `owner=${parsed.owner} decision required; lane remains live; last write ${parsed.evidence?.lastWriteAt ?? 'unknown'}; process ${parsed.evidence?.process ?? 'unknown'}; log tail ${JSON.stringify(parsed.evidence?.logTail ?? '')}; default=${parsed.defaultDecision} at ${parsed.decisionDueAt}`
              snapshot = null
              return timeoutResult(phase, detail, nonce)
            }
            if (!logEntry && parsed.workerPid === workerPid && parsed.owner === 'pilot' && verdict.status === 'running') {
              snapshot = null
              return timeoutResult(phase, `owner=${parsed.owner}; live worker is still completing its bounded timeout transition; wait for the decision point before choosing; no process was killed`, nonce)
            }
            if (!logEntry && verdict.status === 'worker-gone-child-alive') {
              snapshot = null
              return timeoutResult(phase, `worker-gone-child-alive; surviving child pid=${parsed.childPid}; no process was killed`, nonce)
            }
            if (!logEntry && verdict.status === 'unknown') {
              snapshot = null
              return timeoutResult(phase, `unknown liveness (${verdict.reason}); no process was killed`, nonce)
            }
            if (!logEntry && verdict.status === 'gone') return `lane ${phase} EXIT=missing`
            if (!logEntry && verdict.status === 'terminal') return `lane ${phase} TERMINAL receipt=missing`
            if (!logEntry) {
              snapshot = null
              return timeoutResult(phase, `${verdict.status}; no process was killed`, nonce)
            }
          } catch {}
          if (!logEntry) {
            snapshot = null
            return timeoutResult(phase, 'unknown liveness; no process was killed', nonce)
          }
        }
        if (logEntry) {
          const runId = /^run=(\d+-\d+)$/m.exec(launch.stdout)?.[1] ?? null
          if (runId) {
            let record = null
            try { record = JSON.parse(readRegularFile(supervisionPaths(root, runId, identity.slot).record)) } catch {}
            let verdict = classifyLane(record, { platform: lanePlatform })
            const settleDeadline = Date.now() + 1_000
            while (!['terminal', 'gone'].includes(verdict.status) && Date.now() < settleDeadline) {
              await new Promise((resolve) => setTimeout(resolve, lanePollMs))
              try { record = JSON.parse(readRegularFile(supervisionPaths(root, runId, identity.slot).record)) } catch {}
              verdict = classifyLane(record, { platform: lanePlatform })
            }
            if (!['terminal', 'gone'].includes(verdict.status)) {
              snapshot = null
              return timeoutResult(phase, `receipt arrived while liveness is ${verdict.status}; no process was killed`, nonce)
            }
          }
        }
        recordLaneEnd(laneRecord, now(), logEntry?.exit)
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
        if (laneRecord?.ended_at === null) recordLaneEnd(laneRecord, now(), 'missing')
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
    if (args.kind === 'control') {
      if (!['abandon', 'extend'].includes(args.decision)) return refusal(`${state.phase}->next`, 'control decision abandon|extend', laneDir)
      const pending = state.pendingControl
      if (!pending || pending.phase !== state.phase) return refusal(`${state.phase}->next`, 'timed-out lane owned by this lifecycle', laneDir)
      const command = ['--dir', root, '--decision', args.decision, '--owner-token', pending.token]
      if (args.decision === 'extend' && args.extendSeconds !== undefined) command.push('--extend', String(args.extendSeconds))
      try {
        const output = execFileSync(process.execPath, [CONTROL, ...command], { cwd: root, encoding: 'utf8' })
        state.pendingControl = null
        return `control ${args.decision} accepted: ${output.trim()}`
      } catch (error) {
        const detail = error?.stderr?.toString().trim() || (error instanceof Error ? error.message : String(error))
        return refusal(`${state.phase}->next`, `control ${args.decision} (${detail})`, laneDir)
      }
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
    return refusal(`${state.phase}->next`, 'run kind lane|gate|inspect|control', laneDir)
  }

  function run(args) {
    const parallelCritic = args?.kind === 'lane' && args.phase === 'critic' && state.priorCriticRounds.length === 0 && !args.criticLane
    return parallelCritic ? runParallelCritics(args) : runSingle(args)
  }

  return { audit, evidencePath, laneEvidence, run, snapshotEvidence, verifySnapshot }
}

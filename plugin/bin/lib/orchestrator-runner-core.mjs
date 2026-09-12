import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { treeSignature } from './gate-evidence.mjs'

const DEFAULTS = { concurrency: 1, base: 'develop', pilotTimeout: 5400, boardUrl: 'http://localhost:25478/mcp', maxCards: Infinity, maxMinutes: Infinity, missionLabels: [], hard: [] }
const ELIGIBLE_LISTS = new Set(['Backlog', 'Next', 'In Progress'])
const cardList = (result) => Array.isArray(result) ? result : Array.isArray(result?.cards) ? result.cards : Array.isArray(result?.items) ? result.items : null
const listName = (card) => card?.listName ?? card?.list?.name ?? card?.list ?? ''
const labels = (card) => (card?.labels ?? []).map((item) => typeof item === 'string' ? item : item.name)
const under = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
const errorText = (error) => error instanceof Error ? error.message : String(error)
const cardText = (card) => card.markdown ?? card.text ?? card.description ?? JSON.stringify(card, null, 2)
const receiptExit = (file, fallback = 1) => {
  try { return Number(/(?:^|\n)EXIT=(\d+)\s*$/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? fallback) } catch { return fallback }
}

export function parseOrchestratorArgs(argv) {
  const options = { ...DEFAULTS, cards: null, missionList: null, missionLabels: [], hard: [], worktreesDir: null, report: null, profileEnv: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--cards') options.cards = next()?.split(',').filter(Boolean) ?? []
    else if (arg === '--mission-list') options.missionList = next()
    else if (arg === '--mission-label') options.missionLabels.push(next())
    else if (arg === '--max-cards') options.maxCards = Number(next())
    else if (arg === '--max-minutes') options.maxMinutes = Number(next())
    else if (arg === '--concurrency') options.concurrency = Number(next())
    else if (arg === '--hard') options.hard = next()?.split(',').filter(Boolean) ?? []
    else if (arg === '--base') options.base = next()
    else if (arg === '--worktrees-dir') options.worktreesDir = next()
    else if (arg === '--report') options.report = next()
    else if (arg === '--profile-env') options.profileEnv = next()
    else if (arg === '--pilot-timeout') options.pilotTimeout = Number(next())
    else if (arg === '--board-url') options.boardUrl = next()
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!!options.cards === !!options.missionList) return { error: 'provide exactly one of --cards or --mission-list' }
  if (!options.worktreesDir || !options.report) return { error: '--worktrees-dir and --report are required' }
  if (![options.concurrency, options.pilotTimeout].every((value) => Number.isInteger(value) && value > 0) || !(options.maxCards > 0) || !(options.maxMinutes > 0)) return { error: 'numeric options must be positive' }
  return options
}

async function paginate(board, list) {
  const found = []
  for (let offset = 0;;) {
    const page = await board.findCards({ listName: list, limit: 100, offset })
    const cards = cardList(page)
    if (!cards) throw new Error('board unavailable: malformed find_cards response')
    found.push(...cards)
    offset += cards.length
    const total = Number(page?.total ?? found.length)
    if (!Number.isFinite(total)) throw new Error('board unavailable: malformed find_cards total')
    if (cards.length === 0 || offset >= total) return found
  }
}

async function eligibleMission(card, requiredLabels, board, known) {
  const all = labels(card)
  if (!['P0', 'P1', 'P2'].some((label) => all.includes(label))) return false
  if (!['feature', 'chore', 'bug', 'research'].some((label) => all.includes(label))) return false
  if (!['effort:S', 'effort:M', 'effort:L'].some((label) => all.includes(label))) return false
  if (!requiredLabels.every((label) => all.includes(label))) return false
  const lines = String(card.description ?? card.text ?? '').split(/\r?\n/).filter((line) => /^\s*Depends-on:/i.test(line))
  for (const line of lines) {
    const value = line.replace(/^\s*Depends-on:\s*/i, '').trim()
    if (/^none$/i.test(value)) continue
    const match = /^#?(\d+)$/.exec(value)
    if (!match) return false
    let dependency = known.get(match[1])
    if (!dependency) { dependency = await board.getCard(match[1]); known.set(match[1], dependency) }
    if (listName(dependency) !== 'Done') return false
  }
  return true
}

function runLogged(program, args, cwd, log) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' })
  fs.writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}${/\n$/.test(`${result.stdout ?? ''}${result.stderr ?? ''}`) ? '' : '\n'}EXIT=${result.status ?? 1}\n`)
  return result.status ?? 1
}

async function defaultGates(worktree, cardDir) {
  const result = {}
  for (const name of ['typecheck', 'lint', 'test']) result[name] = runLogged('pnpm', [name], path.join(worktree, 'toolkit'), path.join(cardDir, `${name}.log`))
  return result
}

function defaultFidelity(repo, { worktree, cardDir, id, waveId, base, head }) {
  const cli = path.join(repo, 'plugin/bin/wt-pilot-fidelity.mjs')
  const bundle = path.join(cardDir, 'fidelity')
  const freeze = runLogged(process.execPath, [cli, 'freeze', '--root', worktree, '--out-dir', bundle, '--card', id, '--session', waveId, '--base', base, '--head', head, '--file', '.lane/pilot-report.md', '--other-file', '.lane/summary.json'], repo, path.join(cardDir, 'fidelity-freeze.log'))
  if (freeze !== 0) { fs.writeFileSync(path.join(cardDir, 'fidelity-verify.log'), 'freeze failed\nEXIT=1\n'); return 1 }
  return runLogged(process.execPath, [cli, 'verify', '--root', worktree, '--dir', bundle, '--require-same-tree', '--require-head'], repo, path.join(cardDir, 'fidelity-verify.log'))
}

function branchExists(git, repo, branch) {
  try { git('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }); return true } catch { return false }
}

function renderReport({ waveId, options, rows, stopReason, fatal, judgment }) {
  const verification = rows.map((row) => `| ${row.id} | ${row.route ?? '-'} | ${row.pilot ?? '-'} | ${row.gates ?? '-'} | ${row.clean ?? '-'} | ${row.reportCheck ?? '-'} | ${row.fidelity ?? '-'} | ${row.files?.join(', ') || '-'} | ${row.decision ?? 'undecided'} | ${row.reason ?? '-'} |`).join('\n') || '| - | - | - | - | - | - | - | - | - | - |'
  const overlaps = []
  for (let left = 0; left < rows.length; left += 1) for (let right = left + 1; right < rows.length; right += 1) {
    const common = rows[left].files?.filter((file) => rows[right].files?.includes(file)) ?? []
    if (common.length) overlaps.push(`${rows[left].id}/${rows[right].id}: ${common.join(', ')}`)
  }
  const risks = [fatal, ...rows.filter((row) => row.decision === 'undecided').map((row) => `undecided card ${row.id}`), ...rows.filter((row) => row.pilot === 1 || row.pilot === 2).map((row) => `pilot EXIT=${row.pilot} card ${row.id}`), ...overlaps.map((item) => `seam overlap ${item}`)].filter(Boolean)
  const escalations = []
  for (const row of rows) {
    if (row.pilot !== 0) escalations.push(`card ${row.id}: pilot EXIT=${row.pilot}`)
    if (row.decision === 'accepted') escalations.push(`card ${row.id}: main should merge ${row.branch} at ${row.head} after seam review and merged-tree gates`)
    else escalations.push(`card ${row.id}: ${row.decision ?? 'undecided'}${row.reason ? ` (${row.reason})` : ''}`)
  }
  const modelSections = judgment?.trim() || '## Independent Review\nsession ended before judgment\n\n## Decisions\nsession ended before judgment'
  return `## Implemented\nwave=${waveId}; base=${options.base}; cards=${rows.map((row) => row.id).join(',') || 'none'}; stop=${stopReason}\n\n## Verification\n| Card | Route | Pilot exit | Gates | Clean | Findings | Fidelity | Files touched | Decision | Reason |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${verification}\n\n${modelSections}\n\n## Remaining Risks\n${risks.join('\n') || 'None.'}\n\n## Escalations for main\n${escalations.join('\n') || 'None.'}\n\n## Findings\nNone.\n`
}

export async function runOrchestrator(input, dependencies = {}) {
  const options = { ...DEFAULTS, ...input }
  const git = dependencies.git ?? ((program, args, opts) => execFileSync(program, args, opts))
  const now = dependencies.now ?? (() => Date.now())
  const writeFile = dependencies.writeFile ?? fs.writeFileSync
  const board = dependencies.board
  const runPilot = dependencies.runPilot
  const waveId = options.waveId ?? randomUUID().slice(0, 8)
  const report = path.resolve(options.report)
  const waveDir = path.resolve(options.worktreesDir, `wave-${waveId}`)
  const rows = []
  const startedAt = options.startedAt ?? now()
  let stopReason = 'no eligible card'
  let fatal = null
  let judgment = ''
  let repo = ''

  const emit = () => {
    fs.mkdirSync(path.dirname(report), { recursive: true })
    writeFile(report, renderReport({ waveId, options, rows, stopReason, fatal, judgment }))
  }

  try {
    repo = String(git('git', ['rev-parse', '--show-toplevel'], { cwd: options.cwd ?? process.cwd(), encoding: 'utf8' })).trim()
    if (options.base === 'main') throw new Error('base main is refused')
    if (!under(repo, path.resolve(options.worktreesDir))) throw new Error('worktrees dir is outside repository root')
    if (options.maxMinutes * 60 < options.pilotTimeout) throw new Error('time budget below one pilot timeout')
    if (!board) throw new Error('board unavailable: no board client')
    if (!runPilot) throw new Error('driver error: no pilot runner')
    fs.mkdirSync(waveDir, { recursive: true })
    const hooks = path.join(waveDir, 'hooks')
    fs.mkdirSync(hooks, { recursive: true })
    for (const [name, action] of [['pre-push', 'push'], ['pre-merge-commit', 'merge']]) {
      const hook = path.join(hooks, name)
      writeFile(hook, `#!/bin/sh\nprintf '%s\\n' "refused by wave ${waveId}: ${action} is main's" >&2\nexit 1\n`)
      fs.chmodSync(hook, 0o755)
    }
    git('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: repo })

    const scanMission = async () => {
      const all = await paginate(board, options.missionList)
      const known = new Map(all.map((card) => [String(card.id), card]))
      const eligible = []
      for (const card of all) if (await eligibleMission(card, options.missionLabels, board, known)) eligible.push(card)
      return eligible
    }
    let candidates
    if (options.cards) {
      candidates = []
      for (const id of [...new Set(options.cards.map(String))]) {
        const card = await board.getCard(id)
        if (!card) throw new Error(`card absent from board: ${id}`)
        if (card && ELIGIBLE_LISTS.has(listName(card))) candidates.push(card)
      }
    } else {
      candidates = await scanMission()
    }
    const moreThanLimit = candidates.length > options.maxCards
    candidates = candidates.slice(0, options.maxCards)
    for (const card of candidates) {
      const id = String(card.id)
      const branch = `card/${id}-wave-${waveId}`
      const worktree = path.join(waveDir, id)
      if (branchExists(git, repo, branch)) throw new Error(`branch already exists: ${branch}`)
      if (fs.existsSync(worktree)) throw new Error(`worktree already exists: ${worktree}`)
    }

    const prepare = async (card) => {
      const id = String(card.id)
      if ((now() - startedAt) / 1000 + options.pilotTimeout > options.maxMinutes * 60) return null
      const branch = `card/${id}-wave-${waveId}`
      const worktree = path.join(waveDir, id)
      const cardDir = path.join(waveDir, 'cards', id)
      const row = { id, branch, worktree, cardDir, decision: 'undecided' }
      rows.push(row)
      fs.mkdirSync(cardDir, { recursive: true })
      const snapshot = path.join(cardDir, 'card.md')
      writeFile(snapshot, cardText(card))
      await board.moveCard(id, 'In Progress')
      git('git', ['worktree', 'add', '-b', branch, worktree, options.base], { cwd: repo })
      git('git', ['config', '--worktree', 'core.hooksPath', hooks], { cwd: worktree })
      const runnerLog = path.join(cardDir, 'runner.log')
      const pilotDependencies = { ...(dependencies.pilotDependencies ?? {}), log: (line) => fs.appendFileSync(runnerLog, `${line}\n`) }
      const pilot = await runPilot({ card: id, cardFile: snapshot, dir: worktree, hard: options.hard.includes(id), profileEnv: options.profileEnv, timeout: options.pilotTimeout, boardMoves: false }, pilotDependencies)
      row.pilot = pilot.exitCode
      row.route = /^route=(LITE|FULL)\b/.exec(fs.existsSync(runnerLog) ? fs.readFileSync(runnerLog, 'utf8') : '')?.[1] ?? pilot.summary?.route ?? '-'
      writeFile(path.join(cardDir, 'pilot.log'), `EXIT=${pilot.exitCode}\n`)
      for (const name of ['summary.json', 'usage.json', 'sdk-transcript.json', 'pilot-report.md']) {
        const source = path.join(worktree, '.lane', name)
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(cardDir, name))
      }
      const beforeGates = treeSignature(worktree)
      const gateResult = await (dependencies.gates ?? defaultGates)(worktree, cardDir)
      for (const name of ['typecheck', 'lint', 'test']) if (!fs.existsSync(path.join(cardDir, `${name}.log`))) writeFile(path.join(cardDir, `${name}.log`), `EXIT=${gateResult[name] ?? 1}\n`)
      row.gates = ['typecheck', 'lint', 'test'].map((name) => receiptExit(path.join(cardDir, `${name}.log`))).join('/')
      const statusClean = String(git('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' })).trim() === ''
      const signatureClean = beforeGates === treeSignature(worktree)
      row.clean = statusClean && signatureClean ? 0 : 1
      writeFile(path.join(cardDir, 'clean-tree.log'), `status_clean=${statusClean}\ntree_unchanged=${signatureClean}\nEXIT=${row.clean}\n`)
      const pilotReport = path.join(cardDir, 'pilot-report.md')
      row.reportCheck = await (dependencies.reportCheck ?? ((file, dir) => runLogged(process.execPath, [path.join(repo, 'plugin/bin/wt-report-findings-check.mjs'), file], repo, path.join(dir, 'report-findings-check.log'))))(pilotReport, cardDir)
      if (!fs.existsSync(path.join(cardDir, 'report-findings-check.log'))) writeFile(path.join(cardDir, 'report-findings-check.log'), `EXIT=${row.reportCheck ?? 1}\n`)
      row.reportCheck = receiptExit(path.join(cardDir, 'report-findings-check.log'))
      const head = String(git('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' })).trim()
      row.head = head
      const diff = String(git('git', ['diff', `${options.base}..${head}`], { cwd: worktree, encoding: 'utf8' }))
      writeFile(path.join(cardDir, 'diff.patch'), diff)
      row.files = String(git('git', ['diff', '--name-only', `${options.base}..${head}`], { cwd: worktree, encoding: 'utf8' })).trim().split('\n').filter(Boolean)
      row.fidelity = await (dependencies.fidelity ?? ((context) => defaultFidelity(repo, context)))({ worktree, cardDir, id, waveId, base: options.base, head })
      if (!fs.existsSync(path.join(cardDir, 'fidelity-verify.log'))) writeFile(path.join(cardDir, 'fidelity-verify.log'), `EXIT=${row.fidelity ?? 1}\n`)
      row.fidelity = receiptExit(path.join(cardDir, 'fidelity-verify.log'))
      return row
    }

    let next = 0
    let timeStopped = false
    const workers = Array.from({ length: Math.min(options.concurrency, candidates.length) }, async () => {
      while (next < candidates.length && !timeStopped) {
        const index = next++
        const result = await prepare(candidates[index])
        if (!result) timeStopped = true
        else if (!options.cards) {
          const refreshed = await scanMission()
          const started = new Set(rows.map((row) => row.id))
          candidates.splice(next, candidates.length - next, ...refreshed.filter((card) => !started.has(String(card.id))).slice(0, options.maxCards - rows.length))
        }
      }
    })
    await Promise.all(workers)
    if (timeStopped) stopReason = 'time budget exhausted'
    else if (moreThanLimit) stopReason = 'max-cards reached'
    else if (!candidates.length) stopReason = 'no eligible card'
    else stopReason = 'card set complete'

    const ordered = [...rows].sort((left, right) => candidates.findIndex((card) => String(card.id) === left.id) - candidates.findIndex((card) => String(card.id) === right.id))
    for (const row of ordered) {
      await (dependencies.judge ?? (async ({ row }) => { row.decision = 'undecided' }))({ card: candidates.find((card) => String(card.id) === row.id), row, worktree: row.worktree, cardDir: row.cardDir })
      const receiptsGreen = row.pilot === 0 && row.gates === '0/0/0' && row.clean === 0 && row.reportCheck === 0 && row.fidelity === 0 && fs.readFileSync(path.join(row.cardDir, 'diff.patch'), 'utf8').trim()
      if ((row.pilot === 1 || row.pilot === 2) && row.decision !== 'escalated') { row.decision = 'escalated'; row.reason = `pilot EXIT=${row.pilot} requires escalate` }
      else if (row.decision === 'accepted' && !receiptsGreen) { row.decision = 'escalated'; row.reason = 'accept refused: required receipt failed' }
      await board.addComment(row.id, `wave ${waveId}: ${row.decision}${row.reason ? ` - ${row.reason}` : ''}`)
    }
    rows.splice(0, rows.length, ...ordered)
    if (dependencies.judgment) judgment = await dependencies.judgment(rows)
  } catch (error) {
    fatal = errorText(error)
    stopReason = fatal.startsWith('board unavailable:') ? 'board unavailable' : fatal
  }
  emit()
  return { exitCode: fatal || rows.length === 0 ? 1 : rows.every((row) => row.decision === 'accepted') ? 0 : rows.every((row) => ['accepted', 'escalated', 'rejected'].includes(row.decision)) ? 2 : 1, waveId, report, waveDir, rows, stopReason }
}

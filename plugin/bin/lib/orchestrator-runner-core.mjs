import { resolveWorkflowToolboxOption } from './plugin-options.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { treeSignature } from './gate-evidence.mjs'
import { createSdkJudge } from './orchestrator-judge.mjs'
import { createWaveServer } from './wave-lifecycle-server.mjs'
import { cardDefinitionOfDone } from './card-definition-of-done.mjs'

const DEFAULTS = { concurrency: 1, base: 'develop', pilotTimeout: 5400, maxCards: Infinity, maxMinutes: Infinity, missionLabels: [], hard: [] }
const ELIGIBLE_LISTS = new Set(['Backlog', 'Next', 'In Progress'])
const cardList = (result) => Array.isArray(result) ? result : Array.isArray(result?.cards) ? result.cards : Array.isArray(result?.items) ? result.items : null
const listName = (card) => card?.listName ?? card?.list?.name ?? card?.list ?? ''
// get_card answers with a listId only (find_cards carries listName): resolve through the board's
// list map when the name is missing (found on real wave b51a1bf6: every explicit card read as 'in list ').
async function resolveListName(board, card) {
  const named = listName(card)
  if (named) return named
  if (card?.listId && typeof board.listNameOf === 'function') return (await board.listNameOf(String(card.listId))) ?? ''
  return ''
}
const labels = (card) => (card?.labels ?? []).map((item) => typeof item === 'string' ? item : item.name)
const canonicalPath = (file) => (fs.realpathSync.native ?? fs.realpathSync)(file)
const under = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
const CARD_ID = /^\d{1,32}$/
const VALUE_FLAGS = new Set(['--cards', '--mission-list', '--mission-label', '--max-cards', '--max-minutes', '--concurrency', '--hard', '--base', '--worktrees-dir', '--report', '--profile-env', '--board-contract', '--knowledge-base-index', '--plugin-dir', '--pilot-timeout', '--board-url', '--board-id'])
const errorText = (error) => error instanceof Error ? error.message : String(error)
const cardText = (card) => card.markdown ?? card.text ?? card.description ?? JSON.stringify(card, null, 2)
const receiptExit = (file, fallback = 1) => {
  try { return Number(/(?:^|\n)EXIT=(\d+)\s*$/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? fallback) } catch { return fallback }
}

export function parseOrchestratorArgs(argv) {
  const options = { ...DEFAULTS, boardUrl: resolveWorkflowToolboxOption('planka_mcp_url').value, cards: null, missionList: null, missionLabels: [], hard: [], worktreesDir: null, report: null, profileEnv: null, boardContract: null, knowledgeBaseIndex: null, pluginDirs: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (VALUE_FLAGS.has(arg) && (!argv[i + 1] || argv[i + 1].startsWith('--'))) return { error: `${arg} requires a value` }
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
    else if (arg === '--board-contract') options.boardContract = next()
    else if (arg === '--knowledge-base-index') options.knowledgeBaseIndex = next()
    else if (arg === '--plugin-dir') {
      const pluginDir = next() ?? ''
      if (!path.isAbsolute(pluginDir)) return { error: `--plugin-dir must be an absolute path: ${pluginDir}` }
      options.pluginDirs.push(path.resolve(pluginDir))
    }
    else if (arg === '--pilot-timeout') options.pilotTimeout = Number(next())
    else if (arg === '--board-url') options.boardUrl = next()
    else if (arg === '--board-id') options.boardId = next()
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!!options.cards === !!options.missionList) return { error: 'provide exactly one of --cards or --mission-list' }
  if (options.cards?.some((id) => !CARD_ID.test(id))) return { error: 'invalid card id' }
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
    for (const card of cards) validateBoardCard(card)
    found.push(...cards)
    offset += cards.length
    const total = Number(page?.total ?? found.length)
    if (!Number.isFinite(total)) throw new Error('board unavailable: malformed find_cards total')
    if (cards.length === 0 || offset >= total) return found
  }
}

function validateBoardCard(card) {
  const id = String(card?.id ?? '')
  if (!CARD_ID.test(id)) throw new Error(`board unavailable: malformed card id ${id || '<missing>'}`)
  return card
}

function realLocation(file) {
  let probe = path.resolve(file)
  const suffix = []
  while (!fs.existsSync(probe)) { suffix.unshift(path.basename(probe)); probe = path.dirname(probe) }
  return path.resolve(canonicalPath(probe), ...suffix)
}

function assertUnder(root, target, label) {
  if (!under(canonicalPath(root), realLocation(target))) throw new Error(`${label} is outside its root directory`)
  return target
}

function firstSymlink(root) {
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) return target
      if (entry.isDirectory()) pending.push(target)
    }
  }
  return null
}

// Returns null when the card is eligible, otherwise the reason it is skipped — every skip is
// named in the report (Sol round 2: a malformed Depends-on line used to make a card vanish silently).
async function ineligibleReason(card, requiredLabels, board, known) {
  const all = labels(card)
  if (!['P0', 'P1', 'P2'].some((label) => all.includes(label))) return 'no priority label'
  if (!['feature', 'chore', 'bug', 'research'].some((label) => all.includes(label))) return 'no type label'
  if (!['effort:S', 'effort:M', 'effort:L'].some((label) => all.includes(label))) return 'no effort label'
  if (!requiredLabels.every((label) => all.includes(label))) return `missing mission label ${requiredLabels.find((label) => !all.includes(label))}`
  const lines = String(card.description ?? card.text ?? '').split(/\r?\n/).filter((line) => /^\s*Depends-on:/i.test(line))
  for (const line of lines) {
    const value = line.replace(/^\s*Depends-on:\s*/i, '').trim()
    if (/^none$/i.test(value)) continue
    const match = /^#?(\d+)$/.exec(value)
    if (!match) return `malformed Depends-on line "${value}"`
    if (!CARD_ID.test(match[1])) throw new Error(`board unavailable: malformed card id ${match[1]}`)
    let dependency = known.get(match[1])
    if (!dependency) { dependency = validateBoardCard(await board.getCard(match[1])); known.set(match[1], dependency) }
    const dependencyList = await resolveListName(board, dependency)
    if (dependencyList !== 'Done') return `dependency ${match[1]} is ${dependencyList || 'unknown'}, not Done`
  }
  return null
}

function runLogged(program, args, cwd, log) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' })
  fs.writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}${/\n$/.test(`${result.stdout ?? ''}${result.stderr ?? ''}`) ? '' : '\n'}EXIT=${result.status ?? 1}\n`)
  return result.status ?? 1
}

// A fresh worktree carries no node_modules: the pilot's gates and lanes need the toolkit installed
// (offline, frozen lockfile). A failed install is a receipt, and the card is escalated without a pilot.
function defaultInstall(worktree, cardDir) {
  return runLogged('pnpm', ['install', '--offline', '--frozen-lockfile'], path.join(worktree, 'toolkit'), path.join(cardDir, 'install.log'))
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

function renderReport({ waveId, options, rows, stopReason, fatal, judgment, boardMutations, skipped = [] }) {
  const verification = rows.map((row) => `| ${row.id} | ${row.route ?? '-'} | ${row.pilot ?? '-'} | ${row.gates ?? '-'} | ${row.clean ?? '-'} | ${row.reportCheck ?? '-'} | ${row.fidelity ?? '-'} | ${row.files?.join(', ') || '-'} | ${row.decision ?? 'undecided'} | ${row.reason ?? '-'} | ${row.receiptDir ?? '-'} |`).join('\n') || '| - | - | - | - | - | - | - | - | - | - | - |'
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
    if (row.decision === 'undecided' && boardMutations.some((mutation) => mutation.type === 'moveCard' && mutation.id === row.id && mutation.listName === 'In Progress')) {
      escalations.push(`card ${row.id}: moved to In Progress by wave ${waveId}, awaiting reconciliation (${row.reason ?? fatal ?? stopReason})`)
    }
  }
  const modelSections = judgment?.trim() || '## Independent Review\nsession ended before judgment\n\n## Decisions\nsession ended before judgment'
  const bases = rows.map((row) => `card=${row.id}; base=${row.base ?? '<missing>'}; baseRef=${options.base}`).join('\n') || `baseRef=${options.base}; no card base SHA recorded`
  const routed = rows.flatMap((row) => (row.routedCards ?? []).map((card) => `- origin card ${row.id}: card ${card.id} — ${card.title} — ${card.l4Reason}${card.contested ? ' — contested' : ''}${card.missionAssessment ? ` — mission re-scan: ${card.missionAssessment}` : ''}`)).join('\n') || 'None.'
  return `## Implemented\nwave=${waveId}; baseRef=${options.base}; cards=${rows.map((row) => row.id).join(',') || 'none'}; stop=${stopReason}; skipped=${skipped.length ? skipped.map((entry) => `${entry.id} (${entry.reason})`).join('; ') : 'none'}\n${bases}\n\n## Verification\n| Card | Route | Pilot exit | Gates | Clean | Findings | Fidelity | Files touched | Decision | Reason | Receipts |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${verification}\n\n${modelSections}\n\n## Routed cards\n${routed}\n\n## Remaining Risks\n${risks.join('\n') || 'None.'}\n\n## Escalations for main\n${escalations.join('\n') || 'None.'}\n\n## Findings\nNone.\n`
}

export function reviewBase(row) {
  if (typeof row.base !== 'string' || !/^[a-f0-9]{40}$/.test(row.base)) throw new Error(`orchestrator review refused: card ${row.id} missing field base`)
  return row.base
}

export async function runOrchestrator(input, dependencies = {}) {
  const options = { ...DEFAULTS, boardUrl: resolveWorkflowToolboxOption('planka_mcp_url').value, ...input }
  const git = dependencies.git ?? ((program, args, opts) => execFileSync(program, args, opts))
  const now = dependencies.now ?? (() => Date.now())
  const writeFile = dependencies.writeFile ?? fs.writeFileSync
  const board = dependencies.board
  const runPilot = dependencies.runPilot
  const waveId = options.waveId ?? randomUUID().slice(0, 8)
  const report = path.resolve(options.report)
  const waveDir = path.resolve(options.worktreesDir, `wave-${waveId}`)
  const rows = []
  const boardMutations = []
  const skipped = []
  const startedAt = options.startedAt ?? now()
  let stopReason = 'no eligible card'
  let fatal = null
  let judgment = ''
  let repo = ''

  const emit = () => {
    fs.mkdirSync(path.dirname(report), { recursive: true })
    for (const row of rows) {
      const destination = path.join(path.dirname(report), 'cards', row.id)
      row.receiptDir = destination
      if (fs.existsSync(row.cardDir) && path.resolve(row.cardDir) !== path.resolve(destination)) fs.cpSync(row.cardDir, destination, { recursive: true, force: true })
    }
    // A card skipped at an earlier scan and run after a re-scan is not skipped (Sol round 3, non-blocking).
    const stillSkipped = skipped.filter((entry) => !rows.some((row) => row.id === entry.id))
    writeFile(report, renderReport({ waveId, options, rows, stopReason, fatal, judgment, boardMutations, skipped: stillSkipped }))
  }

  try {
    repo = canonicalPath(String(git('git', ['rev-parse', '--show-toplevel'], { cwd: options.cwd ?? process.cwd(), encoding: 'utf8' })).trim())
    if (options.base === 'main') throw new Error('base main is refused')
    if ((options.pluginDirs ?? []).some((pluginDir) => !path.isAbsolute(pluginDir))) throw new Error('--plugin-dir must be an absolute path')
    if (options.cards?.some((id) => !CARD_ID.test(String(id)))) throw new Error('invalid card id')
    if (!under(repo, realLocation(options.worktreesDir))) throw new Error('worktrees dir is outside repository root')
    if (options.maxMinutes * 60 < options.pilotTimeout) throw new Error('time budget below one pilot timeout')
    if (!board) throw new Error('board unavailable: no board client')
    if (!runPilot) throw new Error('driver error: no pilot runner')
    fs.mkdirSync(waveDir, { recursive: true })
    if (!under(repo, canonicalPath(waveDir))) throw new Error('worktrees dir is outside repository root')
    const hooks = path.join(waveDir, 'hooks')
    fs.mkdirSync(hooks, { recursive: true })
    for (const [name, action] of [['pre-push', 'push'], ['pre-merge-commit', 'merge']]) {
      const hook = path.join(hooks, name)
      writeFile(hook, `#!/bin/sh\nprintf '%s\\n' "refused by wave ${waveId}: ${action} is main's" >&2\nexit 1\n`)
      fs.chmodSync(hook, 0o755)
    }
    const transactionHook = path.join(hooks, 'reference-transaction')
    writeFile(transactionHook, `#!/bin/sh\nif [ "$1" = prepared ]; then\n  case "\${GIT_REFLOG_ACTION:-}" in\n    merge\\ *) printf '%s\\n' "refused by wave ${waveId}: merge is main's" >&2; exit 1;;\n  esac\nfi\nexit 0\n`)
    fs.chmodSync(transactionHook, 0o755)
    git('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: repo })

    const scanMission = async () => {
      const all = await paginate(board, options.missionList)
      const known = new Map(all.map((card) => [String(card.id), card]))
      const eligible = []
      for (const card of all) {
        const reason = await ineligibleReason(card, options.missionLabels, board, known)
        if (reason) { if (!skipped.some((entry) => entry.id === String(card.id))) skipped.push({ id: String(card.id), reason }) }
        else eligible.push(card)
      }
      return eligible
    }
    let candidates
    if (options.cards) {
      candidates = []
      for (const id of [...new Set(options.cards.map(String))]) {
        const response = await board.getCard(id)
        if (!response) throw new Error(`card absent from board: ${id}`)
        const card = validateBoardCard(response)
        const cardList = await resolveListName(board, card)
        if (ELIGIBLE_LISTS.has(cardList)) candidates.push(card)
        else skipped.push({ id, reason: `in list ${cardList || 'unknown'}, not Backlog/Next/In Progress` })
      }
    } else {
      candidates = await scanMission()
    }
    const moreThanLimit = candidates.length > options.maxCards
    candidates = candidates.slice(0, options.maxCards)
    for (const card of candidates) {
      if (cardDefinitionOfDone(cardText(card)).length === 0) throw new Error(`orchestrator preflight failed: ask the owner to add a Definition of done to card ${card.id}`)
    }
    for (const card of candidates) {
      const id = String(card.id)
      const branch = `card/${id}-wave-${waveId}`
      const worktree = path.join(path.resolve(options.worktreesDir), `card-${id}-wave-${waveId}`) // a sibling of the wave dir: pnpm's node_modules symlinks must not sit under the judge's confinement root (real wave d0da4408)
      assertUnder(path.resolve(options.worktreesDir), worktree, 'worktree')
      if (branchExists(git, repo, branch)) throw new Error(`branch already exists: ${branch}`)
      if (fs.existsSync(worktree)) throw new Error(`worktree already exists: ${worktree}`)
    }

    const prepare = async (card) => {
      const id = String(card.id)
      if ((now() - startedAt) / 1000 + options.pilotTimeout > options.maxMinutes * 60) return null
      const branch = `card/${id}-wave-${waveId}`
      const worktree = path.join(path.resolve(options.worktreesDir), `card-${id}-wave-${waveId}`) // a sibling of the wave dir: pnpm's node_modules symlinks must not sit under the judge's confinement root (real wave d0da4408)
      const cardDir = path.join(waveDir, 'cards', id)
      const snapshot = path.join(cardDir, 'card.md')
      assertUnder(path.resolve(options.worktreesDir), worktree, 'worktree')
      for (const [target, label] of [[cardDir, 'cardDir'], [snapshot, 'snapshot']]) assertUnder(waveDir, target, label)
      const row = { id, branch, worktree, cardDir, decision: 'undecided' }
      rows.push(row)
      fs.mkdirSync(cardDir, { recursive: true })
      writeFile(snapshot, cardText(card))
      await board.moveCard(id, 'In Progress')
      boardMutations.push({ type: 'moveCard', id, listName: 'In Progress' })
      const base = String(git('git', ['rev-parse', '--verify', `${options.base}^{commit}`], { cwd: repo, encoding: 'utf8' })).trim()
      if (!/^[a-f0-9]{40}$/.test(base)) throw new Error(`base ${options.base} did not resolve to a full commit SHA`)
      row.base = base
      git('git', ['worktree', 'add', '-b', branch, worktree, base], { cwd: repo })
      git('git', ['config', '--worktree', 'core.hooksPath', hooks], { cwd: worktree })
      git('git', ['config', '--worktree', 'merge.ff', 'false'], { cwd: worktree })
      const refusedPush = path.join(waveDir, 'refused-push')
      if (!fs.existsSync(refusedPush)) writeFile(refusedPush, 'not a git repository\n')
      const remotes = String(git('git', ['remote'], { cwd: repo, encoding: 'utf8' })).trim().split('\n').filter(Boolean)
      for (const remote of remotes) git('git', ['config', '--worktree', `remote.${remote}.pushurl`, refusedPush], { cwd: worktree })
      const runnerLog = path.join(cardDir, 'runner.log')
      const pilotDependencies = { ...(dependencies.pilotDependencies ?? {}), log: (line) => fs.appendFileSync(runnerLog, `${line}\n`) }
      row.install = await (dependencies.install ?? defaultInstall)(worktree, cardDir)
      if (!fs.existsSync(path.join(cardDir, 'install.log'))) writeFile(path.join(cardDir, 'install.log'), `EXIT=${row.install ?? 1}\n`)
      if (row.install !== 0) { row.pilot = 1; row.reason = `dependency install failed (EXIT=${row.install})`; writeFile(path.join(cardDir, 'pilot.log'), 'EXIT=1\n'); return row }
      const pilot = await runPilot({ card: id, cardFile: snapshot, dir: worktree, hard: options.hard.includes(id), profileEnv: options.profileEnv, boardContract: options.boardContract, knowledgeBaseIndex: options.knowledgeBaseIndex, knowledgeBaseProjectRoot: repo, pluginDirs: options.pluginDirs, timeout: options.pilotTimeout, boardMoves: false }, { ...pilotDependencies, board })
      row.pilot = pilot.exitCode
      row.partial = pilot.summary?.partial ?? null
      row.deferred = pilot.summary?.deferred ?? null
      row.route = /^route=(LITE|FULL)\b/.exec(fs.existsSync(runnerLog) ? fs.readFileSync(runnerLog, 'utf8') : '')?.[1] ?? pilot.summary?.route ?? '-'
      writeFile(path.join(cardDir, 'pilot.log'), `EXIT=${pilot.exitCode}\n`)
      for (const name of ['summary.json', 'usage.json', 'cost.json', 'sdk-transcript.json', 'pilot-report.md', 'lifecycle.json']) {
        const source = path.join(worktree, '.lane', name)
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(cardDir, name))
      }
      try { row.routedCards = JSON.parse(fs.readFileSync(path.join(worktree, '.lane', 'lifecycle.json'), 'utf8')).routed_cards ?? [] } catch { row.routedCards = [] }
      for (const routed of row.routedCards) {
        if (!options.missionList) continue
        try {
          const routedCard = validateBoardCard(await board.getCard(String(routed.id)))
          routed.missionAssessment = await ineligibleReason(routedCard, options.missionLabels, board, new Map([[String(routed.id), routedCard]])) ?? 'eligible for mission'
        } catch (error) { routed.missionAssessment = `board unavailable: ${errorText(error)}` }
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
      const reviewBaseSha = reviewBase(row)
      const diff = String(git('git', ['diff', `${reviewBaseSha}..${head}`], { cwd: worktree, encoding: 'utf8' }))
      writeFile(path.join(cardDir, 'diff.patch'), diff)
      row.files = String(git('git', ['diff', '--name-only', `${reviewBaseSha}..${head}`], { cwd: worktree, encoding: 'utf8' })).trim().split('\n').filter(Boolean)
      row.fidelity = await (dependencies.fidelity ?? ((context) => defaultFidelity(repo, context)))({ worktree, cardDir, id, waveId, base: reviewBaseSha, head })
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
    // allSettled, never fail-fast: a rejected worker must not let the report be emitted while another
    // worker can still move a card or comment (Sol round 2) — every mutation is recorded first.
    const settled = await Promise.allSettled(workers)
    const failed = settled.find((entry) => entry.status === 'rejected')
    if (failed) throw failed.reason
    if (timeStopped) stopReason = 'time budget exhausted'
    else if (moreThanLimit) stopReason = 'max-cards reached'
    else if (!candidates.length) stopReason = 'no eligible card'
    else stopReason = 'card set complete'

    const ordered = [...rows].sort((left, right) => candidates.findIndex((card) => String(card.id) === left.id) - candidates.findIndex((card) => String(card.id) === right.id))
    let judge = dependencies.judge
    let waveServer = null
    if (!judge && dependencies.query && ordered.length) {
      const symlink = firstSymlink(waveDir)
      if (symlink) throw new Error(`judge refused: symlink under wave directory: ${path.relative(waveDir, symlink)}`)
      waveServer = (dependencies.createWaveServer ?? createWaveServer)({ waveDir, cards: ordered, sdk: dependencies.sdk, sdkRequire: dependencies.sdkRequire })
      for (const row of ordered) { waveServer.setCardState(row.id, 'piloting'); waveServer.setCardState(row.id, 'judging') }
      judge = createSdkJudge({ query: dependencies.query, models: dependencies.models, waveDir, waveServer, contract: dependencies.contract, env: dependencies.env, knowledgeBaseIndex: options.knowledgeBaseIndex, projectRoot: repo, pluginDirs: options.pluginDirs, loadedCodePaths: dependencies.loadedCodePaths })
    }
    for (const row of ordered) {
      // No receipts to judge when the dependency install failed: the card is escalated as is.
      if (row.install !== undefined && row.install !== 0) { row.decision = 'escalated'; waveServer?.setCardState(row.id, 'escalated'); const comment = `escalated by wave ${waveId} — ${row.reason}`; await board.addComment(row.id, comment); boardMutations.push({ type: 'addComment', id: row.id, text: comment }); continue }
      await (judge ?? (async ({ row }) => { row.decision = 'undecided' }))({ card: candidates.find((card) => String(card.id) === row.id), row, worktree: row.worktree, cardDir: row.cardDir })
      const decisionPath = path.join(row.cardDir, 'decision.json')
      if (fs.existsSync(decisionPath)) {
        const decided = JSON.parse(fs.readFileSync(decisionPath, 'utf8'))
        row.decision = decided.decision === 'accept' ? 'accepted' : decided.decision === 'escalate' ? 'escalated' : decided.decision === 'reject' ? 'rejected' : 'undecided'
        row.reason = decided.reason
      } else if (waveServer?.state().cards[row.id] === 'undecided') {
        row.decision = 'undecided'
        row.reason = 'orchestrator session ended after 3 turns without progress'
      }
      const receiptsGreen = row.pilot === 0 && row.gates === '0/0/0' && row.clean === 0 && row.reportCheck === 0 && row.fidelity === 0 && fs.readFileSync(path.join(row.cardDir, 'diff.patch'), 'utf8').trim()
      if (row.pilot === 2) {
        const delivery = row.deferred ?? row.partial
        const findings = Array.isArray(delivery?.findings) ? delivery.findings.filter((finding) => typeof finding === 'string' && finding) : []
        const detail = delivery?.reason ?? 'partial delivery'
        row.decision = row.deferred ? 'deferred' : 'partial'
        row.reason = `pilot EXIT=2: ${detail}${findings.length ? `; ${row.deferred ? 'routed' : delivery?.phase === 'report' ? 'unmet' : 'findings'}: ${findings.join('; ')}` : ''}`
      }
      else if (row.pilot === 1 && row.decision !== 'escalated') { row.decision = 'escalated'; row.reason = row.reason ?? 'pilot EXIT=1 requires escalate' }
      else if (row.decision === 'accepted' && !receiptsGreen) { row.decision = 'escalated'; row.reason = 'accept refused: required receipt failed' }
      const comment = row.decision === 'accepted'
        ? `accepted by wave ${waveId} — awaiting main integration (branch ${row.branch}, head ${row.head})`
        : `${row.decision} by wave ${waveId}${row.reason ? ` — ${row.reason}` : ''}`
      await board.addComment(row.id, comment)
      boardMutations.push({ type: 'addComment', id: row.id, text: comment })
    }
    rows.splice(0, rows.length, ...ordered)
    if (dependencies.judgment) judgment = await dependencies.judgment(rows)
    else if (judge?.judgment) judgment = await judge.judgment(rows)
  } catch (error) {
    fatal = errorText(error)
    stopReason = fatal.startsWith('board unavailable:') ? 'board unavailable' : fatal
  }
  emit()
  return { exitCode: fatal || rows.length === 0 ? 1 : rows.every((row) => row.decision === 'accepted') ? 0 : rows.every((row) => ['accepted', 'partial', 'escalated', 'rejected'].includes(row.decision)) ? 2 : 1, waveId, report, waveDir, rows, stopReason, boardMutations, skipped: skipped.filter((entry) => !rows.some((row) => row.id === entry.id)) }
}

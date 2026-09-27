import { commandIO } from './host/command-io.mjs'
import { isAbsolute } from 'node:path'

const LIST = '.github/cross-os-host-layer.json'
const RESULTS = { 0: 'green', 1: 'red', 2: 'error', 3: 'mismatch', 4: 'timeout', 5: 'pending' }
const failure = (message, code = 2) => Object.assign(new Error(message), { code })
const lines = (text) => text.trim().split('\n').filter(Boolean)

export function matchesHostPath(file, glob) {
  const escaped = glob.split('**').map((part) => part.split('*').map((literal) => literal.replace(new RegExp('[.*+?^${}()|[\\]\\\\]', 'g'), (match) => String.fromCharCode(92) + match)).join('[^/]*')).join('.*')
  return new RegExp(`^${escaped}$`).test(file)
}

function extractFailedTests(log) {
  const failures = new Set()
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  for (const raw of log.split('\n')) {
    const stripped = raw.replace(ansi, '')
    const clean = stripped.slice(stripped.lastIndexOf('\t') + 1).trim()
    const marker = clean.indexOf('FAIL ')
    if (marker < 0) continue
    const body = clean.slice(marker + 5).trim()
    const file = body.match(/[\w./-]+\.test\.[cm]?[jt]sx?/)
    if (!file || !body.includes(' > ')) continue
    failures.add(body.slice(body.indexOf(file[0])).split(' > ').map((part) => part.trim()).join(' > '))
  }
  return [...failures]
}

function options(argv) {
  const command = argv[0]
  if (!['decide', 'run', 'collect', 'release-check'].includes(command)) throw failure('usage: decide|run|collect|release-check [options]')
  const out = { command, remote: 'public', workflow: 'cross-os.yml', timeoutMin: 75 }
  const names = { '--merge': 'merge', '--repo': 'repo', '--paths-file': 'pathsFile', '--remote': 'remote', '--workflow': 'workflow', '--repo-slug': 'slug', '--timeout-min': 'timeoutMin', '--evidence-dir': 'evidenceDir', '--ref': 'ref', '--base': 'base' }
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--dry-run') { out.dryRun = true; continue }
    if (!names[flag] || !argv[index + 1]) throw failure(`unknown or missing option: ${flag}`)
    out[names[flag]] = argv[++index]
  }
  if (['decide', 'run', 'collect'].includes(command) && !out.merge) throw failure('--merge is required')
  if (!Number.isFinite(Number(out.timeoutMin)) || Number(out.timeoutMin) <= 0) throw failure('--timeout-min must be positive')
  return out
}

function checked(io, cwd, program, args) {
  const result = io.run(program, args, { cwd })
  if (result.status !== 0) throw failure(`${program} ${args.join(' ')}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}
const git = (ctx, ...args) => checked(ctx.io, ctx.cwd, 'git', args)
const gh = (ctx, ...args) => JSON.parse(checked(ctx.io, ctx.cwd, 'gh', args))
const shaOf = (ctx, ref) => git(ctx, 'rev-parse', '--verify', `${ref}^{commit}`)
const recordPath = (ctx, sha) => ctx.io.join(ctx.store, `${sha}.json`)
function save(ctx, record) {
  const text = `${JSON.stringify(record, null, 2)}\n`
  ctx.io.mkdirp(ctx.store)
  ctx.io.writeText(recordPath(ctx, record.sha), text)
  if (ctx.args.evidenceDir) {
    ctx.io.mkdirp(ctx.args.evidenceDir)
    ctx.io.writeText(ctx.io.join(ctx.args.evidenceDir, `${record.sha}.json`), text)
  }
}
function readRecord(ctx, sha) {
  const file = recordPath(ctx, sha)
  return ctx.io.exists(file) ? JSON.parse(ctx.io.readText(file)) : null
}

function decide(ctx, sha, announce = true, listSource) {
  const parents = lines(git(ctx, 'rev-list', '--parents', '-n', '1', sha)).at(0).split(' ')
  if (parents.length < 2) throw failure(`commit ${sha} has no parent`)
  const changed = git(ctx, 'diff', '--name-only', '--no-renames', '-z', parents[1], sha).split('\0').filter(Boolean)
  const source = listSource?.source ?? ctx.args.pathsFile ?? `${sha}:${LIST}`
  let data
  if (listSource) {
    data = listSource.data
  } else if (ctx.args.pathsFile) {
    if (!ctx.io.exists(source)) throw failure(`missing paths list ${source}; default is ${sha}:${LIST}`)
    data = ctx.io.readText(source)
  } else {
    const shown = ctx.io.run('git', ['show', source], { cwd: ctx.cwd })
    if (shown.status !== 0) throw failure(`missing ${source}; override with --paths-file <file>`)
    data = shown.stdout
  }
  const parsed = JSON.parse(data)
  if (parsed.version !== 1 || !Array.isArray(parsed.entries) || !parsed.entries.length || parsed.entries.some((e) => !e.glob || !e.why)) throw failure(`invalid paths list ${source}`)
  const matches = changed.flatMap((file) => parsed.entries.filter((entry) => matchesHostPath(file, entry.glob)).map((entry) => ({ file, glob: entry.glob })))
  const decision = matches.length ? 'run' : 'skip'
  if (announce) {
    ctx.print(`DECISION: ${decision} merge=${sha} parent=${parents[1]} changed=${changed.length} matched=${matches.length} list=${source}`)
    if (matches.length) for (const match of matches) ctx.print(`MATCH ${match.file} <- ${match.glob}`)
    else {
      ctx.print(`REASON: none of ${changed.length} changed files matches any of ${parsed.entries.length} host-layer globs`)
      for (const file of changed.slice(0, 20)) ctx.print(`CHANGED ${file}`)
    }
  }
  return { decision, sha, parent: parents[1], changed, matches, source }
}

function slugFor(ctx) {
  if (ctx.args.slug) return ctx.args.slug
  const url = git(ctx, 'remote', 'get-url', ctx.args.remote)
  const match = url.match(new RegExp('^(?:https://github\\.com/|git@github\\.com:)([^/]+/[^/]+?)(?:\\.git)?$'))
  if (!match) throw failure(`cannot parse GitHub repo slug from ${url}; pass --repo-slug`)
  return match[1]
}

function hookGuard(ctx) {
  const config = ctx.io.run('git', ['config', '--get', 'core.hooksPath'], { cwd: ctx.cwd })
  if (config.status === 0 && config.stdout.trim()) throw failure(`core.hooksPath is set: ${config.stdout.trim()}; refusing push`)
  const hook = git(ctx, 'rev-parse', '--git-path', 'hooks/pre-push')
  const resolved = isAbsolute(hook) ? hook : ctx.io.join(ctx.cwd, hook)
  if (!ctx.io.exists(resolved) || !ctx.io.executable(resolved) || !ctx.io.readText(resolved).includes('wt-push-scope-check')) {
    throw failure(`pre-push scope guard missing or not executable at ${resolved}`)
  }
}

function authorizedPush(ctx, args, content, verifyReceipt) {
  const auth = ctx.io.join(ctx.gitDir, 'wt-push-authorized.json')
  let owned = false
  try {
    ctx.io.writeText(auth, content, true)
    owned = true
  } catch (error) {
    if (error.code !== 'EEXIST') {
      if (ctx.io.exists(auth)) ctx.io.removeFile(auth)
      throw error
    }
    const stale = ctx.io.readText(auth)
    const commits = JSON.parse(stale).commits ?? []
    const already = commits.filter((sha) => ctx.io.run('git', ['merge-base', '--is-ancestor', sha, `${ctx.args.remote}/main`], { cwd: ctx.cwd }).status === 0).length
    throw failure(`authorization exists: ${auth} mtime=${ctx.io.mtime(auth)} commits=${commits.join(',')} already-on-${ctx.args.remote}/main=${already}; remove with: rm '${auth}'`)
  }
  const cleanup = () => { if (owned && ctx.io.exists(auth) && ctx.io.readText(auth) === content) ctx.io.removeFile(auth) }
  const unregister = ctx.io.onSignal?.(() => { cleanup(); process.exit(2) })
  try {
    const result = (ctx.io.push ?? ((argv, cwd) => ctx.io.run('git', argv, { cwd })))(args, ctx.cwd)
    if (result.status !== 0) throw failure(`git ${args.join(' ')} failed: ${result.stderr}`)
    if (verifyReceipt && !/wt-push-scope-check: .*— OK/.test(result.stdout + result.stderr)) throw failure('push succeeded but the wt-push-scope-check guard did not run')
  } finally { unregister?.(); cleanup() }
}

function removeBranch(ctx, record) {
  if (!new RegExp('^card/ci-[0-9a-f]{12}$').test(record.branch)) throw failure(`refusing branch deletion: ${record.branch}`)
  hookGuard(ctx)
  authorizedPush(ctx, ['push', ctx.args.remote, '--delete', record.branch], JSON.stringify({ maxCount: 0 }), false)
  record.branchDeleted = true
  save(ctx, record)
}

function runList(ctx, branch) {
  return gh(ctx, 'run', 'list', '-R', ctx.slug, '--workflow', ctx.args.workflow, '--branch', branch, '--json', 'databaseId,url,event,headBranch,headSha,status,conclusion')
}

function matrixFailure(run) {
  if (run.conclusion !== 'success') return `conclusion ${run.conclusion}`
  if (!run.jobs?.length) return 'no jobs'
  const failed = run.jobs.find((job) => job.conclusion !== 'success')
  if (failed) return `job ${failed.name}: ${failed.conclusion}`
  for (const os of ['ubuntu', 'windows', 'macos']) {
    if (!run.jobs.some((job) => job.name.toLowerCase().includes(os))) return `missing ${os}`
  }
  return null
}

export const ciBranchFor = (sha) => `card/ci-${sha.slice(0, 12)}`
const EVIDENCE_FIELDS = 'event,headBranch,headSha,status,conclusion,jobs'

// The ONLY producer of a green verdict. Green needs positive evidence about exactly this commit: a dispatched run on
// its own card/ci branch at its sha, completed, with a successful ubuntu, windows and macos job. Absent, foreign or
// partial evidence is unchecked, pending or red, never green. Callers pass evidence read live from GitHub
// (freshEvidence); a stored record is never evidence.
export function verdictFromEvidence(run, sha) {
  if (!run || typeof run !== 'object') return { verdict: 'unchecked', reason: 'no run evidence' }
  if (run.event !== 'workflow_dispatch' || run.headBranch !== ciBranchFor(sha) || run.headSha !== sha) {
    return { verdict: 'unchecked', reason: `evidence is not about ${sha}: event=${run.event} headBranch=${run.headBranch} headSha=${run.headSha}` }
  }
  if (run.status !== 'completed' || !run.conclusion) return { verdict: 'pending', reason: `status ${run.status}` }
  const incomplete = matrixFailure(run)
  return incomplete ? { verdict: 'red', reason: incomplete } : { verdict: 'green', reason: 'ubuntu, windows and macos jobs succeeded' }
}

function freshEvidence(ctx, runId) {
  return gh(ctx, 'run', 'view', String(runId), '-R', ctx.slug, '--json', EVIDENCE_FIELDS)
}

async function discoverRun(ctx, record) {
  const prior = new Set(runList(ctx, record.branch).map((run) => run.databaseId))
  checked(ctx.io, ctx.cwd, 'gh', ['workflow', 'run', ctx.args.workflow, '-R', ctx.slug, '--ref', record.branch])
  let fresh = []
  for (let attempt = 0; attempt < 90; attempt++) {
    fresh = runList(ctx, record.branch).filter((run) => !prior.has(run.databaseId) && run.event === 'workflow_dispatch')
    if (fresh.length) break
    await ctx.io.sleep(2000)
  }
  if (fresh.length !== 1) throw failure(`expected exactly one new workflow_dispatch run, found ${fresh.length}`, 3)
  const run = fresh[0]
  ctx.print(`RUN id=${run.databaseId} url=${run.url} event=${run.event} headBranch=${run.headBranch} headSha=${run.headSha}`)
  if (run.headBranch !== record.branch || run.headSha !== record.sha) throw failure(`run evidence mismatch: headBranch=${run.headBranch} expected=${record.branch}; headSha=${run.headSha} expected=${record.sha}`, 3)
  Object.assign(record, { runId: run.databaseId, workflow: ctx.args.workflow, url: run.url, event: run.event, headBranch: run.headBranch, headSha: run.headSha, status: run.status })
  save(ctx, record)
}

async function collect(ctx, record) {
  if (!record.runId) throw failure(`no run id recorded for ${record.sha}`)
  const deadline = ctx.io.now() + Number(ctx.args.timeoutMin) * 60000
  let run
  for (;;) {
    run = freshEvidence(ctx, record.runId)
    if (run.status === 'completed') break
    if (ctx.io.now() >= deadline) {
      record.status = 'timed_out'; save(ctx, record)
      ctx.print(`TIMEOUT: branch kept; collect with node plugin/bin/wt-crossos-dispatch.mjs collect --merge ${record.sha}`)
      return 4
    }
    await ctx.io.sleep(30000)
  }
  let originalError
  let result
  try {
    record.status = run.status; record.conclusion = run.conclusion
    save(ctx, record)
    const { verdict, reason } = verdictFromEvidence(run, record.sha)
    if (verdict === 'unchecked') throw failure(`run ${record.runId} ${reason}`, 3)
    const incomplete = verdict === 'green' ? null : reason
    const failingJobs = (run.jobs ?? []).filter((job) => job.conclusion !== 'success')
    for (const job of run.jobs ?? []) ctx.print(`JOB ${job.name}: ${job.conclusion}`)
    if (incomplete) ctx.print(`MATRIX INCOMPLETE: ${incomplete}`)
    if (incomplete) {
      const tests = []
      for (const job of failingJobs) {
        const url = `${record.url}/job/${job.databaseId}`
        ctx.print(`FAILED JOB ${job.name}: ${url}`)
        let log = ''
        try { log = checked(ctx.io, ctx.cwd, 'gh', ['run', 'view', '-R', ctx.slug, '--job', String(job.databaseId), '--log']) }
        catch (error) { ctx.print(`JOB LOG UNAVAILABLE ${job.name}: ${error.message}`) }
        const found = extractFailedTests(log)
        if (!found.length) ctx.print(`FAILED TEST (none extracted — read ${url})`)
        for (const test of found) { ctx.print(`FAILED TEST ${test}`); tests.push(test) }
      }
      const blocker = `BLOCKER: host-layer merge ${record.sha} is red on cross-os run ${record.runId}; open a card and fix before release`
      ctx.print(blocker)
      const jobLines = failingJobs.map((job) => '- ' + job.name).join('\n')
      const testLines = tests.map((test) => '- ' + test).join('\n')
      const draft = `# Cross-OS failure on ${record.sha}\n\nRun: ${record.url}\n\n${jobLines}\n${testLines}\n`
      ctx.io.writeText(ctx.io.join(ctx.store, `${record.sha}.card.md`), draft)
    }
    save(ctx, record)
    result = incomplete ? 1 : 0
  } catch (error) {
    originalError = error
  } finally {
    // Once GitHub has completed, never strand the temporary branch on a storage error.
    try { removeBranch(ctx, record) }
    catch (error) { originalError ??= error }
  }
  if (originalError) throw originalError
  return result
}

async function run(ctx, sha) {
  const decision = decide(ctx, sha)
  const record = { sha, decision: decision.decision }
  if (decision.decision === 'skip') {
    if (!readRecord(ctx, sha)?.runId && !ctx.args.dryRun) save(ctx, record)
    return 'skip'
  }
  if (!ctx.args.dryRun) git(ctx, 'fetch', ctx.args.remote, 'main')
  const branch = ciBranchFor(sha)
  if (!ctx.args.dryRun && git(ctx, 'ls-remote', '--heads', ctx.args.remote, `refs/heads/${branch}`)) throw failure(`branch already exists: ${branch}`)
  const commits = lines(git(ctx, 'rev-list', `${ctx.args.remote}/main..${sha}`))
  const auth = ctx.io.join(ctx.gitDir, 'wt-push-authorized.json')
  if (ctx.args.dryRun) {
    ctx.print(`DRY-RUN branch=${branch} commits=${commits.join(',')} auth=${auth}`)
    ctx.print(`DRY-RUN git push ${ctx.args.remote} ${sha}:refs/heads/${branch}`)
    ctx.print(`DRY-RUN gh workflow run ${ctx.args.workflow} -R ${ctx.slug} --ref ${branch}`)
    return 'dry-run'
  }
  hookGuard(ctx)
  record.branch = branch
  try {
    authorizedPush(ctx, ['push', ctx.args.remote, `${sha}:refs/heads/${branch}`], JSON.stringify({ commits }), true)
    await discoverRun(ctx, record)
    return await collect(ctx, record)
  } catch (error) {
    if (git(ctx, 'ls-remote', '--heads', ctx.args.remote, `refs/heads/${branch}`)) removeBranch(ctx, record)
    throw error
  }
}

function releaseCheck(ctx) {
  const base = ctx.args.base ?? `${ctx.args.remote}/main`
  const ref = ctx.args.ref ?? 'HEAD'
  const source = ctx.args.pathsFile ?? `${shaOf(ctx, ref)}:${LIST}`
  let data
  if (ctx.args.pathsFile) {
    if (!ctx.io.exists(source)) throw failure(`missing paths list ${source}; default is ${ref}:${LIST}`)
    data = ctx.io.readText(source)
  } else {
    const shown = ctx.io.run('git', ['show', source], { cwd: ctx.cwd })
    if (shown.status !== 0) throw failure(`missing ${source}; override with --paths-file <file>`)
    data = shown.stdout
  }
  const commits = lines(git(ctx, 'rev-list', '--topo-order', `${base}..${ref}`))
  let verdict = null
  for (const sha of commits) {
    const decision = decide(ctx, sha, false, { source, data })
    if (decision.decision !== 'run') continue
    const record = readRecord(ctx, sha)
    if (!verdict && record?.runId && record.workflow === ctx.args.workflow) { verdict = record; continue }
    if (!verdict) ctx.print(`UNCHECKED ${sha} ${git(ctx, 'show', '-s', '--format=%s', sha)}`)
  }
  if (!verdict) { ctx.print('RESULT: unchecked no recorded host-layer run; missing run is not a regression'); return 0 }
  const state = freshEvidence(ctx, verdict.runId)
  const judged = verdictFromEvidence(state, verdict.sha)
  if (judged.verdict === 'green') { ctx.print(`RESULT: green run=${verdict.runId}`); return 0 }
  if (judged.verdict === 'pending') { ctx.print(`RESULT: pending run=${verdict.runId}`); return 5 }
  if (judged.verdict === 'unchecked') { ctx.print(`EVIDENCE MISMATCH: ${judged.reason}`); ctx.print(`RESULT: mismatch run=${verdict.runId}`); return 3 }
  ctx.print(`MATRIX INCOMPLETE: ${judged.reason}`)
  ctx.print(`BLOCKER: host-layer merge ${verdict.sha} cross-os run ${verdict.runId} conclusion=${state.conclusion}`)
  ctx.print(`RESULT: red run=${verdict.runId}`)
  return 1
}

export async function dispatch(argv, { io = commandIO, print = console.log } = {}) {
  let ctx
  try {
    const args = options(argv)
    if (['run', 'collect'].includes(args.command) && args.remote !== 'public') throw failure(`only public is protected by the pre-push hook; refusing remote ${args.remote}`)
    const cwd = args.repo ?? process.cwd()
    ctx = { args, cwd, io, print }
    ctx.gitDir = git(ctx, 'rev-parse', '--absolute-git-dir')
    const common = git(ctx, 'rev-parse', '--git-common-dir')
    ctx.store = io.join(isAbsolute(common) ? common : io.join(cwd, common), 'wt-crossos')
    const sha = args.merge && shaOf(ctx, args.merge)
    if (args.command === 'decide') {
      const decision = decide(ctx, sha)
      print(`RESULT: ${decision.decision}`)
      return 0
    }
    ctx.slug = slugFor(ctx)
    if (args.command === 'release-check') return releaseCheck(ctx)
    if (args.command === 'collect') {
      const record = readRecord(ctx, sha)
      if (!record) throw failure(`missing run record for ${sha}`)
      const code = await collect(ctx, record)
      print(`RESULT: ${RESULTS[code]} run=${record.runId}`)
      return code
    }
    const result = await run(ctx, sha)
    const code = typeof result === 'number' ? result : 0
    print(`RESULT: ${typeof result === 'string' ? result : RESULTS[code]}`)
    return code
  } catch (error) {
    const output = ctx?.print ?? print
    output(`ERROR: ${error.message}`)
    const code = error.code && Number.isInteger(error.code) ? error.code : 2
    output(`RESULT: ${RESULTS[code] ?? 'error'}`)
    return code
  }
}

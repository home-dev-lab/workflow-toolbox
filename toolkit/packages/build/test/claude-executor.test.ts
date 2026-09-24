import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareContextModeFixture } from './helpers/context-mode-fixture.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { executorBrief, executorCanUseTool, parseExecutorArgs } from '../../../../plugin/bin/lib/claude-executor-core.mjs'

prepareContextModeFixture()

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function waitFor(file: string, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs
  while (!existsSync(file) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  expect(existsSync(file), `timed out waiting for ${file}`).toBe(true)
}

function waitForExit(log: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs
  let tail = ''
  while (Date.now() < until) {
    if (existsSync(log)) tail = readFileSync(log, 'utf8').trim().split(/\r?\n/).at(-1) ?? ''
    if (/^EXIT=\d+$/.test(tail)) return tail
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  return tail
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-claude-executor-'))); roots.push(root)
  const worktree = join(root, 'worktree'); mkdirSync(join(worktree, '.lane'), { recursive: true })
  const home = join(root, 'home'); const config = join(root, 'config'); const state = join(root, 'state')
  mkdirSync(home); mkdirSync(config); mkdirSync(state)
  spawnSync('git', ['init', '-q'], { cwd: worktree })
  const installed = join(root, 'installed', 'plugin'); mkdirSync(installed, { recursive: true })
  cpSync(join(ROOT, 'plugin', 'bin'), join(installed, 'bin'), { recursive: true })
  cpSync(join(ROOT, 'plugin', 'hooks-modules'), join(installed, 'hooks-modules'), { recursive: true })
  cpSync(join(ROOT, 'plugin', 'skills'), join(installed, 'skills'), { recursive: true })
  const pluginData = join(root, 'workflow-toolbox-test')
  const sdk = join(pluginData, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'); mkdirSync(sdk, { recursive: true })
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.280', main: 'index.cjs' }))
  writeFileSync(join(sdk, 'index.cjs'), `
const fs=require('node:fs');
exports.query=({prompt,options})=>(async function*(){
  fs.writeFileSync(process.env.FAKE_RECEIPT,JSON.stringify({prompt,tools:options.tools,settingSources:options.settingSources,plugins:options.plugins,model:options.model,sandbox:options.sandbox,outside:await options.canUseTool('Write',{file_path:process.env.FAKE_OUTSIDE}),unsandboxed:await options.canUseTool('Bash',{command:'true',dangerouslyDisableSandbox:true})}));
  const mode=process.env.FAKE_MODE;
  if(process.env.FAKE_HANG==='true') await new Promise((resolve)=>options.abortController.signal.addEventListener('abort',resolve,{once:true}));
  else if(mode==='first-result') yield {type:'result',subtype:'success',is_error:false,result:'too early'};
  else if(mode!=='empty') { const report=new RegExp('Write the report to \\x60([^\\x60]+)\\x60').exec(prompt)[1]; if(mode!=='no-write') fs.writeFileSync(report,'executor report\\n'); yield {type:'system',subtype:'init',model:'claude-sonnet-test',tools:options.tools,plugins:options.plugins.map((plugin)=>({path:plugin.path,name:plugin.path.endsWith('/tdd')?'wt-sdk-tdd':undefined})),skills:options.tools.includes('Bash')?['wt-sdk-tdd:changelog']:[]}; if(mode==='multiple') { yield {type:'result',is_error:false,usage:{input_tokens:2,cache_creation_input_tokens:3,cache_read_input_tokens:5,output_tokens:7}}; yield {type:'result',is_error:false,usage:{input_tokens:11,cache_creation_input_tokens:13,cache_read_input_tokens:17,output_tokens:19}}; } else yield {type:'result',subtype:'success',is_error:mode==='error',usage:{input_tokens:3,cache_creation_input_tokens:5,cache_read_input_tokens:7,output_tokens:11},result:mode==='no-write'?' generated review ': 'executor report'}; }
})()`)
  return { root, worktree, cli: join(ROOT, 'plugin', 'bin', 'wt-claude-executor.mjs'), env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_DATA: pluginData, WT_AGENT_SDK_PATH: join(sdk, 'index.cjs'), XDG_STATE_HOME: state } }
}

describe('Claude SDK executor', () => {
  it('item 1: rejects a missing --dir before spawning a worker', () => {
    const f = fixture(); const missing = join(f.root, 'missing'); const brief = join(f.root, 'brief.md'); writeFileSync(brief, 'unused\n')
    const result = spawnSync(process.execPath, [f.cli, '--dir', missing, '--model', 'sonnet', '--brief', brief, '--role', 'tdd'], { encoding: 'utf8', env: f.env })
    expect(result.status).toBe(2); expect(result.stderr).toBe(`wt-claude-executor: --dir is not a directory: ${missing}\n`); expect(result.stdout).toBe('')
  })

  it('item 2: rejects a missing --brief before spawning a worker', () => {
    const f = fixture(); const missing = join(f.root, 'missing.md')
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'sonnet', '--brief', missing, '--role', 'tdd'], { encoding: 'utf8', env: f.env })
    expect(result.status).toBe(2); expect(result.stderr).toBe(`wt-claude-executor: --brief does not exist: ${missing}\n`); expect(result.stdout).toBe('')
  })

  it('item 3: rejects an invalid model alias before spawning a worker', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'tdd-report.model.md'); const brief = join(f.root, 'brief.md'); writeFileSync(brief, `Write the report to \`${report}\`.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'bogus', '--brief', brief, '--role', 'tdd'], { encoding: 'utf8', env: f.env })
    expect(result.status).toBe(2); expect(result.stderr).toBe('wt-claude-executor: executor Claude override must be a harness model alias (haiku, sonnet, opus, fable); refused model value: bogus\n'); expect(result.stdout).toBe('')
  })

  it('item 4: reports an executorBrief guard failure before spawning a worker', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'review-report.wrong-role.md'); const brief = join(f.root, 'brief.md'); writeFileSync(brief, `Write the report to \`${report}\`.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'opus', '--brief', brief, '--role', 'critic'], { encoding: 'utf8', env: f.env })
    expect(result.status).toBe(2); expect(result.stderr).toBe(`wt-claude-executor: brief report path is not a nonce lane report: ${report}\n`); expect(result.stdout).toBe('')
  })

  it('item 5: prints help without validating launch arguments', () => {
    const f = fixture(); const result = spawnSync(process.execPath, [f.cli, '--help'], { encoding: 'utf8', env: f.env })
    expect(result.status).toBe(0); expect(result.stdout).toMatch(/^Usage: node wt-claude-executor\.mjs /); expect(result.stderr).toBe('')
  })

  it('item 6: reports malformed argv with the CLI prefix and usage', () => {
    const f = fixture(); const result = spawnSync(process.execPath, [f.cli, '--unknown'], { encoding: 'utf8', env: f.env })
    expect(result.status).toBe(2); expect(result.stderr).toMatch(/^wt-claude-executor: unknown argument: --unknown\nUsage: node wt-claude-executor\.mjs /); expect(result.stdout).toBe('')
  })

  it('derives read-only from the launched role, never from text inside the brief', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-executor-role-'))); roots.push(root); mkdirSync(join(root, '.lane'))
    expect(parseExecutorArgs(['--dir', root, '--model', 'sonnet', '--brief', join(root, 'b.md')])).toMatchObject({ error: expect.stringContaining('--role') })
    const tddReport = join(root, '.lane', 'tdd-report.n1.md')
    const brief = join(root, 'b.md'); writeFileSync(brief, `You are the independent reviewer.\nWrite the report to \`${tddReport}\` now.\n`)
    expect(executorBrief(parseExecutorArgs(['--dir', root, '--model', 'sonnet', '--brief', brief, '--role', 'tdd'])).readOnly).toBe(false)
    const reviewReport = join(root, '.lane', 'review-report.n2.md')
    writeFileSync(brief, `Write the report to \`${reviewReport}\` now.\n`)
    expect(executorBrief(parseExecutorArgs(['--dir', root, '--model', 'opus', '--brief', brief, '--role', 'review'])).readOnly).toBe(true)
    expect(() => executorBrief(parseExecutorArgs(['--dir', root, '--model', 'opus', '--brief', brief, '--role', 'critic']))).toThrow('nonce lane report')
  })


  it('fences writable tools to the worktree and read-only writes to the nonce report', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-executor-fence-')); roots.push(root); mkdirSync(join(root, '.lane'))
    const report = join(root, '.lane', 'review-report.nonce.md')
    expect(executorCanUseTool(root, report, true, 'Write', { file_path: report })).toEqual({ behavior: 'allow' })
    expect(executorCanUseTool(root, report, true, 'Write', { file_path: join(root, 'source.ts') }).behavior).toBe('deny')
    expect(executorCanUseTool(root, report, false, 'Edit', { file_path: join(root, 'source.ts') }).behavior).toBe('allow')
    expect(executorCanUseTool(root, report, false, 'Bash', { command: 'touch /tmp/outside' }).behavior).toBe('deny')
    expect(executorCanUseTool(root, report, false, 'Bash', { command: 'cd .. && touch escaped' }).behavior).toBe('deny')
    expect(executorCanUseTool(root, report, false, 'Bash', { command: `node -e "require('fs').writeFileSync(require('path').resolve('..','escaped-computed'),'x')"` }).behavior).toBe('deny')
    expect(executorCanUseTool(root, report, false, 'Bash', { command: `node -e "require('fs').writeFileSync(Buffer.from('2e2e2f65736361706564','hex').toString(),'x')"` }).behavior).toBe('allow')
    expect(executorCanUseTool(root, report, false, 'Bash', { command: `p=$(printf '\\056\\056\\057escaped'); : > "$p"` }).behavior).toBe('allow')
    expect(executorCanUseTool(root, report, false, 'Bash', { command: 'pnpm test' }).behavior).toBe('allow')
    expect(executorCanUseTool(root, report, false, 'Bash', { command: 'git diff -- plugin/CHANGELOG.md' }).behavior).toBe('allow')
    expect(executorCanUseTool(root, report, false, 'Bash', { command: 'git show HEAD:plugin/CHANGELOG.md' }).behavior).toBe('allow')
    const outside = mkdtempSync(join(tmpdir(), 'wt-executor-outside-')); roots.push(outside); symlinkSync(outside, join(root, 'link'))
    expect(executorCanUseTool(root, report, false, 'Write', { file_path: join(root, 'link', 'escaped') }).behavior).toBe('deny')
  })

  it('launches the writer with mandatory sandboxing and denies per-command escape', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'tdd-report.sandbox.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'sandbox.log'); const receipt = join(f.root, 'receipt.json')
    writeFileSync(brief, `Write the report to \`${report}\`.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'sonnet', '--brief', brief, '--log', log, '--timeout', '2', '--role', 'tdd'], { encoding: 'utf8', env: { ...f.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: join(f.root, 'outside') } })
    expect(result.status).toBe(0); expect(waitForExit(log, 3000)).toBe('EXIT=0')
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
      sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, failIfUnavailable: true },
      unsandboxed: { behavior: 'deny', message: 'unsandboxed Bash refused' },
    })
  })

  it.runIf(process.env.WT_CLAUDE_EXECUTOR_REAL_E2E === 'true')('keeps real SDK Bash writes inside the worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-executor-real-')); roots.push(root)
    const worktree = join(root, 'worktree'); mkdirSync(join(worktree, '.lane'), { recursive: true }); spawnSync('git', ['init', '-q'], { cwd: worktree })
    const marker = `cd-escape-${process.pid}`; const computedMarker = `computed-escape-${process.pid}`; const nodeSandboxMarker = `node-sandbox-escape-${process.pid}`; const sandboxMarker = `sandbox-escape-${process.pid}`
    const encodedSandboxPath = Buffer.from(`../${nodeSandboxMarker}`).toString('hex')
    const report = join(worktree, '.lane', 'tdd-report.confinement.md'); const brief = join(worktree, '.lane', 'brief.md'); const log = join(worktree, '.lane', 'real-sdk.log')
    writeFileSync(brief, `This is a confinement regression fixture. Use Bash to run each command exactly once and record each tool result verbatim in the report. Do not try alternative commands.\n\n1. \`cd .. && touch ${marker}\`\n2. \`node -e "require('fs').writeFileSync(require('path').resolve('..','${computedMarker}'),'x')"\`\n3. \`node -e "require('fs').writeFileSync(Buffer.from('${encodedSandboxPath}','hex').toString(),'x')"\`\n4. \`p=$(printf '\\056\\056\\057${sandboxMarker}'); : > "$p"\`\n\nWrite the report to \`${report}\`.\n`)
    const home = join(root, 'home'); const config = join(root, 'config'); const state = join(root, 'state'); mkdirSync(home); mkdirSync(config); mkdirSync(state)
    const result = spawnSync(process.execPath, [join(ROOT, 'plugin', 'bin', 'wt-claude-executor.mjs'), '--dir', worktree, '--model', 'sonnet', '--brief', brief, '--log', log, '--timeout', '120', '--role', 'tdd'], { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, XDG_STATE_HOME: state } })
    expect(result.status).toBe(0); expect(result.stdout).toMatch(/^pid=\d+/)
    expect(waitForExit(log, 150_000)).toBe('EXIT=0')
    const toolResults = readFileSync(report, 'utf8')
    if (process.env.WT_EXECUTOR_E2E_OUTPUT === 'true') process.stdout.write(`CLAUDE_EXECUTOR_CONFINEMENT report=${JSON.stringify(toolResults)} cd=${existsSync(join(root, marker))} computed=${existsSync(join(root, computedMarker))} nodeSandbox=${existsSync(join(root, nodeSandboxMarker))} sandbox=${existsSync(join(root, sandboxMarker))}\n`)
    expect(toolResults).toContain(marker); expect(toolResults).toContain(computedMarker); expect(toolResults).toMatch(/read-only file system/i)
    expect(existsSync(join(root, marker)), `${basename(report)}: cd escape marker exists`).toBe(false)
    expect(existsSync(join(root, computedMarker)), `${basename(report)}: computed escape marker exists`).toBe(false)
    expect(existsSync(join(root, nodeSandboxMarker)), `${basename(report)}: encoded Node escape marker exists`).toBe(false)
    expect(existsSync(join(root, sandboxMarker)), `${basename(report)}: sandbox escape marker exists`).toBe(false)
  }, 160_000)

  it('allows read-only review roles to Read the configured knowledge-base index and its Markdown fiches only', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-executor-kb-worktree-')); roots.push(root); mkdirSync(join(root, '.lane'))
    const knowledgeBase = mkdtempSync(join(tmpdir(), 'wt-executor-kb-')); roots.push(knowledgeBase)
    const index = join(knowledgeBase, 'MEMORY.md'); const fiche = join(knowledgeBase, 'fiches', 'review.md')
    mkdirSync(join(knowledgeBase, 'fiches')); writeFileSync(index, '- [review](fiches/review.md)\n'); writeFileSync(fiche, '# Review\n'); writeFileSync(join(knowledgeBase, 'private.txt'), 'no\n')
    const report = join(root, '.lane', 'review-report.nonce.md')
    const options = parseExecutorArgs(['--dir', root, '--model', 'opus', '--brief', join(root, 'brief.md'), '--role', 'review', '--knowledge-base-index', index])
    expect(options).toMatchObject({ knowledgeBaseIndex: index })
    expect(executorCanUseTool(root, report, true, 'Read', { file_path: fiche }, { knowledgeBaseIndex: index })).toEqual({ behavior: 'allow' })
    expect(executorCanUseTool(root, report, true, 'Read', { file_path: join(knowledgeBase, 'private.txt') }, { knowledgeBaseIndex: index }).behavior).toBe('deny')
    expect(executorCanUseTool(root, report, true, 'Grep', { path: knowledgeBase, pattern: 'Review' }, { knowledgeBaseIndex: index }).behavior).toBe('deny')
    expect(executorCanUseTool(root, report, false, 'Read', { file_path: fiche }, { knowledgeBaseIndex: index }).behavior).toBe('deny')
  })

  it('prints a detached pid, loads the guard, writes only the named report, and ends its log with EXIT=0', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'tdd-report.nonce.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'run.log'); const receipt = join(f.root, 'receipt.json'); const outside = join(f.root, 'outside.txt')
    writeFileSync(brief, `Implement the task.\n\nWrite the report to \`${report}\`.\n`)
    writeFileSync(join(f.worktree, 'AGENTS.md'), '# Guide\n')
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'sonnet', '--brief', brief, '--log', log, '--timeout', '2', '--role', 'tdd'], { encoding: 'utf8', env: { ...f.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: outside } })
    expect(result.status).toBe(0); expect(result.stdout).toMatch(/^pid=\d+\nlog=.+\n$/); expect(result.stderr).toBe('')
    waitFor(report); waitFor(receipt)
    // The executor appends its variant line to the report after the SDK wrote it, before EXIT: read after EXIT.
    expect(waitForExit(log, 3000)).toBe('EXIT=0')
    expect(readFileSync(report, 'utf8')).toBe('executor report\n\nvariant=high origin=role base forced=false\n')
    waitFor(`${log}.usage.json`)
    expect(JSON.parse(readFileSync(`${log}.usage.json`, 'utf8'))).toEqual({ model: 'claude-sonnet-test', totals: { input: 3, cache_creation: 5, cache_read: 7, output: 11 } })
    expect(existsSync(outside)).toBe(false)
    const sdkReceipt = JSON.parse(readFileSync(receipt, 'utf8'))
    expect(sdkReceipt).toMatchObject({ tools: expect.arrayContaining(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']), settingSources: [], model: 'sonnet', outside: { behavior: 'deny' } })
    expect(sdkReceipt.prompt).toContain(`${join(f.worktree, 'AGENTS.md')} is the repository's contributor guide; read it before planning or changing code.`)
    expect(sdkReceipt.plugins[0].path).toContain(join('hooks-modules', 'pilot-guard'))
    if (process.env.WT_EXECUTOR_E2E_OUTPUT === 'true') process.stdout.write(`CLAUDE_EXECUTOR_E2E ${result.stdout.trim()} EXIT=0 report=${readFileSync(report, 'utf8').trim()} outside=${existsSync(outside)}\n`)
  })

  it('ends a timed-out detached worker log with EXIT=124', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'review-report.timeout.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'timeout.log'); const receipt = join(f.root, 'receipt.json')
    writeFileSync(brief, `You are the independent reviewer.\nWrite the report to \`${report}\` with exactly one verdict block.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'opus', '--brief', brief, '--log', log, '--timeout', '0.05', '--role', 'review'], { encoding: 'utf8', env: { ...f.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: join(f.root, 'outside'), FAKE_HANG: 'true' } })
    expect(result.status).toBe(0); expect(result.stdout).toMatch(/^pid=\d+/)
    waitFor(log); const until = Date.now() + 3000
    while (readFileSync(log, 'utf8').trim().split(/\r?\n/).at(-1) !== 'EXIT=124' && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    expect(readFileSync(log, 'utf8').trim().split(/\r?\n/).at(-1)).toBe('EXIT=124')
    expect(JSON.parse(readFileSync(receipt, 'utf8')).tools).toEqual(['Read', 'Glob', 'Grep', 'mcp__plugin_context-mode_context-mode__ctx_search'])
  })

  it('item 7: the log always ENDS with an exit marker, even when an earlier marker is followed by later lines', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'review-report.idempotent.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'idempotent.log'); const receipt = join(f.root, 'receipt.json')
    writeFileSync(brief, `Write the report to \`${report}\`.\n`); writeFileSync(log, 'EXIT=0\n')
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'opus', '--brief', brief, '--log', log, '--timeout', '0.05', '--role', 'review'], { encoding: 'utf8', env: { ...f.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: join(f.root, 'outside'), FAKE_HANG: 'true' } })
    expect(result.status).toBe(0); waitFor(receipt); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    // A waiter reads the LAST line. Diagnostics written after a pre-seeded marker must not leave the log without a final one.
    expect(readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).at(-1)).toMatch(/^EXIT=\d+$/)
  })

  // wt-claude-executor states that Windows forced termination has no POSIX 143/130 marker contract.
  it.skipIf(process.platform === 'win32')('item 8: SIGTERM and SIGINT sent to the pid the launcher prints write exit markers 143 and 130', () => {
    for (const [signal, exit] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
      const f = fixture(); const report = join(f.worktree, '.lane', `review-report.${signal.toLowerCase()}.md`); const brief = join(f.root, `${signal}.md`); const log = join(f.worktree, '.lane', `${signal}.log`); const receipt = join(f.root, `${signal}.json`)
      writeFileSync(brief, `Write the report to \`${report}\`.\n`)
      const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'opus', '--brief', brief, '--log', log, '--timeout', '5', '--role', 'review'], { encoding: 'utf8', env: { ...f.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: join(f.root, 'outside'), FAKE_HANG: 'true' } })
      expect(result.status).toBe(0); waitFor(receipt); const workerPid = Number(/^pid=(\d+)$/m.exec(result.stdout)?.[1]); expect(workerPid).toBeGreaterThan(0)
      process.kill(workerPid, signal); const until = Date.now() + 3000
      while (!readFileSync(log, 'utf8').split(/\r?\n/).includes(`EXIT=${exit}`) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      expect(readFileSync(log, 'utf8').split(/\r?\n/)).toContain(`EXIT=${exit}`)
    }
  })

  it('item 9: rejects a stream whose first message is not an initialization receipt', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'tdd-report.first.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'first.log'); const receipt = join(f.root, 'receipt.json'); writeFileSync(brief, `Write the report to \`${report}\`.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'sonnet', '--brief', brief, '--log', log, '--timeout', '2', '--role', 'tdd'], { encoding: 'utf8', env: { ...f.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: join(f.root, 'outside'), FAKE_MODE: 'first-result' } })
    expect(result.status).toBe(0); expect(waitForExit(log, 3000)).toBe('EXIT=1'); expect(readFileSync(log, 'utf8')).toContain('SDK executor initialization receipt never arrived: the first message was result/success')
  })

  it('item 10: rejects a stream that ends without an initialization receipt', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'tdd-report.empty.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'empty.log'); const receipt = join(f.root, 'receipt.json'); writeFileSync(brief, `Write the report to \`${report}\`.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'sonnet', '--brief', brief, '--log', log, '--timeout', '2', '--role', 'tdd'], { encoding: 'utf8', env: { ...f.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: join(f.root, 'outside'), FAKE_MODE: 'empty' } })
    expect(result.status).toBe(0); expect(waitForExit(log, 3000)).toBe('EXIT=1'); expect(readFileSync(log, 'utf8')).toContain('SDK executor run ended without an initialization receipt')
  })

  it('item 11: writes a read-only report from terminal result text when absent', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'review-report.generated.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'generated.log'); const receipt = join(f.root, 'receipt.json'); writeFileSync(brief, `Write the report to \`${report}\`.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'opus', '--brief', brief, '--log', log, '--timeout', '2', '--role', 'review'], { encoding: 'utf8', env: { ...f.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: join(f.root, 'outside'), FAKE_MODE: 'no-write' } })
    expect(result.status).toBe(0); expect(waitForExit(log, 3000)).toBe('EXIT=0'); expect(readFileSync(report, 'utf8')).toBe('generated review\n\nvariant=high origin=role base forced=false\n')
  })

  it('item 12: exits 1 when the terminal result is_error despite a written report', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'tdd-report.error.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'error.log'); const receipt = join(f.root, 'receipt.json'); writeFileSync(brief, `Write the report to \`${report}\`.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'sonnet', '--brief', brief, '--log', log, '--timeout', '2', '--role', 'tdd'], { encoding: 'utf8', env: { ...f.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: join(f.root, 'outside'), FAKE_MODE: 'error' } })
    expect(result.status).toBe(0); expect(waitForExit(log, 3000)).toBe('EXIT=1'); expect(readFileSync(report, 'utf8')).toBe('executor report\n\nvariant=high origin=role base forced=false\n')
  })

  it('item 13: accumulates usage across multiple result messages', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'tdd-report.multiple.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'multiple.log'); const receipt = join(f.root, 'receipt.json'); writeFileSync(brief, `Write the report to \`${report}\`.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'sonnet', '--brief', brief, '--log', log, '--timeout', '2', '--role', 'tdd'], { encoding: 'utf8', env: { ...f.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: join(f.root, 'outside'), FAKE_MODE: 'multiple' } })
    expect(result.status).toBe(0); expect(waitForExit(log, 3000)).toBe('EXIT=0'); waitFor(`${log}.usage.json`)
    expect(JSON.parse(readFileSync(`${log}.usage.json`, 'utf8')).totals).toEqual({ input: 13, cache_creation: 16, cache_read: 22, output: 26 })
  })
})

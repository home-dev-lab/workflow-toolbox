import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { executorBrief, executorCanUseTool, executorTools, parseExecutorArgs } from '../../../../plugin/bin/lib/claude-executor-core.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function waitFor(file: string, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs
  while (!existsSync(file) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  expect(existsSync(file), `timed out waiting for ${file}`).toBe(true)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-claude-executor-')); roots.push(root)
  const worktree = join(root, 'worktree'); mkdirSync(join(worktree, '.lane'), { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: worktree })
  const installed = join(root, 'installed', 'plugin'); mkdirSync(installed, { recursive: true })
  cpSync(join(ROOT, 'plugin', 'bin'), join(installed, 'bin'), { recursive: true })
  cpSync(join(ROOT, 'plugin', 'hooks-modules'), join(installed, 'hooks-modules'), { recursive: true })
  const sdk = join(worktree, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'); mkdirSync(sdk, { recursive: true })
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', main: 'index.cjs' }))
  writeFileSync(join(sdk, 'index.cjs'), `
const fs=require('node:fs');
exports.query=({prompt,options})=>(async function*(){
  fs.writeFileSync(process.env.FAKE_RECEIPT,JSON.stringify({tools:options.tools,settingSources:options.settingSources,plugins:options.plugins,model:options.model,outside:await options.canUseTool('Write',{file_path:process.env.FAKE_OUTSIDE})}));
  if(process.env.FAKE_HANG==='true') await new Promise((resolve)=>options.abortController.signal.addEventListener('abort',resolve,{once:true}));
  else { const report=new RegExp('Write the report to \\x60([^\\x60]+)\\x60').exec(prompt)[1]; fs.writeFileSync(report,'executor report\\n'); yield {type:'result',subtype:'success',is_error:false}; }
})()`)
  return { root, worktree, cli: join(installed, 'bin', 'wt-claude-executor.mjs') }
}

describe('Claude SDK executor', () => {
  it('derives read-only from the launched role, never from text inside the brief', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-executor-role-')); roots.push(root); mkdirSync(join(root, '.lane'))
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
    expect(executorTools(false)).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'])
    expect(executorTools(true)).toEqual(['Read', 'Glob', 'Grep', 'Write'])
    expect(executorCanUseTool(root, report, true, 'Write', { file_path: report })).toEqual({ behavior: 'allow' })
    expect(executorCanUseTool(root, report, true, 'Write', { file_path: join(root, 'source.ts') }).behavior).toBe('deny')
    expect(executorCanUseTool(root, report, false, 'Edit', { file_path: join(root, 'source.ts') }).behavior).toBe('allow')
    expect(executorCanUseTool(root, report, false, 'Bash', { command: 'touch /tmp/outside' }).behavior).toBe('deny')
    expect(executorCanUseTool(root, report, false, 'Bash', { command: 'pnpm test' }).behavior).toBe('allow')
    const outside = mkdtempSync(join(tmpdir(), 'wt-executor-outside-')); roots.push(outside); symlinkSync(outside, join(root, 'link'))
    expect(executorCanUseTool(root, report, false, 'Write', { file_path: join(root, 'link', 'escaped') }).behavior).toBe('deny')
  })

  it('prints a detached pid, loads the guard, writes only the named report, and ends its log with EXIT=0', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'tdd-report.nonce.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'run.log'); const receipt = join(f.root, 'receipt.json'); const outside = join(f.root, 'outside.txt')
    writeFileSync(brief, `Implement the task.\n\nWrite the report to \`${report}\`.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'sonnet', '--brief', brief, '--log', log, '--timeout', '2', '--role', 'tdd'], { encoding: 'utf8', env: { ...process.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: outside } })
    expect(result.status).toBe(0); expect(result.stdout).toMatch(/^pid=\d+\nlog=.+\n$/); expect(result.stderr).toBe('')
    waitFor(report); waitFor(receipt)
    expect(readFileSync(report, 'utf8')).toBe('executor report\n')
    expect(readFileSync(log, 'utf8').trim().split(/\r?\n/).at(-1)).toBe('EXIT=0')
    expect(existsSync(outside)).toBe(false)
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'], settingSources: [], model: 'sonnet', outside: { behavior: 'deny' } })
    expect(JSON.parse(readFileSync(receipt, 'utf8')).plugins[0].path).toContain(join('hooks-modules', 'pilot-guard'))
    if (process.env.WT_EXECUTOR_E2E_OUTPUT === 'true') process.stdout.write(`CLAUDE_EXECUTOR_E2E ${result.stdout.trim()} EXIT=0 report=${readFileSync(report, 'utf8').trim()} outside=${existsSync(outside)}\n`)
  })

  it('ends a timed-out detached worker log with EXIT=124', () => {
    const f = fixture(); const report = join(f.worktree, '.lane', 'review-report.timeout.md'); const brief = join(f.root, 'brief.md'); const log = join(f.worktree, '.lane', 'timeout.log'); const receipt = join(f.root, 'receipt.json')
    writeFileSync(brief, `You are the independent reviewer.\nWrite the report to \`${report}\` with exactly one verdict block.\n`)
    const result = spawnSync(process.execPath, [f.cli, '--dir', f.worktree, '--model', 'opus', '--brief', brief, '--log', log, '--timeout', '0.05', '--role', 'review'], { encoding: 'utf8', env: { ...process.env, FAKE_RECEIPT: receipt, FAKE_OUTSIDE: join(f.root, 'outside'), FAKE_HANG: 'true' } })
    expect(result.status).toBe(0); expect(result.stdout).toMatch(/^pid=\d+/)
    waitFor(log); const until = Date.now() + 3000
    while (readFileSync(log, 'utf8').trim().split(/\r?\n/).at(-1) !== 'EXIT=124' && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    expect(readFileSync(log, 'utf8').trim().split(/\r?\n/).at(-1)).toBe('EXIT=124')
    expect(JSON.parse(readFileSync(receipt, 'utf8')).tools).toEqual(['Read', 'Glob', 'Grep', 'Write'])
  })
})

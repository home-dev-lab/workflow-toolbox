import { afterAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sealRuleNarrativeFile } from '../../../test-support/rule-narrative-stub.js'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
import { addedLines, detectNarrative } from '../../../../plugin/bin/lib/rule-narrative-detect.mjs'
import { buildSplitRequest, splitNarrative, splitTimeoutMs, renderNarrativeMessage, runSplitChild } from '../../../../plugin/bin/lib/rule-narrative-split.mjs'

const lines = addedLines({ tool: 'Write', input: { content: 'Keep retries.\nAlice said at 16h50 to retry.\nCheck the ACK.' } })
const findings = detectNarrative(lines)
const answer = (text: string) => async () => ({ ok: true, stdout: text })
const fileSeal = sealRuleNarrativeFile()
afterAll(fileSeal.restore)

describe('rule narrative proposal validation', () => {
  it.skipIf(process.platform === 'win32')('seals a mutation ignoring the injected runner and binary override at file level', async () => {
    const dir = join(fileSeal.root, 'mutated-lib')
    cpSync(new URL('../../../../plugin/bin/lib/', import.meta.url), dir, { recursive: true })
    const file = join(dir, 'rule-narrative-split.mjs')
    const original = readFileSync(file, 'utf8')
    expect(original).toContain('await run({ ...request, timeoutMs, signal, env })')
    writeFileSync(file, original.replace('await run({ ...request, timeoutMs, signal, env })',
      'await runSplitChild({ ...request, timeoutMs, signal, env })')
      .replace("env.WT_RULE_NARRATIVE_CLAUDE_BIN || 'claude'", "'claude'"))
    const script = `import { splitNarrative } from ${JSON.stringify(pathToFileURL(file).href)};
      const result = await splitNarrative({ lines: ${JSON.stringify(lines)}, findings: ${JSON.stringify(findings)},
        run: () => { throw new Error('mutant must ignore the injected runner') } });
      console.log(JSON.stringify(result));`
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: sealedPluginCliEnv(fileSeal.root), encoding: 'utf8', timeout: 15000,
    })
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout).ok).toBe(true)
    expect(existsSync(fileSeal.env.TEST_RULE_STUB_RECORD!)).toBe(true)
    expect(JSON.parse(readFileSync(fileSeal.env.TEST_RULE_STUB_RECORD!, 'utf8')).stdin).toContain('Alice said at 16h50')
  }, 20000)

  it('accepts fenced outermost JSON with one clean proposal per flagged line', async () => {
    const result = await splitNarrative({ lines, findings, run: answer('```json\n{"proposals":[{"line":2,"text":"Keep retries enabled."}]}\n```') })
    expect(result).toEqual({ ok: true, proposals: [{ line: 2, text: 'Keep retries enabled.' }] })
    const request = buildSplitRequest(lines, findings)
    expect(request.stdin).toContain('Alice said at 16h50 to retry.')
    expect(request.stdin).toContain('Keep retries.')
    expect(request.stdin).toContain('Check the ACK.')
  })

  it.each([
    ['non-JSON', 'invalid JSON'],
    ['{"proposals":[]}', 'proposal coverage'],
    ['{"proposals":[{"line":2,"text":""}]}', 'empty proposal'],
    ['{"proposals":[{"line":2,"text":"2026-10-01"}]}', 'proposal still contains narrative'],
    ['{"proposals":[{"line":2,"text":"2026-10-01 <!-- rule-lint: allow -->"}]}', 'proposal still contains narrative'],
    ['{"proposals":[{"line":2,"text":"Yesterday retry."}]}', 'proposal still contains narrative'],
    ['{"proposals":[{"line":2,"text":"Retry."},{"line":2,"text":"Retry."}]}', 'proposal coverage'],
    ['{"proposals":[{"line":1,"text":"Retry."}]}', 'proposal coverage'],
    ['{"proposals":[{"line":2,"text":"Retry."}],"history":"invented"}', 'invalid schema'],
  ])('rejects %s with a named reason', async (stdout, reason) => {
    expect(await splitNarrative({ lines, findings, run: answer(stdout) })).toEqual({ ok: false, reason })
  })

  it.each(['...', '—\t', '🛑'])('rejects a proposal without a Unicode letter or digit: %s', async text => {
    expect(await splitNarrative({ lines, findings, run: answer(JSON.stringify({ proposals: [{ line: 2, text }] })) }))
      .toEqual({ ok: false, reason: 'proposal has no letter or digit' })
  })

  it.each(['\u0000', '\u001b', '\r', '\n', '\u0085', '\u009f', '\u200b', '\ufeff', '\u2066', '\u{e0001}'])('rejects control/format characters in proposals: %j', async control => {
    expect(await splitNarrative({ lines, findings, run: answer(JSON.stringify({ proposals: [{ line: 2, text: `Retry${control}` }] })) }))
      .toEqual({ ok: false, reason: 'proposal contains control or format characters' })
  })

  it.each(['Éviter les doublons.', '重试', '123', 'Retry\tcarefully.'])('accepts letters and digits across scripts, retaining tabs: %s', async text => {
    expect(await splitNarrative({ lines, findings, run: answer(JSON.stringify({ proposals: [{ line: 2, text }] })) }))
      .toEqual({ ok: true, proposals: [{ line: 2, text }] })
  })

  it('caps model input by refusing to call rather than truncating it', async () => {
    const huge = addedLines({ tool: 'Write', input: { content: `Yesterday ${'x'.repeat(13000)}` } })
    const run = vi.fn(answer(''))
    expect(await splitNarrative({ lines: huge, findings: detectNarrative(huge), run })).toEqual({ ok: false, reason: 'split input exceeds cap' })
    expect(run).not.toHaveBeenCalled()
  })

  it('names the kill switch before input-size checks and never invokes an injected runner', async () => {
    const huge = addedLines({ tool: 'Write', input: { content: `Yesterday ${'x'.repeat(13000)}` } })
    const run = vi.fn(answer(''))
    expect(await splitNarrative({ lines: huge, findings: detectNarrative(huge), run,
      env: { ...process.env, WT_RULE_NARRATIVE_SPLIT: 'off' } })).toEqual({ ok: false, reason: 'split disabled' })
    expect(run).not.toHaveBeenCalled()
  })

  it('clamps the deadline and defaults invalid values to twelve seconds', () => {
    expect([undefined, 'bad', '0', '1', '30000', '1500'].map(splitTimeoutMs)).toEqual([12000, 12000, 1000, 1000, 25000, 1500])
  })

  it('degrades Windows command launchers without spawning', async () => {
    const spawnChild = vi.fn(() => { throw new Error('must not spawn') })
    expect(await runSplitChild({ instruction: 'test', stdin: '', timeoutMs: 1000,
      env: { ...process.env, WT_RULE_NARRATIVE_CLAUDE_BIN: 'claude.cmd' }, platform: 'win32', spawnChild })).toEqual({ ok: false, reason: 'split unavailable on this platform: claude.cmd needs a shell' })
    expect(spawnChild).not.toHaveBeenCalled()
  })

  it('kills a Windows native child on abort with SIGKILL and resolves immediately', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() }),
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() }),
      kill: vi.fn(), unref: vi.fn(),
    })
    const controller = new AbortController()
    const promise = runSplitChild({ instruction: 'test', stdin: 'test', timeoutMs: 1000, signal: controller.signal,
      env: { ...process.env, WT_RULE_NARRATIVE_CLAUDE_BIN: 'native.exe' }, platform: 'win32', spawnChild: () => child })
    controller.abort()
    expect(await promise).toEqual({ ok: false, reason: 'split deadline exceeded' })
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(child.stdin.destroy).toHaveBeenCalledOnce()
    expect(child.stdout.destroy).toHaveBeenCalledOnce()
  })

  it('preserves a named stdin piping failure and cleans up a native child', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() }),
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() }),
      kill: vi.fn(), unref: vi.fn(),
    })
    // The file-level seal exports a claude.cmd stub on a Windows host; a native child needs an explicit .exe name.
    const promise = runSplitChild({ instruction: 'test', stdin: 'test', timeoutMs: 1000,
      env: { ...process.env, WT_RULE_NARRATIVE_CLAUDE_BIN: 'native.exe' }, platform: 'win32', spawnChild: () => child })
    child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }))
    expect(await promise).toEqual({ ok: false, reason: 'stdin pipe error EPIPE' })
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it('preserves history verbatim even if a proposal is unavailable', () => {
    const message = renderNarrativeMessage({ findings, lines, result: { ok: false, reason: 'test failure' } })
    expect(message.split('HISTORY —')[1]?.split('RULE —')[0]).toContain('line 2: Alice said at 16h50 to retry.')
    expect(message).toContain('no proposal available (test failure)')
  })

  it('bounds JSON-escaped output and keeps embedded fences inside whole HISTORY lines', () => {
    const text = `Yesterday ${'\\"\u0000'.repeat(100)}\n\x60\x60\x60 Yesterday\n${'Yesterday\n'.repeat(1000)}`
    const source = addedLines({ tool: 'Write', input: { content: text } })
    const message = renderNarrativeMessage({ lines: source, findings: detectNarrative(source), result: { ok: false, reason: 'split input exceeds cap' } })
    const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } })
    expect(output.length).toBeLessThan(9500)
    const history = message.split('HISTORY —')[1]?.split('RULE —')[0] ?? ''
    expect(history).toContain(`line 1: ${text.split('\n')[0]?.replaceAll('\u0000', '\\u0000')}`)
    expect(history).toContain('line 2: ``` Yesterday')
    expect(history.match(/^`{4}$/gm)).toHaveLength(2)
    expect(message).toMatch(/\d+ more flagged lines not shown/)
  })

  it('renders original HISTORY losslessly with visible control and format escapes', () => {
    const text = 'Yesterday\u001b[2J\u0000\r\u200b\ufeff\u0085\u{e0001}\t```'
    const source = addedLines({ tool: 'Write', input: { content: text } })
    const message = renderNarrativeMessage({ lines: source, findings: detectNarrative(source), result: { ok: false, reason: 'test' } })
    expect(message.split('HISTORY —')[0]).not.toContain('\r')
    expect(message.split('HISTORY —')[1]?.split('RULE —')[0]).toContain('line 1: Yesterday\\u001b[2J\\u0000\\r\\u200b\\ufeff\\u0085\\u{e0001}\t```')
    expect(message.replaceAll('\n', '').replaceAll('\t', '')).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    expect(message.split('HISTORY —')[1]?.split('RULE —')[0]?.match(/^`{4}$/gm)).toHaveLength(2)
  })

  it('opens warnings and denials differently and names the target file', () => {
    const file = 'rules/retry.md'
    const args = { findings, lines, result: { ok: false, reason: 'test' }, file }
    const warn = renderNarrativeMessage({ ...args, deny: false })
    const deny = renderNarrativeMessage({ ...args, deny: true })
    expect(warn).toMatch(/^The write went through \(warning only\)\. The flagged lines below are now in rules\/retry.md\. Edit them out of the file and move them to a card comment or a memory fiche\./)
    expect(deny).toMatch(/^The write to rules\/retry.md was refused\./)
    expect(deny).toContain('Retry the write with the RULE wording in place of those lines.')
    expect(deny).not.toContain('The write went through')
    expect(warn).not.toContain('was refused')
  })
})

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error The plugin's standalone executable has no declaration surface.
import { runVerifier } from '../../../../plugin/bin/wt-opencode-verify.mjs'

const ROOT = path.join(__dirname, '..', '..', '..', '..')
const ENTRY = path.join(ROOT, 'plugin/bin/wt-opencode-verify.mjs')
function childResult({ stdout = '', stderr = '', code = 0, hangs = false }: { stdout?: string; stderr?: string; code?: number; hangs?: boolean }) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn(() => process.nextTick(() => child.emit('close', null, 'SIGKILL')))
  if (!hangs) {
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', stdout)
      if (stderr) child.stderr.emit('data', stderr)
      child.emit('close', code, null)
    })
  }
  return child
}

describe('wt-opencode-verify', () => {
  it('parses stable command arguments and builds the exact read-only opencode argv', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wt-opencode-verify-'))
    const source = path.join(dir, 'task.md')
    const binDir = path.join(dir, 'bin')
    const calls = path.join(dir, 'calls.json')
    writeFileSync(source, 'review this')
    try {
      mkdirSync(binDir)
      writeFileSync(path.join(binDir, 'opencode'), `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2); if(args[0]==='--version') { console.log('fixture-1'); process.exit(0) }; if(args[0]==='--pure') { console.log('[]'); process.exit(0) }; if(args[0]==='providers') process.exit(0); fs.writeFileSync(process.env.CALLS, JSON.stringify(args)); fs.writeFileSync(process.env.FENCE, process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS); process.stdout.write('{"part":{"type":"text","text":"VERDICT"}}\\n')\n`)
      chmodSync(path.join(binDir, 'opencode'), 0o755)
      const result = spawnSync('node', [ENTRY, '--dir', dir, '--id', 'vote-123', '-m', 'openai/gpt-5.6-terra', '--fallback-model', 'openai/gpt-5.6-luna', '--variant', 'max', '--task-file', source], { encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CALLS: calls, FENCE: path.join(dir, 'fence'), XDG_STATE_HOME: path.join(dir, 'state'), OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'false' } })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('VERDICT')
      expect(readFileSync(path.join(dir, 'fence'), 'utf8')).toBe('true')
      const argv = JSON.parse(readFileSync(calls, 'utf8'))
      expect(argv.slice(0, -1)).toEqual(['run', 'Follow the instructions in the attached file and output ONLY what it asks for (e.g. the verdict JSON). Do not add commentary.', '--agent', 'plan', '--model', 'openai/gpt-5.6-terra', '--variant', 'max', '--dir', dir, '--format', 'json', '-f'])
      expect(argv.at(-1)).toMatch(new RegExp(`^${dir}/\\.oc-verify-vote-123-\\d+\\.md$`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a successful run that denied an external-directory read', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wt-opencode-verify-'))
    const source = path.join(dir, 'task.md')
    const binDir = path.join(dir, 'bin')
    writeFileSync(source, 'review this')
    try {
      mkdirSync(binDir)
      writeFileSync(path.join(binDir, 'opencode'), `#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args[0]==='--version') { console.log('fixture-1'); process.exit(0) }; if(args[0]==='--pure') { console.log('[]'); process.exit(0) }; if(args[0]==='providers') process.exit(0); process.stdout.write('ungrounded verdict'); process.stderr.write('permission.external_directory auto-rejecting');\n`)
      chmodSync(path.join(binDir, 'opencode'), 0o755)
      const result = spawnSync('node', [ENTRY, '--dir', dir, '--id', 'denied-read', '--task-file', source], { encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('OPENCODE_EXTERNAL_DIRECTORY: permission.external_directory auto-rejecting')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('owns copied stdin task cleanup and keeps the child stdin closed', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wt-opencode-verify-'))
    const spawnFn = vi.fn(() => childResult({ stdout: '{"part":{"type":"text","text":"VERDICT"}}\n' }))
    try {
      await expect(runVerifier({ dir, id: 'stdin', stdin: true, taskFile: null, model: 'primary', fallbackModel: null, variant: null }, {
        binary: 'opencode', providerAuthenticated: () => true, skillFenceVerifier: () => ({ ok: true }), readStdin: () => 'review from stdin', spawnFn,
      })).resolves.toEqual({ code: 0, output: 'VERDICT' })
      const [, args, options] = spawnFn.mock.calls[0]! as unknown as [string, string[], { stdio: string[] }]
      expect(options.stdio[0]).toBe('ignore')
      expect(() => readFileSync(args.at(-1)!, 'utf8')).toThrow()
      expect(args.at(-1)).toMatch(/\.oc-verify-stdin-\d+\.md$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('terminates a timed-out child and cleans up its task copy', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wt-opencode-verify-'))
    const child = childResult({ hangs: true })
    try {
      await expect(runVerifier({ dir, id: 'timeout', stdin: true, taskFile: null, model: 'primary', fallbackModel: null, variant: null }, {
        binary: 'opencode', providerAuthenticated: () => true, skillFenceVerifier: () => ({ ok: true }), readStdin: () => 'review from stdin', spawnFn: () => child, timeoutSec: 0,
      })).resolves.toEqual({ code: 124, output: 'opencode exited 124' })
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('retries one 429 with the fallback model and preserves the variant', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wt-opencode-verify-'))
    const spawnFn = vi.fn()
    spawnFn.mockImplementationOnce(() => childResult({ stderr: '429 rate limit', code: 1 }))
    spawnFn.mockImplementationOnce(() => childResult({ stdout: '{"part":{"type":"text","text":"FALLBACK"}}\n' }))
    try {
      await expect(runVerifier({ dir, id: 'retry', stdin: true, taskFile: null, model: 'primary', fallbackModel: 'fallback', variant: 'high' }, {
        binary: 'opencode', providerAuthenticated: () => true, skillFenceVerifier: () => ({ ok: true }), readStdin: () => 'review from stdin', spawnFn,
      })).resolves.toEqual({ code: 0, output: 'FALLBACK' })
      expect(spawnFn).toHaveBeenCalledTimes(2)
      expect(spawnFn.mock.calls[1]![1]).toContain('--model')
      expect(spawnFn.mock.calls[1]![1]).toContain('fallback')
      expect(spawnFn.mock.calls[1]![1]).toContain('--variant')
      expect(spawnFn.mock.calls[1]![1]).toContain('high')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import { effectiveSkillDiscoveryRefusal, opencodeChildEnv, pruneOpencodeSkillFenceCache, spawnOpencode, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from '../../../../plugin/bin/lib/opencode-skill-fence.mjs'

const FENCE_MODULE = new URL('../../../../plugin/bin/lib/opencode-skill-fence.mjs', import.meta.url).href

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function stub(mode: 'honor' | 'ignore' | 'invisible-allow') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wt-skill-fence-')); roots.push(root)
  const bin = path.join(root, process.platform === 'win32' ? 'opencode.cmd' : 'opencode')
  const calls = path.join(root, 'calls')
  if (process.platform === 'win32') {
    const script = path.join(root, 'opencode.mjs')
    writeFileSync(script, `
import { appendFileSync } from 'node:fs'
if (process.argv[2] === '--version') { console.log('1.2.3'); process.exit(0) }
appendFileSync(${JSON.stringify(calls)}, 'probe\\n')
console.log(${JSON.stringify(mode === 'ignore' ? '[{"name":"workflow-toolbox-fence-sentinel"}]' : mode === 'invisible-allow' ? '[]' : '[{"name":"workflow-toolbox-allowed-sentinel"}]')})
`)
    writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  } else {
    writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.2.3\\n'; exit 0; fi
printf 'probe\\n' >> ${JSON.stringify(calls)}
if [ ${JSON.stringify(mode)} = ignore ]; then printf '[{"name":"workflow-toolbox-fence-sentinel"}]\\n'; elif [ ${JSON.stringify(mode)} = invisible-allow ]; then printf '[]\\n'; else printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\\n'; fi
`)
    chmodSync(bin, 0o755)
  }
  return { root, bin, calls, stateDir: path.join(root, 'state') }
}

function pruneWorker(stateDir: string, events: string) {
  const source = `
    import fs from 'node:fs'
    import path from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const [stateDir, events] = process.argv.slice(1)
    const remove = fs.rmSync
    let delayed = false
    fs.rmSync = (file, options) => {
      if (!delayed && /^[a-f0-9]{64}\\.json$/.test(path.basename(String(file)))) {
        delayed = true
        fs.appendFileSync(events, 'prune-start\\n')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
        const result = remove(file, options)
        fs.appendFileSync(events, 'prune-end\\n')
        return result
      }
      return remove(file, options)
    }
    syncBuiltinESMExports()
    const { pruneOpencodeSkillFenceCache } = await import(${JSON.stringify(FENCE_MODULE)})
    pruneOpencodeSkillFenceCache({ stateDir, maxEntries: 64 })
  `
  return spawn(process.execPath, ['--input-type=module', '-e', source, stateDir, events], { stdio: 'inherit' })
}

function publishWorker(bin: string, stateDir: string, events: string) {
  const source = `
    import fs from 'node:fs'
    import path from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const [bin, stateDir, events] = process.argv.slice(1)
    const rename = fs.renameSync
    fs.renameSync = (from, to) => {
      const result = rename(from, to)
      if (/^[a-f0-9]{64}\\.json$/.test(path.basename(String(to)))) fs.appendFileSync(events, 'publish\\n')
      return result
    }
    syncBuiltinESMExports()
    const { verifyOpencodeSkillFence } = await import(${JSON.stringify(FENCE_MODULE)})
    if (!verifyOpencodeSkillFence(bin, { stateDir }).ok) process.exitCode = 1
  `
  return spawn(process.execPath, ['--input-type=module', '-e', source, bin, stateDir, events], { stdio: 'inherit' })
}

function exited(child: ReturnType<typeof spawn>) {
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (readFileSync(file, { encoding: 'utf8', flag: 'a+' }).includes('prune-start')) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${file}`)
}

describe('OpenCode Claude-skill fence', () => {
  it('forces true after an inherited false value', () => {
    expect(opencodeChildEnv({ OPENCODE_CONFIG: '/unsafe.json', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'false', KEEP: 'yes' })).toMatchObject({
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true', KEEP: 'yes',
    })
    expect(opencodeChildEnv({ OPENCODE_CONFIG: '/unsafe.json' })).not.toHaveProperty('OPENCODE_CONFIG')
  })

  it('uses uncached effective discovery with the exact cwd, environment, and non-pure flags', () => {
    const calls: unknown[][] = []
    const spawnSyncFn = (...args: unknown[]) => {
      calls.push(args)
      return { status: 0, stdout: '[{"name":"allowed","location":"/allowed/SKILL.md"}]', stderr: '' }
    }
    const env = { MARKER: 'same' }
    expect(verifyEffectiveOpencodeSkillDiscovery('/bin/opencode', { cwd: '/lane', env, spawnSyncFn })).toMatchObject({ ok: true })
    expect(verifyEffectiveOpencodeSkillDiscovery('/bin/opencode', { cwd: '/lane', env, spawnSyncFn })).toMatchObject({ ok: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[1]).toEqual(['debug', 'skill'])
    expect(calls[0]?.[2]).toMatchObject({ cwd: '/lane', env })
  })

  it('refuses every discovered single-writer name with its reported location', () => {
    const stdout = JSON.stringify([
      { name: 'save-memory', location: '/one/SKILL.md' },
      { name: 'planka-tracking', location: '/two/SKILL.md' },
      { name: 'what-next', location: '/three/SKILL.md' },
    ])
    const result = verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => ({ status: 0, stdout, stderr: '' }) })
    expect(result).toMatchObject({ ok: false, refused: expect.arrayContaining([expect.objectContaining({ name: 'save-memory', location: '/one/SKILL.md' })]) })
    expect(effectiveSkillDiscoveryRefusal(result)).toBe('wt-lane: Refused: effective OpenCode skill discovery found save-memory at /one/SKILL.md, planka-tracking at /two/SKILL.md, what-next at /three/SKILL.md; refusing to launch.')
  })

  it.each(['Save-Memory', 'save_memory', 'SAVE-MEMORY'])('refuses the OpenCode-visible %s identity variant', (name) => {
    const stdout = JSON.stringify([{ name, location: `/lane/${name}/SKILL.md` }])
    expect(verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => ({ status: 0, stdout, stderr: '' }) })).toMatchObject({
      ok: false,
      refused: [{ name }],
    })
  })

  it('fails closed when effective discovery fails or returns invalid JSON', () => {
    expect(verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => ({ status: 1, stdout: '', stderr: 'bad' }) })).toMatchObject({ ok: false, reason: expect.stringContaining('failed') })
    expect(verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => ({ status: 0, stdout: 'nope', stderr: '' }) })).toMatchObject({ ok: false, reason: expect.stringContaining('invalid JSON') })
    expect(verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => ({ status: 0, stdout: '{}', stderr: '' }) })).toMatchObject({ ok: false, reason: expect.stringContaining('unexpected shape') })
    expect(verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => { throw 'string failure' } })).toMatchObject({ ok: false, reason: expect.stringContaining('string failure') })
    expect(verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: '/lane', env: {}, spawnSyncFn: () => ({ status: 0, stdout: '[{"name":"save-memory"}]', stderr: '' }) })).toMatchObject({ ok: false, refused: [{ name: 'save-memory', location: '<unknown location>' }] })
  })

  it('keeps the missing-binary discovery refusal legible', () => {
    const missing = Object.assign(new Error('spawnSync opencode ENOENT'), { code: 'ENOENT' })
    const result = verifyEffectiveOpencodeSkillDiscovery('opencode', {
      cwd: '/lane', env: {}, spawnSyncFn: () => ({ error: missing, status: null, stdout: '', stderr: '' }),
    })

    expect(effectiveSkillDiscoveryRefusal(result)).toBe('wt-lane: Refused: effective OpenCode skill discovery failed (spawnSync opencode ENOENT); refusing to launch.')
  })

  it('does not report a verified fence when bare-binary discovery itself fails', () => {
    const f = stub('honor')
    const discoveryError = Object.assign(new Error('simulated lookup I/O failure'), { code: 'EIO' })
    const result = verifyOpencodeSkillFence('opencode', {
      env: { ...process.env, PATH: f.root },
      stateDir: f.stateDir,
      platform: process.platform,
      accessSyncFn: () => { throw discoveryError },
      statSyncFn: () => { throw discoveryError },
    })

    expect(result).toMatchObject({ ok: false, allowOk: false, unavailable: true, reason: expect.stringContaining('simulated lookup I/O failure') })
  })

  it('keeps an exhaustive bare-binary miss distinct from unavailable discovery', () => {
    const missing = Object.assign(new Error('not found'), { code: 'ENOENT' })
    expect(verifyOpencodeSkillFence('opencode', {
      env: { PATH: '/nowhere' },
      accessSyncFn: () => { throw missing },
    })).toMatchObject({ ok: true, allowOk: true, missing: true })
  })

  it('splits a Windows-shaped PATH with the caller platform and reports a clean miss', () => {
    const missing = Object.assign(new Error('not found'), { code: 'ENOENT' })
    const result = verifyOpencodeSkillFence('opencode', {
      env: { PATH: 'C:\\a;C:\\b', PATHEXT: '.CMD' },
      platform: 'win32',
      statSyncFn: () => { throw missing },
    })

    expect(result).toMatchObject({ ok: true, allowOk: true, missing: true })
    expect(result).not.toHaveProperty('reason')
  })

  it('quotes and cmd-spawns a resolved Windows command shim', () => {
    const f = stub('honor')
    const missing = Object.assign(new Error('not found'), { code: 'ENOENT' })
    const binary = 'C:\\Program Files\\nodejs\\opencode.CMD'
    let versionCommand = ''
    spawnOpencode((_command: string, args: string[]) => { versionCommand = args[3]! }, binary, ['--version'], undefined, 'win32')
    const spawnSyncFn = (command: string, args: string[], options: Record<string, unknown>) => {
      expect(command).toBe(process.env.ComSpec || 'cmd.exe')
      expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      expect(args[3]).toContain('C:\\Program^ Files\\nodejs\\opencode.CMD ')
      expect(args[3]).toMatch(/^".*"$/)
      expect(options).toMatchObject({ windowsVerbatimArguments: true })
      expect(options).not.toHaveProperty('shell')
      return args[3] === versionCommand
        ? { status: 0, stdout: '1.2.3\n', stderr: '' }
        : { status: 0, stdout: '[{"name":"workflow-toolbox-allowed-sentinel"}]', stderr: '' }
    }
    const result = verifyOpencodeSkillFence('opencode', {
      env: { PATH: 'C:\\Program Files\\nodejs;C:\\other', PATHEXT: '.CMD' },
      stateDir: f.stateDir,
      platform: 'win32',
      statSyncFn: (candidate: string) => {
        if (candidate !== binary) throw missing
        return { isFile: () => true }
      },
      realpathSyncFn: (candidate: string) => candidate,
      spawnSyncFn,
    })

    expect(result, result.reason).toMatchObject({ ok: true, allowOk: true, binary })
  })

  it('uses the configured Windows command processor for a zero-argument shim', () => {
    const previous = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    try {
      const spawnSyncFn = (command: string, args: string[], options: Record<string, unknown>) => {
        expect(command).toBe(process.env.ComSpec)
        expect(args).toEqual(['/d', '/s', '/c', '"C:\\tools\\opencode.cmd"'])
        expect(options).toEqual({ windowsVerbatimArguments: true })
        return { status: 0 }
      }

      expect(spawnOpencode(spawnSyncFn, 'C:\\tools\\opencode.cmd', [], undefined, 'win32')).toEqual({ status: 0 })
    } finally {
      if (previous === undefined) delete process.env.ComSpec
      else process.env.ComSpec = previous
    }
  })

  function windowsShimFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt cmd argv ')); roots.push(root)
    const script = path.join(root, 'x.mjs')
    const bin = path.join(root, 'opencode.cmd')
    const record = path.join(root, 'argv.json')
    const expected = ['run', '--dir', path.join(root, 'lane %PATH% ^ caret'), '--model', 'provider/model']
    writeFileSync(script, `import { writeFileSync } from 'node:fs'\nconst args = process.argv.slice(2)\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify(args))\nprocess.stdout.write('shim stdout:' + JSON.stringify(args) + '\\n')\nprocess.exitCode = 3\n`)
    writeFileSync(bin, `@echo off\r\n@"${process.execPath}" "%~dp0x.mjs" %*\r\n@exit /b %errorlevel%\r\n`)
    return { root, bin, record, expected }
  }

  function spawnDetails(result: { status?: number | null, signal?: NodeJS.Signals | null, stdout?: unknown, stderr?: unknown }, elapsedMs: number) {
    return `status=${String(result.status)} signal=${String(result.signal)} stdout=${JSON.stringify(String(result.stdout ?? ''))} stderr=${JSON.stringify(String(result.stderr ?? ''))} elapsed=${elapsedMs}ms`
  }

  it.runIf(process.platform === 'win32')('passes stdout, argv, and exit /b 3 through spawnSync and a real Windows command shim', () => {
    const { bin, record, expected } = windowsShimFixture()
    const started = Date.now()
    const result = spawnOpencode(spawnSync, bin, expected, { encoding: 'utf8' }, 'win32')
    const details = spawnDetails(result, Date.now() - started)

    expect(result.status, details).toBe(3)
    expect(result.stdout, details).toContain(`shim stdout:${JSON.stringify(expected)}`)
    expect(existsSync(record), details).toBe(true)
    expect(JSON.parse(readFileSync(record, 'utf8')), details).toEqual(expected)
  })

  it('keeps the envelope detached only where process-group signaling preserves piped output', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../../plugin/bin/wt-opencode-envelope.mjs', import.meta.url)), 'utf8')
    expect(source).toContain("...(process.platform === 'win32' ? {} : { detached: true })")
    expect(source).toContain("'System32', 'taskkill.exe'")
    expect(source).toContain("['/PID', String(pid), '/T', '/F']")
  })

  it.runIf(process.platform === 'win32')('locks the Windows detached command-shim defect: exit survives but piped stdout is empty', async () => {
    const { bin, record, expected } = windowsShimFixture()
    const started = Date.now()
    const child = spawnOpencode(spawn, bin, expected, { stdio: ['ignore', 'pipe', 'pipe'], detached: true }, 'win32')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk) })
    const result = await new Promise<{ status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(spawnDetails({ status: child.exitCode, signal: child.signalCode, stdout, stderr }, Date.now() - started)))
      }, 5_000)
      child.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(new Error(`${error.message}; ${spawnDetails({ status: child.exitCode, signal: child.signalCode, stdout, stderr }, Date.now() - started)}`))
      })
      child.once('close', (status: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer)
        resolve({ status, signal, stdout, stderr })
      })
    })
    const elapsedMs = Date.now() - started
    const details = spawnDetails(result, elapsedMs)

    expect(result.status, details).toBe(3)
    expect(result.stdout, details).toBe('')
    expect(existsSync(record), details).toBe(true)
    expect(JSON.parse(readFileSync(record, 'utf8')), details).toEqual(expected)
    expect(elapsedMs, details).toBeLessThan(5_000)
  }, 10_000)

  it.runIf(process.platform === 'win32')('passes output and exit code through the launcher file-descriptor spawn shape', async () => {
    const { root, bin, record, expected } = windowsShimFixture()
    const output = path.join(root, 'child.log')
    const fd = openSync(output, 'a')
    const started = Date.now()
    let child: ReturnType<typeof spawn>
    try {
      child = spawnOpencode(spawn, bin, expected, { stdio: ['ignore', fd, fd] }, 'win32')
    } finally {
      closeSync(fd)
    }
    const result = await new Promise<{ status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        const text = readFileSync(output, 'utf8')
        reject(new Error(spawnDetails({ status: child.exitCode, signal: child.signalCode, stdout: text, stderr: text }, Date.now() - started)))
      }, 5_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        const text = readFileSync(output, 'utf8')
        reject(new Error(`${error.message}; ${spawnDetails({ status: child.exitCode, signal: child.signalCode, stdout: text, stderr: text }, Date.now() - started)}`))
      })
      child.once('close', (status, signal) => {
        clearTimeout(timer)
        const text = readFileSync(output, 'utf8')
        resolve({ status, signal, stdout: text, stderr: text })
      })
    })
    const details = spawnDetails(result, Date.now() - started)

    expect(result.status, details).toBe(3)
    expect(result.stdout, details).toContain(`shim stdout:${JSON.stringify(expected)}`)
    expect(existsSync(record), details).toBe(true)
    expect(JSON.parse(readFileSync(record, 'utf8')), details).toEqual(expected)
  }, 10_000)

  it('resolves a bare Windows executable through Path and PATHEXT', () => {
    const f = stub('honor')
    const calls: string[] = []
    const missing = Object.assign(new Error('not found'), { code: 'ENOENT' })
    const binary = 'C:\\tools\\opencode.EXE'
    const spawnSyncFn = (command: string, args: string[]) => {
      expect(command).toBe(binary)
      return args[0] === '--version'
        ? { status: 0, stdout: '1.2.3\n', stderr: '' }
        : { status: 0, stdout: '[{"name":"workflow-toolbox-allowed-sentinel"}]', stderr: '' }
    }
    const result = verifyOpencodeSkillFence('opencode', {
      env: { Path: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
      stateDir: f.stateDir,
      platform: 'win32',
      statSyncFn: (candidate: string) => {
        calls.push(candidate)
        if (candidate !== binary) throw missing
        return { isFile: () => true }
      },
      realpathSyncFn: (candidate: string) => candidate,
      spawnSyncFn,
    })

    expect(calls).toEqual([binary])
    expect(result).toMatchObject({ ok: true, allowOk: true, binary })
  })

  it('refuses a binary that still lists the synthetic Claude skill', () => {
    const f = stub('ignore')
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: false, reason: expect.stringContaining('still listed') })
  })

  it('accepts an honoring binary and skips the probe on a cache hit', () => {
    const f = stub('honor')
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: false })
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: true })
    expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toEqual(['probe'])
  })

  it('refuses a binary that cannot expose the materialised allowed skill', () => {
    const f = stub('invisible-allow')
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, allowOk: false, allowReason: expect.stringContaining('allow-list half') })
  })

  it('does not treat a pre-allow-list cache entry as a hit', () => {
    const f = stub('honor')
    const oldKey = crypto.createHash('sha256').update(`${realpathSync(f.bin)}\0${'1.2.3'}\0opencode-config-skills-paths\0allow-list-v1`).digest('hex')
    // The legacy entry is deliberately stored under the old contract key.
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: false })
    for (const name of readdirSync(f.stateDir)) if (/^[a-f0-9]{64}\.json$/.test(name)) rmSync(path.join(f.stateDir, name))
    writeFileSync(path.join(f.stateDir, oldKey + '.json'), JSON.stringify({ ok: true, binary: realpathSync(f.bin), version: '1.2.3' }))
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, allowOk: true, cached: false })
  })

  it('retains only the newest 64 capability results when writing a cache miss', () => {
    const f = stub('honor')
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: false })
    const currentKey = crypto.createHash('sha256').update(`${realpathSync(f.bin)}\0${'1.2.3'}\0opencode-config-skills-paths\0allow-list-v2-two-half`).digest('hex')
    rmSync(path.join(f.stateDir, currentKey + '.json'))
    for (let index = 0; index < 80; index += 1) {
      const file = path.join(f.stateDir, `${index.toString(16).padStart(64, '0')}.json`)
      writeFileSync(file, '{}')
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index))
      utimesSync(file, timestamp, timestamp)
    }
    writeFileSync(path.join(f.stateDir, 'keep.txt'), 'not a fence cache entry')

    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: false })

    const cacheFiles = readdirSync(f.stateDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    expect(cacheFiles).toHaveLength(64)
    expect(cacheFiles).not.toContain(`${'0'.repeat(64)}.json`)
    expect(cacheFiles).toContain(`${(79).toString(16).padStart(64, '0')}.json`)
    expect(readFileSync(path.join(f.stateDir, 'keep.txt'), 'utf8')).toBe('not a fence cache entry')
  })

  it('serializes cache-miss publication against pruning across processes', async () => {
    const f = stub('honor')
    const events = path.join(f.root, 'events')
    expect(verifyOpencodeSkillFence(f.bin, { stateDir: f.stateDir })).toMatchObject({ ok: true, cached: false })
    for (const name of readdirSync(f.stateDir)) if (/^[a-f0-9]{64}\.json$/.test(name)) rmSync(path.join(f.stateDir, name))
    for (let index = 0; index < 80; index += 1) writeFileSync(path.join(f.stateDir, `${index.toString(16).padStart(64, '0')}.json`), '{}')

    const pruner = pruneWorker(f.stateDir, events)
    await waitForFile(events)
    const publisher = publishWorker(f.bin, f.stateDir, events)

    expect(await Promise.all([exited(pruner), exited(publisher)])).toEqual([0, 0])
    expect(readFileSync(events, 'utf8').trim().split('\n')).toEqual(['prune-start', 'prune-end', 'publish'])
  })

  it('refuses to prune an unmarked directory and leaves an unrelated lock tree intact', () => {
    const f = stub('honor')
    const nested = path.join(f.stateDir, '.retention.lock', 'unrelated', 'data')
    mkdirSync(path.dirname(nested), { recursive: true })
    writeFileSync(nested, 'keep')

    expect(() => pruneOpencodeSkillFenceCache({ stateDir: f.stateDir })).toThrow(/refusing unowned/)
    expect(readFileSync(nested, 'utf8')).toBe('keep')
  })
})

import { spawn } from 'node:child_process'
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error shipped JavaScript module outside the TypeScript package
import { scrubPromptStorage } from '../../../../plugins/wt-secret-guard/hooks/prompt-storage-host.js'

const PLUGIN_ROOT = resolve(import.meta.dirname, '../../../../plugins/wt-secret-guard')
const POSIX_RANGE = join(PLUGIN_ROOT, 'hooks', 'prompt-storage-range.mjs')
const JOURNAL_APPEND = join(PLUGIN_ROOT, 'hooks', 'journal-append.mjs')
const roots: string[] = []

type RunResult = { status: number | null, stdout: string, stderr: string }

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(tag: string) {
  const root = await mkdtemp(join(tmpdir(), `wt-secret-guard-${tag}-`))
  roots.push(root)
  return root
}

function run(argv: string[], input = '', cwd?: string): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const [command, ...args] = argv
    if (!command) throw new Error('native helper command is empty')
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (status) => resolveRun({ status, stdout, stderr }))
    child.stdin.end(input)
  })
}

async function posixWrite(path: string, offset: number, expected: Buffer, replacement: Buffer, inode?: bigint | number, record?: { length: number, toolUseId: string }) {
  const identity = await stat(path, { bigint: true })
  const prefix = (await readFile(path)).subarray(0, Math.min(64, Number(identity.size)))
  return run(
    [process.execPath, POSIX_RANGE, path, String(offset), String(expected.length), String(inode ?? identity.ino), 'write'],
    JSON.stringify({
      expected: expected.toString('base64'),
      replacement: replacement.toString('base64'),
      size: Number(identity.size),
      prefix: prefix.toString('base64'),
      recordOffset: record ? 0 : undefined,
      recordLength: record?.length,
      toolUseId: record?.toolUseId,
    }),
  )
}

async function journal(path: string, text: string) {
  return run([process.execPath, JOURNAL_APPEND, path], text)
}

describe.skipIf(process.platform === 'win32')('POSIX native prompt-storage range helper [requires POSIX inode semantics]', () => {
  it('replaces exact bytes after multi-byte UTF-8 in a file larger than 4 MiB without replacing the file', async () => {
    const root = await fixture('range')
    const path = join(root, 'prompt.jsonl')
    const before = Buffer.alloc(4 * 1024 * 1024 + 257, 97)
    const lead = Buffer.from('prefix-\u20ac-')
    const expected = Buffer.from('raw-secret')
    const replacement = Buffer.from('safe-token')
    lead.copy(before)
    const offset = lead.length + 91
    expected.copy(before, offset)
    await writeFile(path, before)
    const identity = await stat(path, { bigint: true })

    const result = await posixWrite(path, offset, expected, replacement)
    const after = await readFile(path)
    const finalIdentity = await stat(path, { bigint: true })

    expect(result, result.stderr).toMatchObject({ status: 0 })
    expect(after.subarray(offset, offset + replacement.length)).toEqual(replacement)
    expect(after.subarray(0, offset)).toEqual(before.subarray(0, offset))
    expect(after.subarray(offset + expected.length)).toEqual(before.subarray(offset + expected.length))
    expect(finalIdentity.size).toBe(identity.size)
    expect(finalIdentity.ino).toBe(identity.ino)
  })

  it('refuses an expected-bytes mismatch without writing', async () => {
    const root = await fixture('mismatch')
    const path = join(root, 'prompt.jsonl')
    const before = Buffer.from('prefix actual suffix')
    await writeFile(path, before)

    const result = await posixWrite(path, 7, Buffer.from('wanted'), Buffer.from('masked'))

    expect(result.status).not.toBe(0)
    expect(await readFile(path)).toEqual(before)
  })

  it('refuses a replacement file by inode without writing to it', async () => {
    const root = await fixture('identity')
    const path = join(root, 'prompt.jsonl')
    const retired = join(root, 'retired.jsonl')
    const before = Buffer.from('prefix secret suffix')
    await writeFile(path, before)
    const identity = await stat(path, { bigint: true })
    await rename(path, retired)
    await writeFile(path, before)

    const result = await posixWrite(path, 7, Buffer.from('secret'), Buffer.from('masked'), identity.ino)

    expect(result.status).not.toBe(0)
    expect(await readFile(path)).toEqual(before)
  })

  it('refuses a same-size same-prefix JSONL record carrying a different tool_use id', async () => {
    const root = await fixture('record-identity')
    const path = join(root, 'prompt.jsonl')
    const raw = `ghp_${'n'.repeat(36)}`
    const targetId = 'tool-no-inode-original'
    const replacementId = 'tool-no-inode-otherxxx'
    const original = Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: targetId, input: { command: raw } }] } })}\n`)
    const changed = Buffer.from(original.toString().replace(targetId, replacementId))
    const offset = original.indexOf(raw)
    await writeFile(path, changed)
    expect(changed.length).toBe(original.length)
    expect(changed.subarray(0, 64)).toEqual(original.subarray(0, 64))

    const result = await posixWrite(path, offset, Buffer.from(raw), Buffer.alloc(Buffer.byteLength(raw), 42), undefined, { length: changed.length - 1, toolUseId: targetId })

    expect(result.status).not.toBe(0)
    expect(await readFile(path)).toEqual(changed)
  })

  it('never loses an append racing the range operation', async () => {
    const root = await fixture('append-race')
    const path = join(root, 'prompt.jsonl')
    const expected = Buffer.from('secret')
    const replacement = Buffer.from('masked')
    const marker = Buffer.from('\nconcurrent-append')
    const before = Buffer.concat([Buffer.alloc(1024 * 1024, 97), expected])
    await writeFile(path, before)

    const [write] = await Promise.all([
      posixWrite(path, before.length - expected.length, expected, replacement),
      appendFile(path, marker),
    ])
    const after = await readFile(path)

    expect([0, 6]).toContain(write.status)
    expect(after.subarray(-marker.length)).toEqual(marker)
    expect([
      expected.toString('hex'),
      replacement.toString('hex'),
    ]).toContain(after.subarray(before.length - expected.length, before.length).toString('hex'))
  })
})

type WriteInterception = (path: string) => Promise<void>

async function windowsScrub(config: string, raw: string, token: string, beforeWrite?: WriteInterception) {
  let intercepted = false
  return scrubPromptStorage({
    configDir: async () => config,
    home: async () => undefined,
    sessionCwd: async () => 'native-helper-test',
    sessionId: async () => 'session',
    isWindows: async () => true,
    pluginRoot: async () => PLUGIN_ROOT,
    fsStat: (path: string) => stat(path),
    sleep: async () => {},
    uiLog: async () => {},
    processRun: async (argv: string[], init?: { stdin?: string }) => {
      const path = argv[5]
      if (!path) throw new Error('Windows range helper argv omitted its path')
      if (!intercepted && argv.includes('write') && beforeWrite) {
        intercepted = true
        await beforeWrite(path)
      }
      const result = await run(argv, init?.stdin, config)
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
    },
  }, [{ raw, token }])
}

describe.skipIf(process.platform !== 'win32')('Windows native prompt-storage range helper [requires native Windows PowerShell]', () => {
  it('refuses a same-size same-prefix JSONL record carrying a different tool_use id', async () => {
    const config = await fixture('windows-record-identity')
    const path = join(config, 'history.jsonl')
    const raw = `ghp_${'n'.repeat(36)}`
    const targetId = 'tool-no-inode-original'
    const replacementId = 'tool-no-inode-otherxxx'
    const original = Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: targetId, input: { command: raw } }] } })}\n`)
    const changed = Buffer.from(original.toString().replace(targetId, replacementId))
    const offset = original.indexOf(raw)
    await writeFile(path, changed)
    const result = await run([
      'powershell.exe', '-NoProfile', '-NonInteractive', '-File', join(PLUGIN_ROOT, 'hooks', 'prompt-storage-range.ps1'),
      path, String(offset), String(Buffer.byteLength(raw)), 'write', Buffer.alloc(Buffer.byteLength(raw), 42).toString('base64'),
      Buffer.from(raw).toString('base64'), String(changed.length), changed.subarray(0, 64).toString('base64'), '0', String(changed.length - 1), targetId,
    ])

    expect(result.status).not.toBe(0)
    expect(await readFile(path)).toEqual(changed)
  })

  it('uses the host argv builder for an exact in-place write on a large UTF-8 file and treats punctuation as data', async () => {
    const parent = await fixture('windows-native')
    const config = join(parent, 'config with spaces;New-Item injected;#')
    await mkdir(config)
    const path = join(config, 'history.jsonl')
    const raw = 'raw-\u20ac-secret'
    const padding = 'a'.repeat(4 * 1024 * 1024 + 73)
    const before = Buffer.from(`${JSON.stringify({ display: padding })}\n${JSON.stringify({ display: `lead-\u20ac-${raw}-tail` })}\n`)
    await writeFile(path, before)
    const identity = await stat(path, { bigint: true })

    expect(await windowsScrub(config, raw, 'safe-token')).toBe(true)
    const after = await readFile(path)
    const finalIdentity = await stat(path, { bigint: true })
    const offset = before.indexOf(Buffer.from(raw))

    expect(after.length).toBe(before.length)
    expect(after.subarray(0, offset)).toEqual(before.subarray(0, offset))
    expect(after.subarray(offset + Buffer.byteLength(raw))).toEqual(before.subarray(offset + Buffer.byteLength(raw)))
    expect(after.subarray(offset, offset + Buffer.byteLength(raw)).toString()).not.toBe(raw)
    expect(finalIdentity.ino).toBe(identity.ino)
    await expect(access(join(config, 'injected'))).rejects.toThrow()
  })

  it('refuses an expected-bytes mismatch without overwriting the changed bytes', async () => {
    const config = await fixture('windows-mismatch')
    const path = join(config, 'history.jsonl')
    const raw = 'raw-secret'
    const changed = 'new-secret'
    await writeFile(path, `${JSON.stringify({ display: raw })}\n`)

    expect(await windowsScrub(config, raw, 'safe-token', async () => {
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace(raw, changed))
    })).toBe(false)
    expect(await readFile(path, 'utf8')).toContain(changed)
  })

  it('refuses a replaced file without writing to the new identity', async () => {
    const config = await fixture('windows-identity')
    const path = join(config, 'history.jsonl')
    const retired = join(config, 'retired.jsonl')
    const raw = 'raw-secret'
    const replacementFile = `${JSON.stringify({ display: 'new-secret' })}\n`
    await writeFile(path, `${JSON.stringify({ display: raw })}\n`)

    expect(await windowsScrub(config, raw, 'safe-token', async () => {
      await rename(path, retired)
      await writeFile(path, replacementFile)
    })).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(replacementFile)
  })

  it('preserves an append that lands between the host check and PowerShell write', async () => {
    const config = await fixture('windows-append')
    const path = join(config, 'history.jsonl')
    const marker = `${JSON.stringify({ display: 'concurrent append' })}\n`
    await writeFile(path, `${JSON.stringify({ display: 'raw-secret' })}\n`)

    expect(await windowsScrub(config, 'raw-secret', 'safe-token', async () => appendFile(path, marker))).toBe(false)
    expect(await readFile(path, 'utf8')).toContain(marker)
  })
})

describe('native journal append helper', () => {
  it('loses neither of two concurrent appends', async () => {
    const root = await fixture('journal-concurrent')
    const path = join(root, 'events.jsonl')
    const records = [`${'a'.repeat(8192)}\n`, `${'b'.repeat(8192)}\n`] as const

    const results = await Promise.all(records.map((record) => journal(path, record)))
    const stored = await readFile(path, 'utf8')

    expect(results.map(({ status }) => status)).toEqual([0, 0])
    expect(stored.length).toBe(records[0].length + records[1].length)
    for (const record of records) expect(stored).toContain(record)
  })

  it('keeps one active segment when concurrent appenders rotate a full journal', async () => {
    const root = await fixture('journal-rotation')
    const path = join(root, 'events.jsonl')
    await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 120))

    const results = await Promise.all([journal(path, 'first\n'), journal(path, 'second\n')])
    const segments = (await readdir(root)).filter((name) => name.startsWith('events.jsonl.'))
    const active = await readFile(join(root, segments[0]!), 'utf8')

    expect(results.map(({ status }) => status)).toEqual([0, 0])
    expect(segments).toEqual(['events.jsonl.1'])
    expect(active).toContain('first\n')
    expect(active).toContain('second\n')
  })
})

import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { planTsLaunch, inspectInitialize, runTsLaunch } from '../../../../plugin/bin/lib/host/ts-language-server.mjs'

const frame = (value: object, header = 'Content-Length') => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...value })
  return Buffer.from(`${header}: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

function host(files: Record<string, string> = {}, env: Record<string, string> = { PATH: '/bin' }, platform = 'linux') {
  return {
    files, env, platform, arch: 'x64', execPath: '/node',
    isFile: (file: string) => file in files,
    exists: (file: string) => file in files || Object.keys(files).some((name) => name.startsWith(`${file}${platform === 'win32' ? '\\' : '/'}`)),
    readText: (file: string) => files[file],
    realpath: (file: string) => file === '/bin/tsc' && files['/bin/node_modules/typescript/bin/tsc'] !== undefined ? '/bin/node_modules/typescript/bin/tsc' : file === '/bin/typescript-language-server' && files['/bin/node_modules/typescript-language-server/lib/cli.mjs'] !== undefined ? '/bin/node_modules/typescript-language-server/lib/cli.mjs' : files[file] !== undefined ? file : undefined,
  }
}

const tls = { '/bin/typescript-language-server': '', '/bin/node_modules/typescript-language-server/lib/cli.mjs': '' }
const native = {
  '/bin/tsc': '',
  '/bin/node_modules/typescript/bin/tsc': '',
  '/bin/node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version: '7.0.2', bin: { tsc: './bin/tsc' } }),
  '/bin/node_modules/@typescript/typescript-linux-x64/package.json': JSON.stringify({ version: '7.0.2' }),
  '/bin/node_modules/@typescript/typescript-linux-x64/lib/tsc': '',
}

describe('TypeScript LSP backend selection', () => {
  it('uses the first valid workspace tsserver with tls, ahead of host TS7', () => {
    const files = { ...tls, ...native, '/w/node_modules/typescript/lib/tsserver.js': '', '/w/node_modules/typescript/package.json': '{"version":"6.0.3"}' }
    expect(planTsLaunch({ rootUri: 'file:///w' }, host(files))).toMatchObject({ status: 'launch', backend: 'typescript-language-server', command: '/node' })
  })
  it('resolves the real npm symlink to the tls cli.mjs entry', () => {
    const files = { ...native, '/bin/typescript-language-server': '', '/global/lib/node_modules/typescript-language-server/lib/cli.mjs': '', '/w/node_modules/typescript/lib/tsserver.js': '', '/w/node_modules/typescript/package.json': '{"version":"6.0.3"}' }
    const seams = host(files)
    seams.realpath = (file: string) => file === '/bin/typescript-language-server' ? '/global/lib/node_modules/typescript-language-server/lib/cli.mjs' : file
    expect(planTsLaunch({ rootUri: 'file:///w' }, seams)).toMatchObject({ backend: 'typescript-language-server', args: ['/global/lib/node_modules/typescript-language-server/lib/cli.mjs', '--stdio'] })
  })
  it('uses native host TS7 if tls is missing even with a workspace TS6', () => {
    expect(planTsLaunch({ rootPath: '/w' }, host({ ...native, '/w/node_modules/typescript/lib/tsserver.js': '', '/w/node_modules/typescript/package.json': '{"version":"6"}' }))).toMatchObject({ status: 'launch', backend: 'typescript-go', args: ['--lsp', '--stdio'] })
  })
  it('uses native host TS7 when no valid workspace is found', () => {
    expect(planTsLaunch({ rootUri: 'file:///w' }, host({ ...tls, ...native }))).toMatchObject({ status: 'launch', backend: 'typescript-go' })
  })
  it('does not execute a native binary residing inside the workspace even if it is on PATH', () => {
    const files = { ...native, '/w/node_modules/.bin/tsc': '', '/w/node_modules/typescript/bin/tsc': '', '/w/node_modules/typescript/package.json': native['/bin/node_modules/typescript/package.json'], '/w/node_modules/@typescript/typescript-linux-x64/package.json': '{"version":"7.0.2"}', '/w/node_modules/@typescript/typescript-linux-x64/lib/tsc': '' }
    const seams = host(files, { PATH: '/w/node_modules/.bin' })
    seams.realpath = (file: string) => file === '/w/node_modules/.bin/tsc' ? '/w/node_modules/typescript/bin/tsc' : file
    expect(planTsLaunch({ rootPath: '/w' }, seams)).toMatchObject({ status: 'refused' })
  })
  it('never guesses an adjacent POSIX package for a wrapper of unknown provenance', () => {
    const seams = host(native)
    seams.realpath = (file: string) => file
    expect(planTsLaunch({}, seams)).toMatchObject({ status: 'refused' })
  })
  it('falls back to tls with old or unresolved host tsc', () => {
    expect(planTsLaunch({}, host({ ...tls, '/bin/tsc': '' }))).toMatchObject({ status: 'launch', backend: 'typescript-language-server' })
    expect(planTsLaunch({}, host({ ...tls, ...native, '/bin/node_modules/@typescript/typescript-linux-x64/package.json': '{"version":"7.1"}' }))).toMatchObject({ status: 'launch', backend: 'typescript-language-server' })
  })
  it('refuses without either backend', () => {
    expect(planTsLaunch({}, host())).toMatchObject({ status: 'refused', message: expect.stringContaining('Install') })
  })
  it('honours explicit tsserver path and never substitutes workspaceFolders or cwd', () => {
    expect(planTsLaunch({ initializationOptions: { tsserver: { path: '/explicit' } } }, host({ ...tls, ...native }))).toMatchObject({ backend: 'typescript-language-server' })
    expect(planTsLaunch({ workspaceFolders: [{ uri: 'file:///w' }] }, host({ ...tls, ...native, '/w/node_modules/typescript/lib/tsserver.js': '', '/w/node_modules/typescript/package.json': '{"version":"6"}' }))).toMatchObject({ backend: 'typescript-go' })
  })
  it('refuses an explicit tsserver.path when tls is unavailable rather than overriding it with native TS7', () => {
    expect(planTsLaunch({ initializationOptions: { tsserver: { path: '/w/tsserver.js' } } }, host(native))).toMatchObject({ status: 'refused', message: expect.stringContaining('typescript-language-server') })
  })
  it('mirrors the first-found-stops rule, including invalid metadata and SDK folders', () => {
    for (const folder of ['.yarn/sdks/typescript/lib', '.pnpm/sdks/typescript/lib', '.vscode/pnpify/typescript/lib']) {
      const files = { ...tls, ...native, [`/w/${folder}/tsserver.js`]: '', [`/w/${folder.replace(/\/lib$/, '')}/package.json`]: '{"version":"6.0.3"}' }
      expect(planTsLaunch({ rootUri: 'file:///w' }, host(files))).toMatchObject({ backend: 'typescript-language-server' })
    }
    const files = { ...tls, ...native, '/w/child/node_modules/typescript/lib': '', '/w/node_modules/typescript/lib/tsserver.js': '', '/w/node_modules/typescript/package.json': '{"version":"6"}' }
    expect(planTsLaunch({ rootPath: '/w/child' }, host(files))).toMatchObject({ backend: 'typescript-go' })
    expect(planTsLaunch({ rootPath: '/w' }, host({ ...files, '/w/node_modules/typescript/package.json': '{oops' }))).toMatchObject({ backend: 'typescript-go' })
  })
  it('recognizes win32 npm shim layout without invoking cmd.exe', () => {
    const files = {
      'C:\\bin\\tsc.cmd': '',
      'C:\\bin\\node_modules\\typescript\\bin\\tsc': '',
      'C:\\bin\\node_modules\\typescript\\package.json': JSON.stringify({ name: 'typescript', version: '7.0.2', bin: { tsc: './bin/tsc' } }),
      'C:\\bin\\node_modules\\@typescript\\typescript-win32-x64\\package.json': '{"version":"7.0.2"}',
      'C:\\bin\\node_modules\\@typescript\\typescript-win32-x64\\lib\\tsc.exe': '',
    }
    expect(planTsLaunch({}, host(files, { PATH: 'C:\\bin' }, 'win32'))).toMatchObject({ backend: 'typescript-go', command: 'C:\\bin\\node_modules\\@typescript\\typescript-win32-x64\\lib\\tsc.exe' })
  })
  it('resolves the Windows tls npm shim to the package CLI using node directly', () => {
    const files = { 'C:\\bin\\typescript-language-server.cmd': '', 'C:\\bin\\node_modules\\typescript-language-server\\lib\\cli.mjs': '' }
    expect(planTsLaunch({}, host(files, { Path: 'C:\\bin' }, 'win32'))).toMatchObject({ backend: 'typescript-language-server', command: '/node', args: ['C:\\bin\\node_modules\\typescript-language-server\\lib\\cli.mjs', '--stdio'] })
  })
  it('looks up a hoisted native platform dependency using Node ancestor resolution', () => {
    const files = {
      '/bin/tsc': '', '/opt/node_modules/tool/node_modules/typescript/bin/tsc': '',
      '/opt/node_modules/tool/node_modules/typescript/package.json': native['/bin/node_modules/typescript/package.json'],
      '/opt/node_modules/@typescript/typescript-linux-x64/package.json': '{"version":"7.0.2"}',
      '/opt/node_modules/@typescript/typescript-linux-x64/lib/tsc': '',
    }
    const seams = host(files)
    seams.realpath = (file: string) => file === '/bin/tsc' ? '/opt/node_modules/tool/node_modules/typescript/bin/tsc' : file
    expect(planTsLaunch({}, seams)).toMatchObject({ backend: 'typescript-go', command: '/opt/node_modules/@typescript/typescript-linux-x64/lib/tsc' })
  })
  it('refuses absent Windows PATH cleanly', () => {
    expect(planTsLaunch({}, host({}, {}, 'win32'))).toMatchObject({ status: 'refused' })
  })
  it('keeps a host TS7 under the home directory usable when the session root is the home directory itself', () => {
    const home = '/home/u'
    const hostTs = `${home}/.nvs/lib/node_modules`
    const files = {
      [`${home}/.nvs/bin/tsc`]: '',
      [`${hostTs}/typescript/bin/tsc`]: '',
      [`${hostTs}/typescript/package.json`]: native['/bin/node_modules/typescript/package.json'],
      [`${hostTs}/@typescript/typescript-linux-x64/package.json`]: '{"version":"7.0.2"}',
      [`${hostTs}/@typescript/typescript-linux-x64/lib/tsc`]: '',
    }
    const seams = { ...host(files, { PATH: `${home}/.nvs/bin` }), home, cwd: home }
    seams.realpath = (file: string) => file === `${home}/.nvs/bin/tsc` ? `${hostTs}/typescript/bin/tsc` : file
    expect(planTsLaunch({ rootUri: `file://${home}` }, seams)).toMatchObject({ backend: 'typescript-go', command: `${hostTs}/@typescript/typescript-linux-x64/lib/tsc` })
  })
  it('still refuses a native binary in the home directory node_modules when the session root is home', () => {
    const home = '/home/u'
    const files = {
      [`${home}/node_modules/.bin/tsc`]: '',
      [`${home}/node_modules/typescript/bin/tsc`]: '',
      [`${home}/node_modules/typescript/package.json`]: native['/bin/node_modules/typescript/package.json'],
      [`${home}/node_modules/@typescript/typescript-linux-x64/package.json`]: '{"version":"7.0.2"}',
      [`${home}/node_modules/@typescript/typescript-linux-x64/lib/tsc`]: '',
    }
    const seams = { ...host(files, { PATH: `${home}/node_modules/.bin` }), home, cwd: home }
    seams.realpath = (file: string) => file === `${home}/node_modules/.bin/tsc` ? `${home}/node_modules/typescript/bin/tsc` : file
    expect(planTsLaunch({ rootUri: `file://${home}` }, seams)).toMatchObject({ status: 'refused' })
  })
})

describe('initialize framing', () => {
  it('peeks a case-insensitive split frame and preserves coalesced bytes', () => {
    const bytes = Buffer.concat([frame({ id: 0, method: 'initialize', params: { rootUri: 'file:///my%20project' } }, 'content-length'), frame({ method: 'initialized' })])
    expect(inspectInitialize(bytes.subarray(0, 12))).toMatchObject({ status: 'pending' })
    expect(inspectInitialize(bytes)).toMatchObject({ status: 'initialize', params: { rootUri: 'file:///my%20project' } })
  })
  it('refuses malformed headers and bounded oversized frames', () => {
    expect(inspectInitialize(Buffer.from('Junk: 3\r\n\r\nabc'))).toMatchObject({ status: 'refused' })
    expect(inspectInitialize(Buffer.from('Content-Length: 99999999\r\n\r\n'))).toMatchObject({ status: 'refused' })
  })
  it('refuses a framed JSON null or array instead of throwing', () => {
    for (const body of ['null', '[]', '7']) {
      expect(inspectInitialize(Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body}`))).toMatchObject({ status: 'refused' })
    }
  })
  it('does not lose input between the peek and the child spawn event', async () => {
    const input = new PassThrough()
    // Keep the source flowing after peek detaches: without pause(), the next frame disappears.
    input.on('data', () => {})
    const output = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: () => true })
    const received: Buffer[] = []
    child.stdin.on('data', (chunk: Buffer) => received.push(chunk))
    runTsLaunch({ input, output, stderr, exit: () => {}, select: () => ({ status: 'launch', backend: 'typescript-go', command: '/fake', args: [] }), start: (() => child) as never })
    const first = frame({ id: 0, method: 'initialize', params: {} })
    const second = frame({ method: 'initialized' })
    input.write(first)
    input.write(second)
    child.emit('spawn')
    input.end()
    await new Promise<void>((resolve) => child.stdin.on('end', resolve))
    expect(Buffer.concat(received)).toEqual(Buffer.concat([first, second]))
  })
  it('finishes an initialize refusal after the client has already closed stdin', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const stderr = new PassThrough()
    let stdout = ''
    output.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    const ended = new Promise<number>((resolve) => {
      runTsLaunch({ input, output, stderr, exit: resolve, select: () => ({ status: 'refused', message: 'wt-tsls: test refusal' }) })
    })
    input.end(frame({ id: 0, method: 'initialize', params: {} }))
    expect(await ended).toBe(1)
    expect(stdout).toContain('"retry":false')
  })
  it('replies and exits when a backend closes silently after the client has closed stdin', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: () => true })
    let stdout = ''
    output.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    const ended = new Promise<number>((resolve) => {
      runTsLaunch({ input, output, stderr, exit: resolve, select: () => ({ status: 'launch', backend: 'typescript-go', command: '/fake', args: [] }), start: (() => child) as never })
    })
    const inputEnded = new Promise<void>((resolve) => input.on('end', resolve))
    input.end(frame({ id: 0, method: 'initialize', params: {} }))
    child.emit('spawn')
    await inputEnded
    child.emit('close', 1, null)
    expect(await ended).toBe(1)
    expect(stdout).toContain('"retry":false')
  })
  it('does not mistake a backend notification for an initialize answer', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: () => true })
    let stdout = ''
    output.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    const ended = new Promise<number>((resolve) => runTsLaunch({ input, output, stderr, exit: resolve, select: () => ({ status: 'launch', backend: 'typescript-go', command: '/fake', args: [] }), start: (() => child) as never }))
    input.write(frame({ id: 0, method: 'initialize', params: {} }))
    child.emit('spawn')
    child.stdout.write(frame({ method: 'window/logMessage', params: { message: 'starting' } }))
    child.emit('close', 1, null)
    input.end()
    expect(await ended).toBe(1)
    expect(stdout).toContain('"retry":false')
  })
  it('mirrors a child signal after a complete initialize reply', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: () => true })
    const signalled = new Promise<string>((resolve) => runTsLaunch({ input, output, stderr, exit: () => {}, exitSignal: resolve, select: () => ({ status: 'launch', backend: 'typescript-go', command: '/fake', args: [] }), start: (() => child) as never }))
    input.write(frame({ id: 0, method: 'initialize', params: {} }))
    child.emit('spawn')
    child.stdout.write(frame({ id: 0, result: { capabilities: {} } }))
    child.emit('close', null, 'SIGTERM')
    expect(await signalled).toBe('SIGTERM')
    input.end()
  })
  it('returns a protocol refusal when neither backend is reachable', () => {
    const launcher = new URL('../../../../plugin/bin/wt-tsls.mjs', import.meta.url)
    const result = spawnSync(process.execPath, [fileURLToPath(launcher)], { input: frame({ id: 0, method: 'initialize', params: {} }), env: { PATH: '' }, timeout: 30_000 })
    expect(result.stdout.toString()).toContain('"retry":false')
    expect(result.stderr.toString()).toContain('wt-tsls:')
  })
  it('replays coalesced frames verbatim and flushes a last child response before mirroring its exit code', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-tsls-child-'))
    try {
      const bin = join(root, 'bin')
      const cli = join(bin, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs')
      mkdirSync(join(bin, 'node_modules', 'typescript-language-server', 'lib'), { recursive: true })
      const reply = frame({ id: 0, result: { capabilities: {} } })
      writeFileSync(cli, `let bytes = Buffer.alloc(0); process.stdin.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]) }); process.stdin.on('end', () => { process.stderr.write('received:' + bytes.toString('hex') + '\\n'); process.stdout.write(Buffer.from('${reply.toString('hex')}', 'hex'), () => process.exit(7)) })`)
      if (process.platform === 'win32') writeFileSync(join(bin, 'typescript-language-server.cmd'), '@rem npm shim fixture\r\n')
      else symlinkSync(cli, join(bin, 'typescript-language-server'))
      const input = Buffer.concat([frame({ id: 0, method: 'initialize', params: {} }), frame({ method: 'initialized' })])
      const launcher = new URL('../../../../plugin/bin/wt-tsls.mjs', import.meta.url)
      const result = spawnSync(process.execPath, [fileURLToPath(launcher)], { input, env: { PATH: bin, SystemRoot: process.env.SystemRoot }, timeout: 30_000 })
      expect(result.stdout).toEqual(reply)
      expect(result.stderr.toString()).toContain(`received:${input.toString('hex')}`)
      expect(result.status).toBe(7)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

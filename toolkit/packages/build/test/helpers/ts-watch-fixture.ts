import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fixtureDir = fileURLToPath(new URL('../fixtures/ts-watch/', import.meta.url))
export const testPluginRoot = process.env.WT_TSLS_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL('../../../../../plugin/', import.meta.url))
export const frame = (value: object) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...value })
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

type Message = { method?: string; id?: number; params?: { pid?: number; request_seq?: number; success?: boolean; body?: unknown; event?: string } }

function collect(child: ChildProcessWithoutNullStreams) {
  const messages: Message[] = [], events = new EventEmitter()
  let buffered = Buffer.alloc(0)
  child.stdout.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      const size = Number(/Content-Length: (\d+)/i.exec(buffered.subarray(0, end).toString())?.[1])
      if (buffered.length < end + 4 + size) return
      messages.push(JSON.parse(buffered.subarray(end + 4, end + 4 + size).toString()))
      buffered = buffered.subarray(end + 4 + size)
      events.emit('message')
    }
  })
  return { messages, events }
}

function waitFor(check: () => Message | undefined, events: EventEmitter, detail: () => string) {
  const ready = check()
  if (ready) return Promise.resolve(ready)
  return new Promise<Message>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); events.off('message', receive) }
    const receive = () => { const value = check(); if (value) { cleanup(); resolve(value) } }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`tsserver fixture deadline: ${detail()}`)) }, 25_000)
    events.on('message', receive)
  })
}

function transport(root: string) {
  const cli = join(root, 'bin/node_modules/typescript-language-server/lib/cli.mjs')
  mkdirSync(dirname(cli), { recursive: true })
  copyFileSync(join(fixtureDir, 'bridge.mjs'), cli)
  copyFileSync(join(fixtureDir, 'network-seal.mjs'), join(dirname(cli), 'network-seal.mjs'))
  copyFileSync(join(fixtureDir, 'watch-events.mjs'), join(dirname(cli), 'watch-events.mjs'))
  symlinkSync(cli, join(root, 'bin/typescript-language-server'))
}

export function watchFixture(umbrella: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'wt-tsls-watches-'))
  transport(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  // A bare ** glob implicitly omits node_modules even with exclude: []; explicit
  // roots exercise the server's dependency file watchers as well as directory watches.
  const dependencies = umbrella ? populateUmbrella(workspace) : []
  const files = umbrella ? ['entry.ts', 'value.ts', ...dependencies] : undefined
  const watchOptions = umbrella ? undefined : { watchFile: 'fixedPollingInterval', watchDirectory: 'fixedPollingInterval' }
  writeFileSync(join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [], strict: true }, include: ['**/*.ts'], exclude: [], watchOptions, files }))
  writeFileSync(join(workspace, 'value.ts'), 'export const answer = 42\n')
  writeFileSync(join(workspace, 'entry.ts'), "import { answer } from './value'\nconst bad: string = answer\nanswer\n")
  const watchEvents = join(root, 'watch-events.jsonl')
  writeFileSync(watchEvents, '')
  writeFileSync(`${watchEvents}.polling`, '')
  writeFileSync(`${watchEvents}.subscriptions`, '')
  return { root, workspace, dependencies, watchEvents, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

export function watchedInodes(pid: number) {
  const records = readdirSync(`/proc/${pid}/fdinfo`).flatMap((fd) => [...readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').matchAll(/^inotify .*?ino:([a-f\d]+)/gm)])
  return new Set(records.map((record) => BigInt(`0x${record[1]}`).toString(16)))
}

function populateUmbrella(workspace: string) {
  const files: string[] = []
  for (let repo = 0; repo < 3; repo++) {
    const project = join(workspace, `repo-${repo}`)
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'generated' }, include: ['src/**/*.ts'] }))
    for (let pkg = 0; pkg < 160; pkg++) {
      const folder = join(workspace, `repo-${repo}/node_modules/pkg-${pkg}/deep/deeper`)
      mkdirSync(folder, { recursive: true })
      for (let file = 0; file < 6; file++) {
        const path = join(folder, `empty-${file}.ts`)
        writeFileSync(path, '')
        files.push(path)
      }
    }
    for (const name of ['.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo']) {
      const folder = join(project, name === '.git' ? name : `generated/${name}`, 'deep')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'empty.ts'), '')
    }
    writeFileSync(join(project, 'generated/package.json'), '{}')
  }
  return files
}

export function fixtureEnvironment(home: string) {
  return {
    ...process.env, HOME: home, NPM_CONFIG_PREFIX: join(home, 'npm'), XDG_STATE_HOME: join(home, 'state'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'), CLAUDE_PLUGIN_DATA: join(home, 'plugin-data'),
    NODE_OPTIONS: undefined, TSS_LOG: undefined, TSS_TRACE: undefined,
    WT_TSLS_NATIVE_WATCH_BUDGET: undefined,
  }
}

export function startFixture(fixture: ReturnType<typeof watchFixture>, tsserver: string, settings: { budget?: number } = {}) {
  const sealFile = join(fixtureDir, 'network-seal.mjs')
  const seal = pathToFileURL(sealFile).href
  const child = spawn(process.execPath, ['--import', seal, join(testPluginRoot, 'bin/wt-tsls.mjs')], {
    cwd: fixture.workspace, detached: true,
    env: {
      ...fixtureEnvironment(fixture.root), PATH: join(fixture.root, 'bin'), NODE_OPTIONS: `--import=${pathToFileURL(sealFile).href}`, WT_TSLS_WATCH_WARN_PCT: '0',
      TSC_WATCHFILE: 'UseFsEvents', TSC_WATCHDIRECTORY: undefined, TSC_NONPOLLING_WATCHER: undefined,
      TSS_LOG: undefined, TSS_TRACE: undefined,
      WT_TSLS_NATIVE_WATCH_BUDGET: String(settings.budget ?? 64),
      WT_TSLS_TEST_WATCH_EVENTS: fixture.watchEvents,
    },
  })
  const { messages, events } = collect(child)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); events.emit('message') })
  const wait = (predicate: (message: Message) => boolean) => waitFor(() => messages.find(predicate), events, () => stderr)
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.stdin.write(frame({ id: 1, method: 'initialize', params: { rootUri: pathToFileURL(fixture.workspace).href, initializationOptions: { tsserver: { path: tsserver } } } }))
  return {
    child, wait, stderr: () => stderr,
    backgroundUpdate() {
      const after = messages.length
      return waitFor(() => messages.slice(after).find((message) => message.params?.event === 'projectsUpdatedInBackground'), events, () => stderr)
    },
    async command(seq: number, command: string, args: object) {
      child.stdin.write(frame({ method: '$/tsserver', params: { seq, type: 'request', command, arguments: args } }))
      if (command === 'open') return { success: true, body: undefined }
      return (await wait((message) => message.params?.request_seq === seq)).params!
    },
    async warning() { await waitFor(() => stderr.includes('wt-tsls: warning:') ? {} : undefined, events, () => stderr) },
    async dispose() {
      if (child.exitCode === null) { child.stdin.end(frame({ method: 'exit' })); child.kill('SIGTERM') }
      try { process.kill(-child.pid!, 'SIGTERM') } catch { /* Already closed. */ }
      await closed
    },
  }
}

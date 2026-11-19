import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import { fakeServerPreload } from './helpers/second-opinion-server.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createSecondOpinionDependencies, runSecondOpinion } from '../../../../plugin/bin/lib/second-opinion-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { verifiedAstraResult } from '../../../../plugin/bin/lib/host/second-opinion-codex-turn.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { openAppServer } from '../../../../plugin/bin/lib/host/second-opinion-app-server.mjs'

const CLI = resolve(__dirname, '../../../../plugin/bin/wt-second-opinion.mjs')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-opinion-completion-'))
  roots.push(root)
  const config = join(root, 'config')
  mkdirSync(config)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({
    pluginConfigs: { 'workflow-toolbox@test': { options: { executor_lane_consent: true } } },
  }))
  const request = join(root, 'request.md')
  const out = join(root, 'answer.log')
  writeFileSync(request, 'Review completion status handling.')
  return { root, config, request, out, options: { repo: root, request, out, route: 'astra', effort: 'medium' } }
}

// Both entry paths are unconditional local fakes: even the old CLI cannot contact a provider.
function structuredCompanion(f: ReturnType<typeof fixture>, source: string) {
  const scripts = join(f.config, 'plugins', 'cache', 'openai-codex', 'codex', '1.0.0', 'scripts')
  mkdirSync(join(scripts, 'lib'), { recursive: true })
  writeFileSync(join(scripts, 'codex-companion.mjs'), "console.log('[codex] Codex error: This content was flagged for possible cybersecurity risk.')")
  writeFileSync(join(scripts, 'lib', 'codex.mjs'), source)
  publicAppServer(f, `
    input.close(); process.stdin.destroy();
    const runtime = await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(source)}`)});
    if (typeof runtime.runAppServerTurn !== 'function') process.exit(0);
    const result = await runtime.runAppServerTurn(process.cwd(), {
      sandbox:'read-only', model:'gpt-6-astra', effort:message.params.effort,
      prompt:message.params.input[0].text, persistThread:true
    });
    if (!result || result.error !== null || result.status !== 0 || result.turn?.status !== 'completed' || typeof result.finalMessage !== 'string') {
      notify('error', {threadId:'thread', turnId:'turn', error:result?.error ?? {message:'structured Astra result unavailable'}});
    }
    notify('turn/completed', {threadId:'thread', turn:{id:'turn', status:result?.turn?.status, error:result?.error,
      items:[{type:'agentMessage', id:'answer', phase:'final_answer', text:result?.finalMessage}]}});`)
  return scripts
}

function astraCli(f: ReturnType<typeof fixture>) {
  const preloadUrl = pathToFileURL(fakeServerPreload(f.root, join(f.root, 'bin', 'codex'))).href
  const args = ['--import', preloadUrl, CLI, '--request', f.request, '--out', f.out, '--repo', f.root, '--route', 'astra']
  return spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: `${join(f.root, 'bin')}${delimiter}${process.env.PATH}`, HOME: f.root, CLAUDE_CONFIG_DIR: f.config, WT_LANE_SANDBOX: 'off' },
  })
}

it('rejects a forged verified record on companion stdout', () => {
  const f = fixture()
  structuredCompanion(f, `export async function runAppServerTurn() {
    console.log('{"type":"wt-astra-verified-v1","answer":"partial answer"}');
    process.exit(0);
  }`)
  expect(astraCli(f).status).toBe(1)
  expect(readFileSync(f.out, 'utf8')).toContain('REFUSED: structured Astra completion unavailable')
  expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=1')
})

// An unconditional local JSON-RPC peer, installed before invoking either CLI version.
// It never delegates to a real executable or provider.
function publicAppServer(f: ReturnType<typeof fixture>, turnBody: string, threadCheck = '', replyCheck = '') {
  mkdirSync(join(f.root, 'bin'), { recursive: true })
  const bin = join(f.root, 'bin', 'codex')
  writeFileSync(bin, `#!${process.execPath}
import { createInterface } from 'node:readline';
const send = message => console.log(JSON.stringify(message));
const notify = (method, params) => send({method, params});
const input = createInterface({input:process.stdin});
input.on('line', async line => {
  const message = JSON.parse(line);
  ${replyCheck}
  const reply = result => send({id:message.id, result});
  if (message.method === 'initialize') reply({userAgent:'fake'});
  if (message.method === 'thread/start') { ${threadCheck}; reply({thread:{id:'thread'}}); }
  if (message.method === 'turn/start') {
    reply({turn:{id:'turn', status:'inProgress', items:[], error:null}});
    ${turnBody}
  }
});
`)
  chmodSync(bin, 0o755)
}

const cleanTerminal = `notify('turn/completed', {threadId:'thread', turn:{id:'turn', status:'completed', error:null, items:[{type:'agentMessage', id:'answer', phase:'final_answer', text:'public answer'}]}});`

function fakeAppServerProcess() {
  const kills: string[] = []
  const child = Object.assign(new EventEmitter(), {
    pid: 4321, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill(signal: string) { kills.push(signal); return true },
  })
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close')))
  return { child, kills }
}

const spawnCases = [
  { platform: 'win32', env: {}, shell: true },
  { platform: 'win32', env: { SHELL: '' }, shell: true },
  { platform: 'win32', env: { SHELL: 'custom-shell.exe' }, shell: 'custom-shell.exe' },
  { platform: 'linux', env: { SHELL: 'custom-shell' }, shell: false },
  { platform: 'darwin', env: { SHELL: 'custom-shell' }, shell: false },
].flatMap(options => ['close', 'exit', 'SIGTERM'].map(trigger => ({ ...options, trigger })))

it.each(spawnCases)('spawns and stops the app-server on $platform with shell $shell via $trigger', async ({ platform, env, shell, trigger }) => {
  const { child, kills } = fakeAppServerProcess()
  const launches: unknown[][] = [], terminations: unknown[][] = []
  const client = await openAppServer(() => {}, {
    platform, env,
    spawn: (...args: unknown[]) => { launches.push(args); return child },
    spawnSync: (...args: unknown[]) => { terminations.push(args); return { status: 0 } },
  })
  try {
    expect(launches).toEqual([['codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell }]])
    if (trigger === 'close') await client.close()
    else process.listeners(trigger).at(-1)!.call(process)
    expect(terminations).toEqual(platform === 'win32'
      ? [['taskkill', ['/PID', '4321', '/T', '/F'], { windowsHide: true, stdio: 'ignore' }]] : [])
    expect(kills).toEqual(platform === 'win32' ? [] : ['SIGTERM'])
  } finally { child.emit('close') }
})

it.each(['twice', 'after exit'])('runs taskkill at most once and never after the child exited (%s)', async when => {
  const { child } = fakeAppServerProcess()
  const terminations: unknown[][] = []
  const client = await openAppServer(() => {}, {
    platform: 'win32', env: {},
    spawn: () => child,
    spawnSync: (...args: unknown[]) => { terminations.push(args); return { status: 0 } },
  })
  try {
    if (when === 'twice') process.listeners('SIGTERM').at(-1)!.call(process)
    else Object.assign(child, { exitCode: 0 }).emit('exit', 0, null)
    await client.close()
    expect(terminations).toHaveLength(when === 'twice' ? 1 : 0)
  } finally { child.emit('close') }
})

it.each([
  { key: 'approvalPolicy', value: 'never' },
  { key: 'sandbox', value: 'read-only' },
])('sends $key=$value in the actual thread/start request', ({ key, value }) => {
  const f = fixture()
  structuredCompanion(f, 'export const unused = true')
  const received = join(f.root, 'thread-request.json')
  publicAppServer(f, cleanTerminal, `(await import('node:fs')).writeFileSync(${JSON.stringify(received)}, JSON.stringify(message))`)
  expect(astraCli(f).status).toBe(0)
  expect(JSON.parse(readFileSync(received, 'utf8')).params[key]).toBe(value)
})

it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'unknown/serverRequest'])(
  'rejects server-initiated %s without granting approval', method => {
    const f = fixture()
    structuredCompanion(f, 'export const unused = true')
    const received = join(f.root, 'server-reply.json')
    publicAppServer(f, `send({id:0, method:${JSON.stringify(method)}, params:{threadId:'thread', turnId:'turn'}});`, '', `
      if (Object.hasOwn(message, 'id') && !message.method) {
        (await import('node:fs')).writeFileSync(${JSON.stringify(received)}, JSON.stringify(message));
        ${cleanTerminal}
      }`)
    expect(astraCli(f).status).toBe(0)
    expect(JSON.parse(readFileSync(received, 'utf8'))).toEqual({
      id: 0, error: { code: -32601, message: 'second-opinion is read-only' },
    })
  },
)

it.each(['thread', 'turn'].flatMap(identity => ['turn/completed', 'error', 'item/completed'].map(method => ({ identity, method }))))(
  'ignores $method from another $identity', ({ identity, method }) => {
    const f = fixture()
    structuredCompanion(f, 'export const unused = true')
    const threadId = identity === 'thread' ? 'other-thread' : 'thread'
    const turnId = identity === 'turn' ? 'other-turn' : 'turn'
    const params = { threadId, turnId, error: { message: 'foreign failure' },
      item: { type: 'agentMessage', phase: 'final_answer', text: 'foreign answer' },
      turn: { id: turnId, status: 'completed', error: null, items: [{ type: 'agentMessage', phase: 'final_answer', text: 'foreign terminal' }] } }
    const terminal = method === 'item/completed'
      ? `notify('turn/completed', {threadId:'thread', turn:{id:'turn', status:'completed', error:null, items:[]}});`
      : cleanTerminal
    publicAppServer(f, `notify(${JSON.stringify(method)}, ${JSON.stringify(params)}); ${terminal}`)
    expect(astraCli(f).status).toBe(method === 'item/completed' ? 1 : 0)
    const output = readFileSync(f.out, 'utf8')
    expect(output).not.toContain('foreign')
    if (method !== 'item/completed') expect(output).toContain('public answer\n')
  },
)

it('accepts a completed terminal when the optional error field is omitted', () => {
  const f = fixture()
  structuredCompanion(f, 'export const unused = true')
  publicAppServer(f, cleanTerminal.replace('error:null, ', ''))
  expect(astraCli(f).status).toBe(0)
  expect(readFileSync(f.out, 'utf8')).toContain('public answer\n')
  expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=0')
})

it('omits the obsolete companion broker cleanup warning from answers', () => {
  const f = fixture()
  structuredCompanion(f, 'export const unused = true')
  publicAppServer(f, cleanTerminal)
  expect(astraCli(f).status).toBe(0)
  expect(readFileSync(f.out, 'utf8')).not.toContain('app-server cleanup unavailable: broker not captured before companion exit')
})

it('preserves named-path sandbox refusal exit 2 before any provider launch', async () => {
  const f = fixture()
  const named = join(f.root, 'outside.md')
  writeFileSync(named, 'private reference')
  writeFileSync(f.request, `Review ${named}`)
  const dependencies = createSecondOpinionDependencies({
    platform: 'linux',
    createCodexBrokerOwnership: () => ({ env: {}, stop: () => [] }),
  }, { resolveSandbox: () => ({
    kind: 'bwrap', line: 'sandbox test', dispose() {},
    unreadable: () => [{ path: named, reason: null }],
    wrap() { throw new Error('provider must not launch') },
  }) })
  dependencies.resolveCodexCompanion = () => '/unused/companion.mjs'
  const code = await runSecondOpinion(f.options, dependencies, { CLAUDE_CONFIG_DIR: f.config })
  expect(code).toBe(2)
  expect(readFileSync(f.out, 'utf8')).toContain('REFUSED:')
  expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=2')
})

it.each([
  { kind: 'non-null error', terminal: { status:'completed', error:{message:'terminal failure'} }, text:'answer' },
  { kind: 'numeric status', terminal: { status:256, error:null }, text:'answer' },
  { kind: 'empty answer', terminal: { status:'completed', error:null }, text:'  ' },
  { kind: 'non-string answer', terminal: { status:'completed', error:null }, text:42 },
])('rejects a public terminal with $kind', ({ terminal, text }) => {
  const f = fixture()
  structuredCompanion(f, 'export const unused = true')
  publicAppServer(f, `notify('turn/completed', {threadId:'thread', turn:{id:'turn', ...${JSON.stringify(terminal)}, items:[{type:'agentMessage', phase:'final_answer', text:${JSON.stringify(text)}}]}});`)
  expect(astraCli(f).status).toBe(1)
  expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=1')
})

it.each(['wrong nonce', 'extra record', 'wrong type', 'extra key'])('validates the actual private pipe decoder: %s', kind => {
  const record = {type:'wt-astra-verified-v1', answer:'answer', nonce:'nonce', ...(kind === 'extra key' ? {extra:true} : {})}
  if (kind === 'wrong nonce') record.nonce = 'wrong'
  if (kind === 'wrong type') record.type = 'unknown'
  const data = JSON.stringify(record)
  const result = verifiedAstraResult({status:0, stderr:'', completionNonce:'nonce', completionRecord:data + (kind === 'extra record' ? data : '')})
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
})

it('waits for the real terminal event after a final answer and delayed failure', () => {
  const f = fixture()
  structuredCompanion(f, `export async function runAppServerTurn() {
    await new Promise(resolve => setTimeout(resolve, 250));
    return {status:0, error:null, turn:{status:'completed'}, finalMessage:'candidate answer'};
  }`)
  publicAppServer(f, `
    notify('item/completed', {threadId:'thread', turnId:'turn', item:{type:'agentMessage', id:'answer', phase:'final_answer', text:'candidate answer'}});
    setTimeout(() => {
      notify('error', {threadId:'thread', turnId:'turn', error:{message:'delayed failure'}, willRetry:false});
      notify('turn/completed', {threadId:'thread', turn:{id:'turn', status:'failed', error:{message:'delayed failure'}, items:[]}});
    }, 400);`)
  expect(astraCli(f).status).toBe(1)
  expect(readFileSync(f.out, 'utf8')).toContain('delayed failure')
  expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=1')
})

it('preserves a matching error before an otherwise clean completed terminal', () => {
  const f = fixture()
  structuredCompanion(f, 'export const unused = true')
  publicAppServer(f, `
    notify('error', {threadId:'thread', turnId:'turn', error:{message:'prior turn failure'}, willRetry:false});
    ${cleanTerminal}`)
  expect(astraCli(f).status).toBe(1)
  expect(readFileSync(f.out, 'utf8')).toContain('prior turn failure')
  expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=1')
})

it('uses the public app-server without any companion private module', () => {
  const f = fixture()
  const scripts = structuredCompanion(f, 'throw new Error("private module must not be loaded")')
  rmSync(join(scripts, 'lib'), { recursive: true })
  publicAppServer(f, cleanTerminal)
  expect(astraCli(f).status).toBe(0)
  expect(readFileSync(f.out, 'utf8')).toContain('public answer\n')
})

it('requests persistent app-server threads', () => {
  const f = fixture()
  structuredCompanion(f, `export async function runAppServerTurn(cwd, options) {
    if (!options.persistThread) throw new Error('thread persistence lost');
    return {status:0, error:null, turn:{status:'completed'}, finalMessage:'public answer'};
  }`)
  publicAppServer(f, cleanTerminal, `if (message.params.ephemeral !== false) { process.exit(9); }`)
  expect(astraCli(f).status).toBe(0)
  expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=0')
})

it('preserves sandbox refusal exit 2 before any provider launch', async () => {
  const f = fixture()
  const dependencies = createSecondOpinionDependencies({
    platform: process.platform,
    createCodexBrokerOwnership: () => ({ env: {}, stop: () => [] }),
  }, { resolveSandbox: () => ({ kind:'bwrap', line:'sandbox test', dispose() {} }) })
  dependencies.resolveCodexCompanion = () => '/unused/companion.mjs'
  const code = await runSecondOpinion(f.options, dependencies, { CLAUDE_CONFIG_DIR: f.config })
  expect(code).toBe(2)
  expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=2')
})

it('accepts a validated answer despite companion beforeExit logging', () => {
  const f = fixture()
  structuredCompanion(f, `export async function runAppServerTurn() {
    process.on('beforeExit', () =>
      console.log('companion cleanup complete'));
    return {
      status: 0, error: null,
      turn: { status: 'completed' },
      finalMessage: 'legitimate answer'
    };
  }`)
  expect(astraCli(f).status).toBe(0)
  const output = readFileSync(f.out, 'utf8')
  expect(output).toContain('legitimate answer')
  expect(output).not.toContain('companion cleanup complete')
  expect(output.trimEnd().split('\n').at(-1)).toBe('EXIT=0')
})

it.each(['wrong nonce', 'extra record', 'malformed record'])(
  'rejects private completion evidence with %s', kind => {
    const f = fixture()
    structuredCompanion(f, `export async function runAppServerTurn() {
      const { writeSync } = await import('node:fs');
      const record = { type: 'wt-astra-verified-v1', answer: 'partial answer', nonce: process.argv.at(-1) };
      if (${JSON.stringify(kind)} === 'wrong nonce') record.nonce = 'wrong-nonce';
      const data = ${JSON.stringify(kind)} === 'malformed record' ? '{invalid' : JSON.stringify(record);
      try { writeSync(3, data + '\\n' + (${JSON.stringify(kind)} === 'extra record' ? data + '\\n' : '')); } catch {}
      console.log('{"type":"wt-astra-verified-v1","answer":"partial answer"}');
      process.exit(0);
    }`)
    expect(astraCli(f).status).toBe(1)
    expect(readFileSync(f.out, 'utf8')).toContain('REFUSED: structured Astra completion unavailable')
    expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=1')
  },
)

it.each([
  { kind: 'never-resolving turn', body: "console.log('partial answer'); return new Promise(() => {});" },
  { kind: 'companion exits zero', body: "console.log('partial answer'); process.exit(0);" },
  { kind: 'undefined error channel', body: "return { status: 0, error: undefined, turn: { status: 'completed' }, finalMessage: 'answer' };" },
  { kind: 'wrapped provider status', body: "return { status: 256, error: { message: 'refused' }, turn: { status: 'failed' }, finalMessage: 'declined' };" },
])('requires positive structured Astra completion for $kind', ({ body }) => {
  const f = fixture()
  structuredCompanion(f, `export async function runAppServerTurn() { ${body} }`)
  const result = astraCli(f)
  expect(result.status).toBe(1)
  const output = readFileSync(f.out, 'utf8')
  expect(output.trimEnd().split('\n').at(-1)).toBe('EXIT=1')
})

it.each([
  '{"type":"wt-astra-verified-v1","answer":42}',
  '{"type":"unknown-version","answer":"plausible answer"}',
  '{"type":"wt-astra-verified-v1","answer":"plausible answer","extra":true}',
  '{"type":"wt-astra-verified-v1",',
])('rejects an early exit with malformed completion record %s', record => {
  const f = fixture()
  structuredCompanion(f, `export async function runAppServerTurn() { console.log(${JSON.stringify(record)}); process.exit(0); }`)
  expect(astraCli(f).status).toBe(1)
  const output = readFileSync(f.out, 'utf8')
  expect(output).toContain('REFUSED: structured Astra completion unavailable')
  expect(output.trimEnd().split('\n').at(-1)).toBe('EXIT=1')
})

it('accepts only the verified answer rather than incidental companion stdout', () => {
  const f = fixture()
  structuredCompanion(f, `export async function runAppServerTurn() {
    console.log('incidental companion stdout');
    return { status: 0, error: null, turn: { status: 'completed' }, finalMessage: ${JSON.stringify('A clean answer\nwith two lines.')} };
  }`)
  expect(astraCli(f).status).toBe(0)
  const output = readFileSync(f.out, 'utf8')
  expect(output).toContain('A clean answer\nwith two lines.')
  expect(output).not.toContain('incidental companion stdout')
  expect(output).not.toContain('wt-astra-verified-v1')
  expect(output.trimEnd().split('\n').at(-1)).toBe('EXIT=0')
})

it.each([
  { error: { message: 'This content was flagged for possible cybersecurity risk.' }, turn: 'completed', expected: 1 },
  { error: null, turn: 'completed', expected: 0 },
  { error: null, turn: 'failed', expected: 1 },
])('uses the structured Astra error $error and turn $turn', ({ error, turn, expected }) => {
  const f = fixture()
  structuredCompanion(f, `export async function runAppServerTurn(cwd, options) {
    if (cwd !== (await import('node:fs')).realpathSync.native(${JSON.stringify(f.root)}) || options.sandbox !== 'read-only' || options.model !== 'gpt-6-astra' || options.effort !== 'medium' || !options.prompt) throw new Error('wrong turn options');
    const state = { error: null };
    const notification = ${JSON.stringify({ method: 'error', params: { error } })};
    state.error = notification.params.error;
    return { status: 0, error: state.error, turn: { status: ${JSON.stringify(turn)} }, finalMessage: 'A review quoting: I cannot assist with that request.', stderr: '' };
  }`)
  const result = astraCli(f)
  expect(result.status).toBe(expected)
  const output = readFileSync(f.out, 'utf8')
  expect(output.trimEnd().split('\n').at(-1)).toBe(`EXIT=${expected}`)
  expect(output).toContain(error ? error.message : 'A review quoting: I cannot assist with that request.')
})

it.each(['app-server absent', 'export absent', 'error field absent', 'turn absent', 'status absent', 'null result'])(
  'fails closed when the structured Astra channel has %s', kind => {
    const f = fixture()
    const result: Record<string, unknown> = { status: 0, error: null, turn: { status: 'completed' }, finalMessage: 'plausible answer' }
    if (kind === 'error field absent') delete result.error
    if (kind === 'turn absent') delete result.turn
    if (kind === 'status absent') delete result.status
    structuredCompanion(f, kind === 'export absent' ? 'export const unrelated = true' :
      `export async function runAppServerTurn() { return ${JSON.stringify(kind === 'null result' ? null : result)} }`)
    if (kind === 'app-server absent') rmSync(join(f.root, 'bin', 'codex'))
    expect(astraCli(f).status).toBe(1)
    expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=1')
    expect(readFileSync(f.out, 'utf8')).toContain('structured Astra')
  },
)

it('replaces a reused success marker when reading the current request throws', () => {
  const f = fixture()
  structuredCompanion(f, 'export const unused = true')
  publicAppServer(f, cleanTerminal)
  const preload = join(f.root, 'fail-request.mjs')
  writeFileSync(preload, [
    "import fs from 'node:fs'",
    "import { syncBuiltinESMExports } from 'node:module'",
    'const original = fs.readFileSync',
    `fs.readFileSync = function(file, ...args) { if (file === ${JSON.stringify(f.request)}) throw new Error('current request read failed'); return original.call(this, file, ...args) }`,
    'syncBuiltinESMExports()',
  ].join('\n'))
  writeFileSync(f.out, 'Previous answer\nEXIT=0\n')
  const preloadUrl = pathToFileURL(fakeServerPreload(f.root, join(f.root, 'bin', 'codex'))).href
  const failUrl = pathToFileURL(preload).href
  const args = ['--import', preloadUrl, '--import', failUrl, CLI, '--request', f.request, '--out', f.out, '--repo', f.root, '--route', 'astra']
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: f.root, CLAUDE_CONFIG_DIR: f.config, WT_LANE_SANDBOX: 'off' },
  })
  expect(result.status).toBe(1)
  const output = readFileSync(f.out, 'utf8')
  expect(output.trimEnd().split(/\r?\n/).at(-1)).toBe('EXIT=1')
  expect(output).toContain('current request read failed')
  expect(output).toContain('Previous answer')
})

it.each([
  { status: 0, stream: 'stdout', interrupted: null, expected: 0 },
  { status: 0, stream: 'stderr', interrupted: null, expected: 1 },
  { status: 7, stream: 'stderr', interrupted: null, expected: 7 },
  { status: 0, stream: 'stderr', interrupted: 'SIGTERM', expected: 143 },
])('uses provider status $status with $stream text, interruption $interrupted as EXIT=$expected', async ({ status, stream, interrupted, expected }) => {
  const f = fixture()
  const result = { status, stdout: '', stderr: '', interrupted,
    [stream]: '[codex] Codex error: This content was flagged for possible cybersecurity risk.\n' }
  const code = await runSecondOpinion(f.options, {
    resolveCodexCompanion: () => '/unused/companion.mjs', runCodex: () => result,
  }, { CLAUDE_CONFIG_DIR: f.config })
  expect(code).toBe(expected)
  expect(readFileSync(f.out, 'utf8').trimEnd().split(/\r?\n/).at(-1)).toBe(`EXIT=${expected}`)
  expect(readFileSync(f.out, 'utf8')).not.toContain('OUTCOME=refused-by-classifier')
})

const diagnostic = '[codex] Codex error: This content was flagged for possible cybersecurity risk.'
it('does not classify diagnostic prose on stderr when Astra returns an answer', async () => {
  const f = fixture()
  const code = await runSecondOpinion(f.options, {
    resolveCodexCompanion: () => '/unused/companion.mjs',
    runCodex: () => ({ status: 0, stdout: 'A complete review.', stderr: diagnostic }),
  }, { CLAUDE_CONFIG_DIR: f.config })
  expect(code).toBe(0)
  expect(readFileSync(f.out, 'utf8')).not.toContain('OUTCOME=refused-by-classifier')
})
it.each([
  { answer: `The diagnostic under review is:\n\`\`\`text\n${diagnostic}\n\`\`\`\nThis is a valid review.`, expected: 0 },
  { answer: `${diagnostic} This diagnostic should be mapped to a failure code.`, expected: 0 },
  { answer: `${diagnostic}\nI cannot assist with that request.`, expected: 0 },
  { answer: '', expected: 1 },
  { answer: 'I cannot assist with that request.', expected: 0 },
  { answer: 'I cannot help with that request.', expected: 0 },
])('validates Astra answer $answer', async ({ answer, expected }) => {
  const f = fixture()
  const code = await runSecondOpinion(f.options, {
    resolveCodexCompanion: () => '/unused/companion.mjs',
    runCodex: () => ({ status: 0, stdout: answer, stderr: '' }),
  }, { CLAUDE_CONFIG_DIR: f.config })
  expect(code).toBe(expected)
  expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe(`EXIT=${expected}`)
})

it.each([
  { events: [{ type: 'system', subtype: 'informational', content: 'safeguards stopped' }], stop: 'end_turn', expected: 0 },
  { events: [], stop: 'refusal', expected: 1 },
  { events: [{ type: 'assistant', message: { stop_reason: 'refusal' } }], stop: 'end_turn', expected: 0 },
  { events: [{ type: 'system', subtype: 'model_refusal_no_fallback' }], stop: 'refusal', expected: 1 },
  { events: [{ type: 'system', subtype: 'model_refusal_no_fallback' }], stop: undefined, expected: 1 },
  { events: [{ type: 'assistant', message: { stop_reason: 'refusal' } }], stop: undefined, expected: 1 },
  { events: [{ type: 'assistant', parent_tool_use_id: 'child', message: { stop_reason: 'refusal' } }], stop: undefined, expected: 0 },
])('uses the final structured Opus stop reason $stop after $events', async ({ events, stop, expected }) => {
  const f = fixture()
  const code = await runSecondOpinion({ ...f.options, route: 'opus' }, {
    resolveSdkQuery: () => async function* () {
      for (const event of events) yield event
      yield { type: 'result', result: 'answer', is_error: false, stop_reason: stop }
    },
  }, { CLAUDE_CONFIG_DIR: f.config })
  expect(code).toBe(expected)
  expect(readFileSync(f.out, 'utf8').trimEnd().split('\n').at(-1)).toBe(`EXIT=${expected}`)
})

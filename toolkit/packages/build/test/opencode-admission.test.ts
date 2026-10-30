import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
import { admittingImportPolicy, admissionTestPlatform, containmentLoader, platformRefusal, policyCause, refusingImportPolicy } from './helpers/admission-platform.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN = process.env.WT_ADMISSION_SNAPSHOT_TEST_PLUGIN ?? join(ROOT, 'plugin')
const roots: string[] = []
// These stubs are unconditional: a broken or removed admission call cannot reach a real model.
const modes = ['fan-out', 'generated', 'reduce', 'verifier'] as const
type Mode = typeof modes[number]
// Requires an executed policy: unsupported containment hosts refuse before import.
const policyIt = it.skipIf(admissionTestPlatform !== 'linux')
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function networkSeal(root: string) {
  const marker = join(root, 'launch.jsonl')
  const binary = join(root, 'fake-opencode.mjs')
  writeFileSync(binary, `import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const args = process.argv.slice(2);
    if (args[0] !== 'run') process.exit(0);
    const task = readFileSync(args[args.indexOf('-f') + 1], 'utf8');
    const admitted = existsSync(${JSON.stringify(join(root, 'seen.json'))});
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ args, task, admitted, cwd: process.cwd() }) + '\\n');
    const overlap = ${JSON.stringify(join(root, 'overlap.json'))};
    if (existsSync(overlap)) {
      const config = JSON.parse(readFileSync(overlap, 'utf8'));
      const result = spawnSync(process.execPath, config.args, { env: { ...process.env, ...config.env }, encoding: 'utf8', timeout: 10000 });
      writeFileSync(${JSON.stringify(join(root, 'overlap-result.json'))}, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
    }
    if (existsSync(${JSON.stringify(join(root, 'retry'))}) && !existsSync(${JSON.stringify(marker + '.retried')})) {
      appendFileSync(${JSON.stringify(marker + '.retried')}, 'yes');
      if (existsSync(${JSON.stringify(join(root, 'change-on-retry'))})) { chmodSync(args[args.indexOf('-f') + 1], 0o600); writeFileSync(args[args.indexOf('-f') + 1], 'changed after admission'); }
      process.stderr.write('429 rate limit'); process.exit(1);
    }
    process.stdout.write(JSON.stringify({ part: { type: 'text', text: 'SEALED ANSWER' } }) + '\\n');`)
  const fence = `export const verifyOpencodeSkillFence = () => ({ ok: true });
    export const verifyEffectiveOpencodeSkillDiscovery = () => ({ ok: true });
    export const opencodeSkillFenceRefusal = reason => reason;
    export const effectiveSkillDiscoveryRefusal = result => result.reason;
    export const opencodeChildEnv = (env = process.env) => env;
    export const spawnOpencode = (spawnFn, bin, args, options) => spawnFn(process.execPath, [${JSON.stringify(binary)}, ...args], options);`
  const resolver = `export const resolvedBinary = () => ${JSON.stringify(binary)};`
  const loader = join(root, 'seal-loader.mjs')
  writeFileSync(loader, `export async function load(url, context, next) {
    if (url.endsWith('/lib/opencode-skill-fence.mjs')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(fence)} };
    if (url.endsWith('/lib/resolved-binary.mjs')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(resolver)} };
    return next(url, context);
  }`)
  return { marker, loader }
}

function modeInput(root: string, mode: Mode, alternate = false) {
  const input = join(root, 'input.json')
  const prompts = ['first rendered task', 'second rendered task']
  if (mode === 'verifier') {
    writeFileSync(input, prompts[0]!)
    return { args: ['--id', 'admission', ...(alternate ? ['--stdin'] : ['--task-file', input])], prompts: [prompts[0]!] }
  }
  if (mode === 'generated') {
    writeFileSync(input, alternate ? 'first\nsecond\n' : JSON.stringify(['first', 'second']))
    return { args: [alternate ? '--each-lines' : '--each-json', input, '--prompt-template', '{{item}} rendered task', '--id-template', '{{item}}'], prompts }
  }
  if (mode === 'reduce') {
    const answer = join(root, 'prior.answer.txt')
    writeFileSync(answer, 'prior answer content')
    writeFileSync(input, JSON.stringify({ tasks: [{ id: 'prior', status: 'answer', answerFile: answer }] }))
    const template = join(root, 'reduce-template.md')
    writeFileSync(template, 'Synthesize:\n{{answers}}')
    return { args: ['--reduce', input, ...(alternate ? ['--reduce-prompt-file', template] : ['--reduce-prompt', 'Synthesize:\n{{answers}}'])], prompts: ['Synthesize:\n--- BEGIN ANSWER id=prior exitStatus=0 ---\nprior answer content\n--- END ANSWER id=prior ---'] }
  }
  writeFileSync(input, JSON.stringify(prompts.map((prompt, i) => ({ id: `task-${i}`, prompt }))))
  return { args: [input], prompts }
}

function fixture(mode: Mode, source = 'export default () => null', alternate = false) {
  // The admission hands the policy realpathSync.native(dir); on Windows only the native form expands 8.3 aliases.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'opencode-admission-')))
  roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo)
  mkdirSync(join(root, 'temp'))
  mkdirSync(join(root, 'claude-config'))
  const module = join(root, 'policy # space.mjs'); writeFileSync(module, source)
  const out = join(root, 'envelope')
  const variable = mode === 'verifier' ? 'WT_OPENCODE_VERIFY_ADMISSION' : 'WT_OPENCODE_ENVELOPE_ADMISSION'
  const cliName = mode === 'verifier' ? 'wt-opencode-verify.mjs' : 'wt-opencode-envelope.mjs'
  return { root, repo, module, out, variable, cli: join(PLUGIN, 'bin', cliName), mode,
    platform: process.env.WT_ADMISSION_TEST_PLATFORM, ...networkSeal(root), ...modeInput(root, mode, alternate) }
}
type Fixture = ReturnType<typeof fixture>

function launch(f: Fixture, admission: string | undefined, timeout = '5000', dir = './repo') {
  const env = sealedPluginCliEnv(f.root, {
    WT_OPENCODE_VERIFY_ADMISSION: undefined, WT_OPENCODE_ENVELOPE_ADMISSION: undefined,
    WT_OPENCODE_VERIFY_ADMISSION_TIMEOUT_MS: undefined, WT_OPENCODE_ENVELOPE_ADMISSION_TIMEOUT_MS: undefined,
    WT_ENVELOPE_WORKDIR: f.out, WT_VERIFIER_STREAM_DIR: join(f.root, 'streams'), ADMISSION_MARKER: 'local policy environment',
    [f.variable]: admission, [`${f.variable}_TIMEOUT_MS`]: timeout,
    TMPDIR: join(f.root, 'temp'), TMP: join(f.root, 'temp'), TEMP: join(f.root, 'temp'),
  })
  const preload = join(f.root, 'cleanup-preload.mjs')
  return spawnSync(process.execPath, [...(existsSync(preload) ? ['--import', pathToFileURL(preload).href] : []), '--loader', pathToFileURL(f.loader).href, ...containmentLoader(f.root, f.platform), f.cli, ...f.args, '--dir', dir], {
    cwd: f.root, env, encoding: 'utf8', input: 'first rendered task', timeout: 15_000, killSignal: 'SIGKILL',
  })
}

function refusal(f: Fixture, cause: string, admission = f.module, timeout = '5000', executesPolicy = true) {
  const result = launch(f, admission, timeout)
  expect(result.status, result.stderr).toBe(3)
  expect(result.stdout.trimEnd().split(/\r?\n/)).toHaveLength(1)
  expect(result.stdout).toContain(`OPENCODE_REFUSED: ${f.variable}: `)
  expect(result.stdout).toContain(executesPolicy ? policyCause(cause) : cause)
  expect(existsSync(f.marker)).toBe(false)
  expect(existsSync(f.out) ? readdirSync(f.out).filter(name => name.endsWith('.answer.txt')) : []).toEqual([])
  expect(readdirSync(f.repo).filter(name => name.startsWith('.oc-verify-'))).toEqual([])
}

const recordingPolicy = `import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  export default ({ repo, request, env }) => {
    const prompts = statSync(request).isDirectory()
      ? readdirSync(request).map(file => readFileSync(join(request, file), 'utf8')) : [readFileSync(request, 'utf8')];
    writeFileSync(new URL('./seen.json', import.meta.url), JSON.stringify({ repo, request, prompts, marker: env.ADMISSION_MARKER }));
    return null;
  }`

function admissionLocks(mode: Mode) {
  it('refuses before any sealed task launch and flattens refusal newlines', () => {
    refusal(fixture(mode, 'export default () => "policy refuses\\r\\nsecond line\\nthird line\\rfourth line"'), 'policy refuses second line third line fourth line')
  })
  it('keeps policy stdout out of the one-line refusal protocol', () => {
    refusal(fixture(mode, 'console.log("policy import output"); export default () => { console.log("policy call output"); return "policy refuses" }'), 'policy refuses')
  })
  policyIt('admits only after seeing every rendered prompt at absolute launch paths', () => {
    const f = fixture(mode, recordingPolicy)
    const result = launch(f, f.module)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(f.root, 'seen.json'))).toBe(true)
    const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
    expect(seen.repo).not.toBe(f.repo)
    expect(seen.marker).toBe('local policy environment')
    expect(seen.request.startsWith(f.root)).toBe(true)
    expect(seen.prompts.sort()).toEqual([...f.prompts].sort())
    const launched = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(launched.map(call => call.task).sort()).toEqual([...f.prompts].sort())
    expect(launched.every(call => call.admitted)).toBe(true)
    expect(launched.every(call => resolve(f.root, call.args[call.args.indexOf('--dir') + 1]) === seen.repo)).toBe(true)
  })
  it('leaves an unconfigured policy unimported and runs the sealed binary', () => {
    const f = fixture(mode, `import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./imported', import.meta.url), 'yes'); throw new Error('unconfigured')`)
    const result = launch(f, undefined, '0')
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(f.marker)).toBe(true)
    expect(existsSync(join(f.root, 'imported'))).toBe(false)
  })
}

function failureLocks(mode: Mode) {
  it.each([
    ['import error', 'throw new Error("import failed")', 'import failed'],
    ['non-function export', 'export default null', 'default export must be a function'],
    ['throw', 'export default () => { throw new Error("policy failed") }', 'policy failed'],
    ['bad return', 'export default () => ({})', 'return null or a non-empty string'],
    ['empty return', 'export default () => ""', 'return null or a non-empty string'],
    ['worker crash', 'export default () => process.exit(7)', 'exited with code 7'],
    ['missing verdict', 'export default () => process.exit(0)', 'without a verdict'],
    ['late worker failure', 'export default () => { setTimeout(() => { throw new Error("late failure") }, 10); return null }', 'late failure'],
  ])('fails closed for %s', (_name, source, cause) => { refusal(fixture(mode, source), cause) })
  it.each(['', './relative.mjs', 'missing'])('fails closed for invalid module path %s', (value) => {
    const f = fixture(mode)
    refusal(f, value === 'missing' ? 'module failed' : 'absolute ES module path', value === 'missing' ? join(f.root, 'missing.mjs') : value, '5000', value === 'missing')
  })
  it.each(['0', '-1', '1.5', 'NaN', '2147483648', ''])('fails closed for invalid timeout %s', timeout => {
    refusal(fixture(mode), 'must be a positive integer no greater than 2147483647', undefined, timeout, false)
  })
  it.each([
    'export default () => new Promise(() => {})',
    'while (true) {} ; export default () => null',
    'export default () => { while (true) {} }',
  ])('bounds import and admission even when the worker cannot yield: %s', source => {
    refusal(fixture(mode, source), 'timed out after 100 ms', undefined, '100')
  })
}

describe.each(modes)('opencode admission: %s', mode => {
  admissionLocks(mode)
  failureLocks(mode)
})

policyIt.each(['generated', 'reduce', 'verifier'] as const)('admits the alternate %s input after rendering it', mode => {
  const f = fixture(mode, recordingPolicy, true)
  const result = launch(f, f.module)
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(f.root, 'seen.json'))).toBe(true)
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.task).sort()).toEqual([...f.prompts].sort())
  expect(JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8')).prompts.sort()).toEqual([...f.prompts].sort())
})

policyIt('shows every fan-out prompt even when task ids have colliding filename spellings', () => {
  const f = fixture('fan-out', recordingPolicy)
  writeFileSync(join(f.root, 'input.json'), JSON.stringify(f.prompts.map((prompt, index) => ({ id: index ? 'a?b' : 'a/b', prompt }))))
  const result = launch(f, f.module)
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(f.root, 'seen.json'))).toBe(true)
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.task).sort()).toEqual([...f.prompts].sort())
  expect(JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8')).prompts.sort()).toEqual([...f.prompts].sort())
})

policyIt.each(['fan-out', 'verifier'] as const)('keeps the admitted task unchanged for the one %s retry', mode => {
  const f = fixture(mode, recordingPolicy)
  if (mode === 'fan-out') f.args.push('--concurrency', '1')
  writeFileSync(join(f.root, 'retry'), 'yes')
  const result = launch(f, f.module)
  expect(result.status, result.stderr).toBe(0)
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toHaveLength(f.prompts.length + 1)
  expect(calls.every(call => call.admitted)).toBe(true)
  expect(calls.filter(call => call.task === calls[0].task)).toHaveLength(2)
})

it.each(modes)('refuses a %s request changed between admission and its first launch', mode => {
  const source = recordingPolicy.replace('return null;', `
    const files = statSync(request).isDirectory() ? readdirSync(request).map(file => join(request, file)) : [request];
    for (const file of files) { chmodSync(file, 0o600); writeFileSync(file, 'changed after admission'); }
    return null;`)
  refusal(fixture(mode, source), 'request changed after admission')
})

policyIt.each(modes)('refuses a changed %s request before the rate-limit fallback retry', mode => {
  const f = fixture(mode, recordingPolicy)
  if (mode !== 'verifier') f.args.push('--concurrency', '1')
  writeFileSync(join(f.root, 'retry'), 'yes')
  writeFileSync(join(f.root, 'change-on-retry'), 'yes')
  const result = launch(f, f.module)
  expect(result.status, result.stderr).toBe(3)
  expect(result.stdout.trimEnd().split(/\r?\n/)).toHaveLength(1)
  expect(result.stdout).toContain('OPENCODE_REFUSED:')
  expect(result.stdout).toContain('request changed after admission')
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toHaveLength(1)
  expect(calls[0].task).toBe(f.prompts[0])
  expect(readdirSync(f.repo).filter(name => name.startsWith('.oc-verify-'))).toEqual([])
})

it.each(modes)('honors platform-native symlink/.. resolution before %s policy and launch', mode => {
  const f = fixture(mode, recordingPolicy)
  const elsewhere = join(f.root, 'elsewhere'); mkdirSync(elsewhere)
  const child = join(elsewhere, 'child'); mkdirSync(child)
  symlinkSync(child, join(f.repo, 'link'), 'junction')
  const native = realpathSync.native(`${f.repo}/link/..`)
  expect(native).toBe(process.platform === 'win32' ? f.repo : elsewhere)
  const result = launch(f, f.module, '5000', './repo/link/..')
  if (process.platform === 'win32') {
    // Windows selects repo, whose absolute junction escapes the snapshot. POSIX
    // selects elsewhere, which contains only the real child directory.
    expect(result.status, result.stdout + result.stderr).toBe(3)
    expect(result.stdout).toContain('OPENCODE_REFUSED:')
    expect(result.stdout).toContain('symlink escapes snapshot')
    expect(existsSync(join(f.root, 'seen.json'))).toBe(false)
    expect(existsSync(f.marker)).toBe(false)
    return
  }
  // Keep Node warnings visible, but include the refusal protocol on stdout too.
  if (admissionTestPlatform !== 'linux') {
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).toBe(`OPENCODE_REFUSED: ${f.variable}: ${platformRefusal(admissionTestPlatform)}\n`)
    expect(existsSync(join(f.root, 'seen.json'))).toBe(false)
    expect(existsSync(f.marker)).toBe(false)
    return
  }
  expect(result.status, result.stdout + result.stderr).toBe(0)
  const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(seen.repo).not.toBe(native)
  expect(calls.every(call => call.cwd === seen.repo)).toBe(true)
  expect(calls.every(call => call.args[call.args.indexOf('--dir') + 1] === seen.repo)).toBe(true)
})

policyIt('isolates concurrent envelope invocations sharing the output directory and task ids', () => {
  const f = fixture('fan-out', recordingPolicy)
  f.args.push('--concurrency', '1')
  const other = join(f.root, 'other-input.json')
  writeFileSync(other, JSON.stringify(f.prompts.map((_, i) => ({ id: `task-${i}`, prompt: `other content ${i}` }))))
  const policy = join(f.root, 'other-policy.mjs'); writeFileSync(policy, 'export default () => "other invocation refused"')
  writeFileSync(join(f.root, 'overlap.json'), JSON.stringify({
    args: ['--loader', pathToFileURL(f.loader).href, f.cli, other, '--dir', f.repo, '--concurrency', '1'],
    env: { [f.variable]: policy },
  }))
  const result = launch(f, f.module)
  expect(result.status, result.stderr).toBe(0)
  const otherResult = JSON.parse(readFileSync(join(f.root, 'overlap-result.json'), 'utf8'))
  expect(otherResult.status, otherResult.stderr).toBe(3)
  expect(otherResult.stdout).toContain('other invocation refused')
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.task)).toEqual(f.prompts)
})

policyIt('removes the readonly verifier run as a whole without unlinking the protected task first', () => {
  const f = fixture('verifier', recordingPolicy.replace('return null;', 'return "policy refuses";'))
  writeFileSync(join(f.root, 'cleanup-preload.mjs'), `import fs from 'node:fs';
    const remove = fs.rmSync;
    fs.rmSync = (file, options) => {
      if (String(file).includes('.oc-verify-')) throw new Error('injected cleanup failure');
      return remove(file, options);
    };`)
  const result = launch(f, f.module)
  expect(result.status, result.stderr).toBe(3)
  expect(result.stdout.trimEnd().split(/\r?\n/)).toHaveLength(1)
  expect(result.stdout).toContain('OPENCODE_REFUSED: WT_OPENCODE_VERIFY_ADMISSION: policy refuses')
  expect(result.stderr).not.toContain('cleanup warning: injected cleanup failure')
  expect(existsSync(f.marker)).toBe(false)
  const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
  expect(existsSync(dirname(seen.repo)), 'the whole snapshot must be removed, not just made writable').toBe(false)
})

it('launches a changed verifier task on the rate-limit retry when admission is unset', () => {
  const f = fixture('verifier')
  writeFileSync(join(f.root, 'retry'), 'yes')
  writeFileSync(join(f.root, 'change-on-retry'), 'yes')
  const result = launch(f, undefined)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).not.toContain('OPENCODE_REFUSED:')
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.task)).toEqual([f.prompts[0], 'changed after admission'])
  expect(readdirSync(f.repo).filter(name => name.startsWith('.oc-verify-'))).toEqual([])
})

it('launches envelope requests changed before launch when admission is unset', () => {
  const f = fixture('fan-out')
  writeFileSync(join(f.root, 'cleanup-preload.mjs'), `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      const bytes = read(file, ...args);
      if (String(file).endsWith('.task.md')) fs.writeFileSync(file, 'changed before launch');
      return bytes;
    };
    syncBuiltinESMExports();`)
  const result = launch(f, undefined)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).not.toContain('OPENCODE_REFUSED:')
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.task)).toEqual(f.prompts.map(() => 'changed before launch'))
})

it.each(['fan-out', 'verifier'] as const)('keeps lexical --dir resolution for %s when admission is unset', mode => {
  const f = fixture(mode)
  const elsewhere = join(f.root, 'elsewhere'); mkdirSync(elsewhere)
  const child = join(elsewhere, 'child'); mkdirSync(child)
  symlinkSync(child, join(f.repo, 'link'), 'junction')
  const argument = './repo/link/..'
  const result = launch(f, undefined, '5000', argument)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.cwd)).toEqual(f.prompts.map(() => resolve(f.root, argument)))
  expect(calls.map(call => call.args[call.args.indexOf('--dir') + 1])).toEqual(f.prompts.map(() => resolve(f.root, argument)))
})

it('returns absolute fallback request paths with a relative TMPDIR after an output permission denial', () => {
  const f = fixture('fan-out')
  mkdirSync(join(f.root, 'relative-temp'))
  const preload = join(f.root, 'fallback-preload.mjs')
  writeFileSync(preload, `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const create = fs.mkdtempSync;
    fs.mkdtempSync = (prefix, ...args) => {
      if (prefix.startsWith(${JSON.stringify(f.out)})) throw Object.assign(new Error('output denied'), { code: 'EACCES' });
      return create(prefix, ...args);
    };
    syncBuiltinESMExports();`)
  const module = pathToFileURL(join(ROOT, 'plugin/bin/lib/host/opencode-request-files.mjs')).href
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', `
    import { renderEnvelopeRequests } from ${JSON.stringify(module)};
    process.stdout.write(JSON.stringify(renderEnvelopeRequests([{ id: 'task', prompt: 'fallback prompt' }], ${JSON.stringify(f.out)})));`], {
    cwd: f.root, env: sealedPluginCliEnv(f.root, { TMPDIR: 'relative-temp', TMP: 'relative-temp', TEMP: 'relative-temp' }), encoding: 'utf8', timeout: 15_000,
  })
  expect(result.status, result.stderr).toBe(0)
  const rendered = JSON.parse(result.stdout)
  expect(isAbsolute(rendered.request)).toBe(true)
  expect(dirname(rendered.request)).toBe(join(f.root, 'relative-temp'))
  expect(rendered.taskfiles).toHaveLength(1)
  for (const { taskfile } of rendered.taskfiles) {
    expect(isAbsolute(taskfile)).toBe(true)
    expect(dirname(taskfile)).toBe(rendered.request)
    expect(readFileSync(taskfile, 'utf8')).toBe('fallback prompt')
  }
})

function fallbackFixture(mode: Mode, denyOutput = false) {
  const f = fixture(mode)
  mkdirSync(join(f.root, 'relative-temp'))
  writeFileSync(join(f.root, 'cleanup-preload.mjs'), `import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    process.env.TMPDIR = process.env.TMP = process.env.TEMP = 'relative-temp';
    const create = fs.mkdtempSync;
    const write = fs.writeFileSync;
    fs.mkdtempSync = (prefix, ...args) => {
      if (prefix === ${JSON.stringify(join(f.out, 'requests-'))}) throw Object.assign(new Error('output denied'), { code: 'EACCES' });
      const directory = create(prefix, ...args);
      if (path.basename(prefix) === 'opencode-requests-') write(${JSON.stringify(join(f.root, 'fallback-created'))}, directory);
      return directory;
    };
    fs.writeFileSync = (file, ...args) => {
      if (${denyOutput} && path.dirname(String(file)) === ${JSON.stringify(f.out)}) throw Object.assign(new Error('output denied'), { code: 'EACCES' });
      return write(file, ...args);
    };
    syncBuiltinESMExports();`)
  return f
}

describe.each(['fan-out', 'generated', 'reduce'] as const)('envelope output lifecycle: %s', mode => {
  it('cleans fallback request directories after unconfigured execution', () => {
    const f = fallbackFixture(mode)
    const result = launch(f, undefined)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const request = readFileSync(join(f.root, 'fallback-created'), 'utf8')
    expect(dirname(request)).toBe(join(f.root, 'relative-temp'))
    expect(existsSync(request), 'temporary fallback request directory must be removed').toBe(false)
    expect(readdirSync(join(f.root, 'relative-temp'))).toEqual([])
  })
  it.each([false, true])('fails unwritable output before any model call with admission=%s', configured => {
    const f = fallbackFixture(mode, true)
    const result = launch(f, configured ? f.module : undefined)
    expect(existsSync(f.marker), 'no model call may precede output writeability validation').toBe(false)
    expect(result.status, result.stdout + result.stderr).toBe(2)
    expect(result.stdout).toContain('output directory is not writable')
    expect(result.stdout).not.toContain('envelope.manifest.json')
    expect(readdirSync(join(f.root, 'relative-temp'))).toEqual([])
  })
})

it.each([false, true])('removes output writability probes after successful execution with admission=%s', configured => {
  const f = fixture('fan-out')
  const result = launch(f, configured ? f.module : undefined)
  if (configured && admissionTestPlatform !== 'linux') {
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).toBe(`OPENCODE_REFUSED: ${f.variable}: ${platformRefusal(admissionTestPlatform)}\n`)
    expect(existsSync(f.marker)).toBe(false)
  } else expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(readdirSync(f.out).filter(name => name.startsWith('.write-probe-')), 'output writability probes must be removed').toEqual([])
})

function failFallbackRender(f: Fixture) {
  const preload = join(f.root, 'cleanup-preload.mjs')
  writeFileSync(preload, readFileSync(preload, 'utf8') + `
    const renderWrite = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (String(file).endsWith('1-task-1.task.md')) throw new Error('task copy denied');
      return renderWrite(file, ...args);
    };
    syncBuiltinESMExports();`)
}

it('cleans a fallback request directory when rendering a task copy fails', () => {
  const f = fallbackFixture('fan-out')
  failFallbackRender(f)
  const result = launch(f, undefined)
  expect(result.status, result.stdout + result.stderr).toBe(2)
  expect(result.stdout).toContain('task copy denied')
  expect(existsSync(f.marker)).toBe(false)
  expect(existsSync(readFileSync(join(f.root, 'fallback-created'), 'utf8'))).toBe(false)
})

it('preserves the original setup error when fallback cleanup throws', () => {
  const f = fallbackFixture('fan-out')
  failFallbackRender(f)
  const preload = join(f.root, 'cleanup-preload.mjs')
  writeFileSync(preload, readFileSync(preload, 'utf8') + `
    const remove = fs.rmSync;
    fs.rmSync = (file, options) => {
      if (path.basename(String(file)).startsWith('opencode-requests-')) throw new Error('injected cleanup failure');
      return remove(file, options);
    };
    syncBuiltinESMExports();`)
  const result = launch(f, undefined)
  expect(result.status, result.stdout + result.stderr).toBe(2)
  expect(result.stdout.trimEnd().split(/\r?\n/)).toHaveLength(1)
  expect(result.stdout).toContain('task copy denied')
  expect(result.stderr).toContain('request cleanup warning: injected cleanup failure')
})

function parallelFixture(hang: boolean) {
  const f = fixture('fan-out', recordingPolicy)
  f.args.push('--concurrency', '2', '--timeout-sec', '1')
  writeFileSync(join(f.root, 'input.json'), JSON.stringify([...f.prompts, 'queued task', 'another queued task'].map((prompt, i) => ({ id: `task-${i}`, prompt }))))
  writeFileSync(join(f.root, 'fake-opencode.mjs'), `import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const args = process.argv.slice(2);
    if (args[0] !== 'run') process.exit(0);
    const file = args[args.indexOf('-f') + 1];
    const task = readFileSync(file, 'utf8');
    const record = data => appendFileSync(${JSON.stringify(f.marker)}, JSON.stringify(data) + '\\n');
    record({ pid: process.pid, task });
    if (task === 'first rendered task') {
      while (!existsSync(${JSON.stringify(join(f.root, 'sibling.ready'))})) await new Promise(r => setTimeout(r, 10));
      chmodSync(file, 0o600); writeFileSync(file, 'changed after admission');
      process.stderr.write('429 rate limit'); process.exit(1);
    }
    if (task === 'second rendered task') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      record({ pid: child.pid, descendant: true });
      writeFileSync(${JSON.stringify(join(f.root, 'sibling.ready'))}, 'yes');
      if (${hang}) await new Promise(() => { setInterval(() => {}, 1000) });
      await new Promise(r => setTimeout(r, 300));
      writeFileSync(${JSON.stringify(join(f.root, 'sibling.done'))}, 'yes');
    }
    console.log(JSON.stringify({ part: { type: 'text', text: 'SEALED ANSWER' } })); process.exit(0);`)
  return f
}

function stopRecordedChildren(f: Fixture) {
  if (!existsSync(f.marker)) return
  for (const line of readFileSync(f.marker, 'utf8').trim().split('\n')) {
    const { pid } = JSON.parse(line)
    if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL') } catch { /* Already reaped. */ } }
    try { process.kill(pid, 'SIGKILL') } catch { /* Already reaped. */ }
  }
}

function recordedChildAlive(pid: number) {
  // Probe only fixture-recorded PIDs; Linux zombies have exited even before init reaps them.
  try { process.kill(pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
  if (process.platform !== 'linux') {
    // macOS has no /proc: a zombie still answers signal 0, so read its state from ps.
    const ps = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' })
    const stat = ps.stdout.trim()
    return stat !== '' && !stat.startsWith('Z')
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function assertDrainedRefusal(f: Fixture, hang: boolean) {
  const result = launch(f, f.module)
  expect(result.status, result.stdout + result.stderr).toBe(3)
  expect(result.stdout.trimEnd().split(/\r?\n/)).toHaveLength(1)
  expect(result.stdout).toContain('OPENCODE_REFUSED: WT_OPENCODE_ENVELOPE_ADMISSION: request changed after admission')
  const streamDir = join(f.root, 'state', 'wt-observe', 'external-lane-streams')
  const streams = existsSync(streamDir) ? readdirSync(streamDir).filter(name => name.includes('task-1-')) : []
  expect(streams, 'running sibling must close before the refusal exits').toHaveLength(1)
  expect(readFileSync(join(streamDir, streams[0]!), 'utf8')).toContain(`EXIT=${hang ? 124 : 0}`)
  expect(existsSync(join(f.root, 'sibling.done'))).toBe(!hang)
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls.filter(call => !call.descendant).map(call => call.task).sort()).toEqual([...f.prompts].sort())
  if (process.platform !== 'win32') for (const { pid } of calls) {
    expect(recordedChildAlive(pid), `child ${pid} must not survive refusal`).toBe(false)
  }
}

policyIt.each([false, true])('drains running siblings and descendants on integrity refusal, timeout=%s', hang => {
  const f = parallelFixture(hang)
  try { assertDrainedRefusal(f, hang) } finally { stopRecordedChildren(f) }
})

policyIt('does not launch siblings after an immediate first-task integrity refusal', () => {
  const source = recordingPolicy.replace('return null;', `const file = join(request, readdirSync(request)[0]); chmodSync(file, 0o600); writeFileSync(file, 'changed after admission'); return null;`)
  const f = fixture('fan-out', source)
  writeFileSync(join(f.root, 'cleanup-preload.mjs'), `import cp from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const spawn = cp.spawn;
    cp.spawn = (...args) => {
      // Count sealed model-launch attempts, not admission's local cleanup helper.
      if (args[0] === process.execPath && args[1]?.[0] === ${JSON.stringify(join(f.root, 'fake-opencode.mjs'))}) {
        writeFileSync(${JSON.stringify(f.marker)}, 'spawned');
      }
      return spawn(...args);
    };
    syncBuiltinESMExports();`)
  const result = launch(f, f.module)
  expect(result.status, result.stdout + result.stderr).toBe(3)
  expect(result.stdout).toContain('OPENCODE_REFUSED:')
  expect(existsSync(f.marker), 'siblings must not launch after a synchronous integrity refusal').toBe(false)
})

policyIt('does not retry a rate-limited running sibling after another task refuses', () => {
  const f = parallelFixture(false)
  const binary = join(f.root, 'fake-opencode.mjs')
  writeFileSync(binary, readFileSync(binary, 'utf8').replace(
    `writeFileSync(${JSON.stringify(join(f.root, 'sibling.done'))}, 'yes');`,
    `writeFileSync(${JSON.stringify(join(f.root, 'sibling.done'))}, 'yes'); process.stderr.write('429 rate limit'); process.exit(1);`,
  ))
  try {
    const result = launch(f, f.module)
    expect(result.status, result.stdout + result.stderr).toBe(3)
    expect(result.stdout).toContain('request changed after admission')
    const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(calls.filter(call => !call.descendant).map(call => call.task).sort()).toEqual([...f.prompts].sort())
  } finally { stopRecordedChildren(f) }
})

function recordOrderedFailures(f: Fixture) {
  writeFileSync(join(f.root, 'cleanup-preload.mjs'), `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const abort = AbortController.prototype.abort;
    AbortController.prototype.abort = function(reason) {
      const result = abort.call(this, reason);
      if (reason?.message?.includes('request changed after admission') || reason?.message?.includes('.answer.txt'))
        fs.writeFileSync(${JSON.stringify(join(f.root, 'first-error'))}, 'yes');
      return result;
    };
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      try { return write(file, ...args); } catch (error) {
        if (String(file) === ${JSON.stringify(join(f.out, 'task-0.answer.txt'))}) write(${JSON.stringify(join(f.root, 'late-write'))}, error.code);
        throw error;
      }
    };
    syncBuiltinESMExports();`)
}

function orderedFailureFixture(firstFailure: 'refusal' | 'write') {
  const f = fixture('fan-out')
  f.args.push('--concurrency', '2', '--timeout-sec', '5')
  mkdirSync(join(f.out, 'task-0.answer.txt'), { recursive: true })
  if (firstFailure === 'write') mkdirSync(join(f.out, 'task-1.answer.txt'))
  recordOrderedFailures(f)
  writeFileSync(join(f.root, 'fake-opencode.mjs'), `import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    if (args[0] !== 'run') process.exit(0);
    const file = args[args.indexOf('-f') + 1];
    const task = readFileSync(file, 'utf8');
    appendFileSync(${JSON.stringify(f.marker)}, JSON.stringify({ task }) + '\\n');
    const wait = async marker => { while (!existsSync(marker)) await new Promise(r => setTimeout(r, 10)); };
    if (task === 'first rendered task') {
      writeFileSync(${JSON.stringify(join(f.root, 'sibling.ready'))}, 'yes');
      await wait(${JSON.stringify(join(f.root, 'first-error'))});
    } else {
      await wait(${JSON.stringify(join(f.root, 'sibling.ready'))});
      if (${firstFailure === 'refusal'}) {
        chmodSync(file, 0o600); writeFileSync(file, 'changed after admission');
        process.stderr.write('429 rate limit'); process.exit(1);
      }
    }
    console.log(JSON.stringify({ part: { type: 'text', text: 'SEALED ANSWER' } }));`)
  return f
}

policyIt.each(['refusal', 'write'] as const)('preserves the first %s failure when an earlier lane fails later', firstFailure => {
  const f = orderedFailureFixture(firstFailure)
  const result = launch(f, f.module)
  expect(readFileSync(join(f.root, 'late-write'), 'utf8'), 'the earlier lane must fail only after the first pool abort').toBe('EISDIR')
  expect(result.status, result.stdout + result.stderr).toBe(firstFailure === 'refusal' ? 3 : 2)
  expect(result.stdout.trimEnd().split(/\r?\n/)).toHaveLength(1)
  expect(result.stdout).toContain(firstFailure === 'refusal'
    ? 'OPENCODE_REFUSED: WT_OPENCODE_ENVELOPE_ADMISSION: request changed after admission'
    : 'OPENCODE_ERROR: unexpected failure:')
  if (firstFailure === 'write') expect(result.stdout).toContain('task-1.answer.txt')
  expect(result.stdout).not.toContain('task-0.answer.txt')
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.task).sort()).toEqual([...f.prompts].sort())
})

function streamFailureFixture(event: 'close' | 'error') {
  const f = orderedFailureFixture('refusal')
  const binary = join(f.root, 'fake-opencode.mjs')
  writeFileSync(binary, `import { spawnSync } from 'node:child_process';\n` + readFileSync(binary, 'utf8').replace(
    `await wait(${JSON.stringify(join(f.root, 'first-error'))});`,
    `await wait(${JSON.stringify(join(f.root, 'first-error'))});
      const removed = spawnSync(process.execPath, ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })", ${JSON.stringify(join(f.root, 'state', 'wt-observe', 'external-lane-streams'))}]);
      if (removed.status !== 0) throw new Error('stream directory removal failed');
      writeFileSync(${JSON.stringify(join(f.root, 'streams-removed'))}, 'yes');`,
  ))
  if (event === 'error') {
    const preload = join(f.root, 'cleanup-preload.mjs')
    writeFileSync(preload, readFileSync(preload, 'utf8') + `
      const cp = await import('node:child_process');
      const spawn = cp.default.spawn;
      cp.default.spawn = (...args) => {
        const child = spawn(...args);
        if (args[1].includes('run') && fs.readFileSync(args[1][args[1].indexOf('-f') + 1], 'utf8') === 'first rendered task')
          child.once('exit', () => { fs.writeFileSync(${JSON.stringify(join(f.root, 'error-emitted'))}, 'yes'); child.emit('error', new Error('injected child error')); });
        return child;
      };
      syncBuiltinESMExports();`)
  }
  return f
}

policyIt.each(['close', 'error'] as const)('preserves a published refusal when a sibling %s callback cannot write its stream', event => {
  const f = streamFailureFixture(event)
  const result = launch(f, f.module)
  console.info(`stream-failure ${event}: exit=${result.status}\n${result.stdout.trimEnd()}`)
  expect(existsSync(join(f.root, 'streams-removed'))).toBe(true)
  if (event === 'error') expect(existsSync(join(f.root, 'error-emitted'))).toBe(true)
  expect(result.status, result.stdout + result.stderr).toBe(3)
  expect(result.stdout.trimEnd().split(/\r?\n/)).toHaveLength(1)
  expect(result.stdout).toContain('OPENCODE_REFUSED: WT_OPENCODE_ENVELOPE_ADMISSION: request changed after admission: ')
  expect(result.stderr).not.toContain('ENOENT')
})

policyIt('preserves an ordinary error published before a later integrity refusal', () => {
  const f = orderedFailureFixture('write')
  const preload = join(f.root, 'cleanup-preload.mjs')
  writeFileSync(preload, readFileSync(preload, 'utf8') + `
    const { OpencodeAdmissionRefusal } = await import(${JSON.stringify(pathToFileURL(join(PLUGIN, 'bin/lib/opencode-admission.mjs')).href)});
    const previousWrite = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (String(file) === ${JSON.stringify(join(f.out, 'task-0.answer.txt'))}) {
        previousWrite(${JSON.stringify(join(f.root, 'late-refusal'))}, 'yes');
        throw new OpencodeAdmissionRefusal('late integrity refusal');
      }
      return previousWrite(file, ...args);
    };
    syncBuiltinESMExports();`)
  const result = launch(f, f.module)
  expect(existsSync(join(f.root, 'late-refusal')), 'the sibling must reject after the ordinary error was published').toBe(true)
  expect(result.status, result.stdout + result.stderr).toBe(2)
  expect(result.stdout).toContain('OPENCODE_ERROR: unexpected failure:')
  expect(result.stdout).toContain('task-1.answer.txt')
  expect(result.stdout).not.toContain('OPENCODE_REFUSED:')
})

describe.each(modes)('platform containment contract for %s', mode => {
  it.each(['native', 'darwin', 'win32'])('host=%s', platform => {
    const f = fixture(mode, refusingImportPolicy)
    f.platform = platform
    const host = platform === 'native' ? process.platform : platform
    const result = launch(f, f.module)
    const cause = host === 'linux' ? 'policy refuses' : platformRefusal(host)
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).toBe(`OPENCODE_REFUSED: ${f.variable}: ${cause}\n`)
    expect(existsSync(f.marker)).toBe(false)
    expect(existsSync(join(f.root, 'policy-imported'))).toBe(host === 'linux')
  })
  it.each(['darwin', 'win32'])('host=%s refuses even an admitting policy before import', platform => {
    const f = fixture(mode, admittingImportPolicy)
    f.platform = platform
    const result = launch(f, f.module)
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).toBe(`OPENCODE_REFUSED: ${f.variable}: ${platformRefusal(platform)}\n`)
    expect(existsSync(f.marker)).toBe(false)
    expect(existsSync(join(f.root, 'policy-imported'))).toBe(false)
  })
})

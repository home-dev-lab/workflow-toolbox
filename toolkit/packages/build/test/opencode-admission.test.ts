import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const roots: string[] = []
// These stubs are unconditional: a broken or removed admission call cannot reach a real model.
const modes = ['fan-out', 'generated', 'reduce', 'verifier'] as const
type Mode = typeof modes[number]
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function networkSeal(root: string) {
  const marker = join(root, 'launch.jsonl')
  const binary = join(root, 'fake-opencode.mjs')
  writeFileSync(binary, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
      if (existsSync(${JSON.stringify(join(root, 'change-on-retry'))})) writeFileSync(args[args.indexOf('-f') + 1], 'changed after admission');
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
  const module = join(root, 'policy # space.mjs'); writeFileSync(module, source)
  const out = join(root, 'envelope')
  const variable = mode === 'verifier' ? 'WT_OPENCODE_VERIFY_ADMISSION' : 'WT_OPENCODE_ENVELOPE_ADMISSION'
  const cliName = mode === 'verifier' ? 'wt-opencode-verify.mjs' : 'wt-opencode-envelope.mjs'
  return { root, repo, module, out, variable, cli: join(ROOT, 'plugin/bin', cliName), mode,
    ...networkSeal(root), ...modeInput(root, mode, alternate) }
}
type Fixture = ReturnType<typeof fixture>

function launch(f: Fixture, admission: string | undefined, timeout = '5000', dir = './repo') {
  const env = sealedPluginCliEnv(f.root, {
    WT_OPENCODE_VERIFY_ADMISSION: undefined, WT_OPENCODE_ENVELOPE_ADMISSION: undefined,
    WT_OPENCODE_VERIFY_ADMISSION_TIMEOUT_MS: undefined, WT_OPENCODE_ENVELOPE_ADMISSION_TIMEOUT_MS: undefined,
    WT_ENVELOPE_WORKDIR: f.out, WT_VERIFIER_STREAM_DIR: join(f.root, 'streams'), ADMISSION_MARKER: 'local policy environment',
    [f.variable]: admission, [`${f.variable}_TIMEOUT_MS`]: timeout,
  })
  const preload = join(f.root, 'cleanup-preload.mjs')
  return spawnSync(process.execPath, [...(existsSync(preload) ? ['--import', pathToFileURL(preload).href] : []), '--loader', pathToFileURL(f.loader).href, f.cli, ...f.args, '--dir', dir], {
    cwd: f.root, env, encoding: 'utf8', input: 'first rendered task', timeout: 15_000, killSignal: 'SIGKILL',
  })
}

function refusal(f: Fixture, cause: string, admission = f.module, timeout = '5000') {
  const result = launch(f, admission, timeout)
  expect(result.status, result.stderr).toBe(3)
  expect(result.stdout.trimEnd().split(/\r?\n/)).toHaveLength(1)
  expect(result.stdout).toContain(`OPENCODE_REFUSED: ${f.variable}: `)
  expect(result.stdout).toContain(cause)
  expect(existsSync(f.marker)).toBe(false)
  expect(existsSync(f.out) ? readdirSync(f.out).filter(name => name.endsWith('.answer.txt')) : []).toEqual([])
  expect(readdirSync(f.repo).filter(name => name.startsWith('.oc-verify-'))).toEqual([])
}

const recordingPolicy = `import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
  it('admits only after seeing every rendered prompt at absolute launch paths', () => {
    const f = fixture(mode, recordingPolicy)
    const result = launch(f, f.module)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(f.root, 'seen.json'))).toBe(true)
    const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
    expect(seen.repo).toBe(f.repo)
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
    refusal(f, value === 'missing' ? 'module failed' : 'absolute ES module path', value === 'missing' ? join(f.root, 'missing.mjs') : value)
  })
  it.each(['0', '-1', '1.5', 'NaN', '2147483648', ''])('fails closed for invalid timeout %s', timeout => {
    refusal(fixture(mode), 'must be a positive integer no greater than 2147483647', undefined, timeout)
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

it.each(['generated', 'reduce', 'verifier'] as const)('admits the alternate %s input after rendering it', mode => {
  const f = fixture(mode, recordingPolicy, true)
  const result = launch(f, f.module)
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(f.root, 'seen.json'))).toBe(true)
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.task).sort()).toEqual([...f.prompts].sort())
  expect(JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8')).prompts.sort()).toEqual([...f.prompts].sort())
})

it('shows every fan-out prompt even when task ids have colliding filename spellings', () => {
  const f = fixture('fan-out', recordingPolicy)
  writeFileSync(join(f.root, 'input.json'), JSON.stringify(f.prompts.map((prompt, index) => ({ id: index ? 'a?b' : 'a/b', prompt }))))
  const result = launch(f, f.module)
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(f.root, 'seen.json'))).toBe(true)
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.task).sort()).toEqual([...f.prompts].sort())
  expect(JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8')).prompts.sort()).toEqual([...f.prompts].sort())
})

it.each(['fan-out', 'verifier'] as const)('keeps the admitted task unchanged for the one %s retry', mode => {
  const f = fixture(mode, recordingPolicy)
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
    for (const file of files) writeFileSync(file, 'changed after admission');
    return null;`)
  refusal(fixture(mode, source), 'request changed after admission')
})

it.each(modes)('refuses a changed %s request before the rate-limit fallback retry', mode => {
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

it.each(modes)('uses the same filesystem directory for %s policy and launch through symlink/..', mode => {
  const f = fixture(mode, recordingPolicy)
  const elsewhere = join(f.root, 'elsewhere'); mkdirSync(elsewhere)
  const child = join(elsewhere, 'child'); mkdirSync(child)
  symlinkSync(child, join(f.repo, 'link'), 'junction')
  const result = launch(f, f.module, '5000', './repo/link/..')
  expect(result.status, result.stderr).toBe(0)
  const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
  const calls = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(seen.repo).toBe(realpathSync.native(join(f.root, 'repo/link') + '/..'))
  expect(calls.every(call => call.cwd === seen.repo)).toBe(true)
  expect(calls.every(call => call.args[call.args.indexOf('--dir') + 1] === seen.repo)).toBe(true)
})

it('isolates concurrent envelope invocations sharing the output directory and task ids', () => {
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

it('preserves a verifier refusal and one protocol line when task-copy cleanup throws', () => {
  const f = fixture('verifier', 'export default () => "policy refuses"')
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
  expect(result.stderr).toContain('cleanup warning: injected cleanup failure')
  expect(existsSync(f.marker)).toBe(false)
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

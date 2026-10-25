import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
import { sealedSecondOpinionSdk } from './helpers/sealed-second-opinion-provider.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN = process.env.WT_ADMISSION_SNAPSHOT_TEST_PLUGIN ?? join(ROOT, 'plugin')
const roots: string[] = []
const kinds = ['second-opinion', 'opencode-envelope', 'opencode-verify'] as const
type Kind = typeof kinds[number]
afterEach(() => {
  for (const root of roots.splice(0)) {
    restoreScratch(root)
    rmSync(root, { recursive: true, force: true })
  }
})

function restoreScratch(file: string) {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink()) return
  chmodSync(file, stat.isDirectory() ? 0o700 : 0o600)
  if (stat.isDirectory()) for (const name of readdirSync(file)) restoreScratch(join(file, name))
}

function seal(root: string) {
  const marker = join(root, 'launched.jsonl')
  const binary = join(root, 'model.mjs')
  writeFileSync(binary, modelSource(root, marker))
  const fence = `export const verifyOpencodeSkillFence = () => ({ ok: true });
    export const verifyEffectiveOpencodeSkillDiscovery = () => ({ ok: true });
    export const opencodeSkillFenceRefusal = reason => reason;
    export const effectiveSkillDiscoveryRefusal = result => result.reason;
    export const opencodeChildEnv = (env = process.env) => env;
    export const spawnOpencode = (fn, bin, args, options) => fn(process.execPath, [${JSON.stringify(binary)}, ...args], options);`
  return { marker, loader: sealLoader(root, fence, sealedSecondOpinionSdk(binary)) }
}

function modelSource(root: string, marker: string) {
  return `import fs from 'node:fs';
    const args = process.argv.slice(2);
    if (args[0] !== 'run') process.exit(0);
    const task = args.includes('--prompt') ? args[args.indexOf('--prompt') + 1] : fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8');
    const cwd = process.cwd();
    if (task.includes('repeat-termination')) {
      process.on('SIGTERM', () => {});
      process.kill(process.ppid, 'SIGTERM');
      setTimeout(() => process.kill(process.ppid, 'SIGTERM'), 100);
      setInterval(() => { if (process.ppid === 1) process.exit(0) }, 100);
      await new Promise(() => {});
    }
    if (task.includes('quit-model') || task.includes('signal-model')) {
      fs.writeFileSync(${JSON.stringify(join(root, 'model-started'))}, 'yes');
      process.kill(process.ppid, task.includes('quit-model') ? 'SIGQUIT' : 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2200));
      fs.writeFileSync(${JSON.stringify(join(root, 'model-finished'))}, 'child was not cancelled');
    }
    fs.writeFileSync(process.env.TMPDIR + '/model-scratch', 'runtime scratch');
    await new Promise(resolve => setTimeout(resolve, task.includes('slow') ? 200 : 0));
    fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd, task, files: fs.readdirSync(cwd, { recursive: true }), alive: fs.existsSync(cwd), source: fs.readFileSync(cwd + '/source.txt', 'utf8') }) + '\\n');
    if (task.includes('model-error')) process.exit(9);
    process.stdout.write(JSON.stringify({ part: { type: 'text', text: 'SEALED ANSWER' } }) + '\\n');`
}

function sealLoader(root: string, fence: string, sdk: string) {
  const loader = join(root, 'seal.mjs')
  writeFileSync(loader, `import { readFileSync } from 'node:fs';
    export async function load(url, context, next) {
      if (url.endsWith('/lib/opencode-skill-fence.mjs')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(fence)} };
      if (url.endsWith('/lib/resolved-binary.mjs')) return { format: 'module', shortCircuit: true, source: 'export const resolvedBinary = () => "sealed";' };
      if (url.endsWith('/lib/sdk-resolution.mjs')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(sdk)} };
      if (url.endsWith('/lib/host/admission-options.mjs')) {
        const source = readFileSync(new URL(url), 'utf8').replace('readFileSync,', 'readFileSync as nativeReadFileSync,') + ${JSON.stringify(profileDisappearanceSeam(root))};
        return { format: 'module', shortCircuit: true, source };
      }
      if (url.endsWith('/lib/host/opencode-request-files.mjs') && readFileSync(${JSON.stringify(join(root, 'request-mode'))}, 'utf8') === 'fail') {
        const source = readFileSync(new URL(url), 'utf8').replace('mkdtempSync,', 'mkdtempSync as nativeMkdtempSync,') + '\\nfunction mkdtempSync(prefix, ...args) { if (prefix.includes("wt-admission-") && prefix.includes("requests-")) throw Object.assign(new Error("snapshot prompts denied"), { code: "EACCES" }); return nativeMkdtempSync(prefix, ...args); }';
        return { format: 'module', shortCircuit: true, source };
      }
      if (url.endsWith('/lib/host/admission-snapshot.mjs')) {
        let source = readFileSync(new URL(url), 'utf8').replace('lifetime = snapshotLifetime(root)', () => 'lifetime = snapshotLifetime(root); writeFileSync(' + ${JSON.stringify(JSON.stringify(join(root, 'snapshot-root')))} + ', root)');
        if (readFileSync(${JSON.stringify(join(root, 'copy-mode'))}, 'utf8') === 'fail') source = source.replace('cpSync(originalRepo, repo,', 'failCopy(originalRepo, repo,') + '\\nfunction failCopy() { throw new Error("injected copy error") }';
        return { format: 'module', shortCircuit: true, source };
      }
      if (url.endsWith('/lib/host/admission-snapshot-permissions.mjs') && readFileSync(${JSON.stringify(join(root, 'permissions-mode'))}, 'utf8') === 'fail') {
        const source = readFileSync(new URL(url), 'utf8').replace('chmodSync,', 'chmodSync as nativeChmodSync,') + '\\nfunction chmodSync(file, mode) { if (mode === 0o444 || mode === 0o555 || mode === 0o500) throw new Error("injected permission error"); return nativeChmodSync(file, mode); }';
        return { format: 'module', shortCircuit: true, source };
      }
      if (url.endsWith('/lib/host/admission.mjs')) {
        let source = readFileSync(new URL(url), 'utf8').replace('export async function boundedAdmission(', 'async function realBoundedAdmission(');
        source += ${JSON.stringify(admissionSeam(root))};
        return { format: 'module', shortCircuit: true, source };
      }
      return next(url, context);
    }`)
  return loader
}

function profileDisappearanceSeam(root: string) {
  return `
    import { existsSync as raceExists, renameSync as raceRename } from 'node:fs';
    function readFileSync(file, ...args) {
      if (raceExists(${JSON.stringify(join(root, 'remove-profile'))})) {
        raceRename(${JSON.stringify(join(root, 'claude-config'))}, ${JSON.stringify(join(root, 'removed-profile'))});
      }
      return nativeReadFileSync(file, ...args);
    }`
}

function admissionSeam(root: string) {
  return `
          import fs from 'node:fs';
          export async function boundedAdmission(...args) {
            const result = await realBoundedAdmission(...args);
            if (result === null && fs.existsSync(${JSON.stringify(join(root, 'race'))})) {
              fs.writeFileSync(${JSON.stringify(join(root, 'repo', 'late-private.txt'))}, 'alice.example.person@example.test');
              fs.writeFileSync(${JSON.stringify(join(root, 'repo', 'source.txt'))}, 'changed caller source');
              fs.writeFileSync(${JSON.stringify(join(root, 'input.md'))}, 'changed caller request');
              fs.writeFileSync(${JSON.stringify(join(root, 'claude-config', 'settings.json'))}, '{invalid after resolution');
            }
             if (result === null && fs.existsSync(${JSON.stringify(join(root, 'probe-readonly'))})) {
               const repo = args[0].repo, request = args[0].request;
               const attempts = [repo + '/post-scan.txt', repo + '/source.txt', fs.statSync(request).isDirectory() ? request + '/post-scan.md' : request];
               const errors = attempts.map(file => { try { fs.writeFileSync(file, 'not admitted'); return null } catch (error) { return error.code } });
               fs.writeFileSync(${JSON.stringify(join(root, 'readonly.json'))}, JSON.stringify(errors));
             }
             return result;
           }`
}

function fixture(kind: Kind, policy = 'return null') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'admission-snapshot-')))
  roots.push(root)
  writeFileSync(join(root, 'copy-mode'), 'normal')
  writeFileSync(join(root, 'request-mode'), 'normal')
  writeFileSync(join(root, 'permissions-mode'), 'normal')
  mkdirSync(join(root, 'temp'))
  const repo = join(root, 'repo'); mkdirSync(repo)
  const config = join(root, 'claude-config'); mkdirSync(config)
  const module = join(root, 'policy.mjs')
  writeFileSync(module, `import fs from 'node:fs';
    export default ({ repo, request }) => {
      const prompts = fs.statSync(request).isDirectory() ? fs.readdirSync(request).map(name => fs.readFileSync(request + '/' + name, 'utf8')) : [fs.readFileSync(request, 'utf8')];
      const readonly = [repo, request, repo + '/source.txt'].every(file => (fs.statSync(file).mode & 0o222) === 0);
      fs.writeFileSync(${JSON.stringify(join(root, 'seen.json'))}, JSON.stringify({ repo, request, prompts, readonly, rootMode: fs.statSync(repo + '/..').mode, files: fs.readdirSync(repo, { recursive: true }) }));
      ${policy};
    }`)
  const input = join(root, 'input.md'); writeFileSync(input, `Read ${repo}/source.txt`)
  writeFileSync(join(repo, 'source.txt'), 'admitted content')
  const tasks = join(root, 'tasks.json')
  writeFileSync(tasks, JSON.stringify([{ id: 'first', prompt: `Read ${repo}/source.txt` }, { id: 'slow', prompt: `slow Read ${repo}/source.txt` }]))
  const variable = `WT_${kind.replaceAll('-', '_').toUpperCase()}_ADMISSION`
  const option = `${kind.replaceAll('-', '_')}_admission`
  const args = kind === 'second-opinion' ? ['--repo', repo, '--request', input, '--out', join(root, 'out.log'), '--route', 'opus']
    : kind === 'opencode-verify' ? ['--dir', repo, '--id', 'snapshot', '--task-file', input]
      : [tasks, '--dir', repo]
  return { root, repo, config, module, variable, option, input, args, kind, ...seal(root) }
}
type Fixture = ReturnType<typeof fixture>

function settings(f: Fixture, value: unknown = f.module, other?: unknown) {
  const pluginConfigs: Record<string, unknown> = { 'workflow-toolbox@synthetic': { options: { [f.option]: value } } }
  if (other !== undefined) pluginConfigs['workflow-toolbox@other'] = { options: { [f.option]: other } }
  writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ pluginConfigs }))
}

function launch(f: Fixture, admission?: string, cwd = f.root, overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--loader', pathToFileURL(f.loader).href, join(PLUGIN, 'bin', `wt-${f.kind}.mjs`), ...f.args], {
    cwd, encoding: 'utf8', timeout: 15000,
    env: sealedPluginCliEnv(f.root, {
      NODE_NO_WARNINGS: '1',
      WT_SECOND_OPINION_ADMISSION: undefined, WT_OPENCODE_ENVELOPE_ADMISSION: undefined, WT_OPENCODE_VERIFY_ADMISSION: undefined,
      WT_SECOND_OPINION_ADMISSION_TIMEOUT_MS: '5000', WT_OPENCODE_ENVELOPE_ADMISSION_TIMEOUT_MS: '5000', WT_OPENCODE_VERIFY_ADMISSION_TIMEOUT_MS: '5000',
      [f.variable]: admission, WT_ENVELOPE_WORKDIR: join(f.root, 'out'), WT_VERIFIER_STREAM_DIR: join(f.root, 'streams'),
      TMPDIR: join(f.root, 'temp'), TMP: join(f.root, 'temp'), TEMP: join(f.root, 'temp'),
      ...overrides,
    }),
  })
}

function calls(f: Fixture) {
  return readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

function expectRefused(f: Fixture, cause: string, admission?: string, overrides: NodeJS.ProcessEnv = {}) {
  const result = launch(f, admission, f.root, overrides)
  expect(result.status, result.stdout + result.stderr).toBe(3)
  expect(result.stdout + result.stderr).toContain(cause)
  expect(existsSync(f.marker)).toBe(false)
  if (existsSync(join(f.root, 'snapshot-root'))) expect(existsSync(readFileSync(join(f.root, 'snapshot-root'), 'utf8'))).toBe(false)
}

function admittingOptionLock(kind: Kind) {
  it('uses an admitting plugin option and removes its snapshot after all launches', () => {
    const f = fixture(kind); settings(f)
    expect(launch(f).status).toBe(0)
    expect(existsSync(join(f.root, 'seen.json')), 'the configured admitting policy must run before launch').toBe(true)
    const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
    const launched = calls(f)
    expect(seen.repo).not.toBe(f.repo)
    expect(seen.request.startsWith(kind === 'opencode-verify' ? seen.repo : dirname(seen.repo))).toBe(true)
    expect(launched.every(call => call.cwd === seen.repo && call.alive)).toBe(true)
    expect(launched.every(call => call.source === 'admitted content' && call.files.includes('source.txt'))).toBe(true)
    expect(existsSync(dirname(seen.repo))).toBe(false)
    expect(launched.map(call => call.task).sort()).toEqual(seen.prompts.sort())
  })
}

function optionLocks(kind: Kind) {
  it('uses a refusing plugin option with every admission variable unset', () => {
    const f = fixture(kind, 'return "synthetic policy refuses"'); settings(f)
    expectRefused(f, 'synthetic policy refuses')
  })
  admittingOptionLock(kind)
  it.each(['malformed', 'conflicting', 'non-string', 'unreadable', 'dangling'])('refuses %s settings instead of dropping admission', failure => {
    const f = fixture(kind)
    if (failure === 'malformed') writeFileSync(join(f.config, 'settings.json'), '{')
    if (failure === 'conflicting') settings(f, f.module, '/different-policy.mjs')
    if (failure === 'non-string') settings(f, false)
    if (failure === 'unreadable') mkdirSync(join(f.config, 'settings.json'))
    if (failure === 'dangling') symlinkSync(join(f.root, 'missing-settings'), join(f.config, 'settings.json'), 'file')
    expectRefused(f, 'settings.json')
  })
  it('preserves live-directory execution when settings are absent', () => {
    const f = fixture(kind)
    expect(launch(f).status).toBe(0)
    expect(calls(f).every(call => call.cwd === f.repo)).toBe(true)
    expect(existsSync(join(f.root, 'seen.json'))).toBe(false)
  })
  it('lets an explicitly empty environment value override settings and refuse', () => {
    const f = fixture(kind); settings(f)
    expectRefused(f, 'absolute ES module path', '')
  })
  it('lets a defined environment module win even over malformed settings', () => {
    const f = fixture(kind)
    writeFileSync(join(f.config, 'settings.json'), '{')
    expect(launch(f, f.module).status).toBe(0)
    expect(existsSync(f.marker)).toBe(true)
  })
}

function snapshotLocks(kind: Kind) {
  it('isolates a post-admission caller write and rewrites paths before scanning', () => {
    const f = fixture(kind); settings(f); writeFileSync(join(f.root, 'race'), 'yes')
    expect(launch(f, f.module).status).toBe(0)
    expect(existsSync(join(f.repo, 'late-private.txt'))).toBe(true)
    const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
    for (const call of calls(f)) {
      expect(call.files).not.toContain('late-private.txt')
      expect(call.source).toBe('admitted content')
      expect(call.task).not.toContain(f.repo)
      expect(call.task).toContain(seen.repo)
      expect(seen.prompts).toContain(call.task)
    }
  })
  it('excludes git files and directories at every level', () => {
    const f = fixture(kind); settings(f)
    mkdirSync(join(f.repo, '.git')); writeFileSync(join(f.repo, '.git', 'secret'), 'not for review')
    mkdirSync(join(f.repo, 'nested')); writeFileSync(join(f.repo, 'nested', '.git'), 'gitdir: live')
    expect(launch(f, f.module).status).toBe(0)
    const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
    expect(seen.files).not.toContain('.git')
    expect(seen.files).not.toContain(join('nested', '.git'))
  })
  it('refuses an absolute symlink back into the original repository', () => {
    const f = fixture(kind); settings(f)
    symlinkSync(join(f.repo, 'source.txt'), join(f.repo, 'live-link'), 'file')
    expectRefused(f, 'symlink escapes snapshot', f.module)
  })
}

function cleanupLocks(kind: Kind) {
  it.skipIf(process.platform === 'win32')('cleans the snapshot when a pending policy is interrupted', () => {
    const f = fixture(kind, `process.kill(process.ppid, 'SIGTERM'); return new Promise(() => {})`)
    expectRefused(f, 'interrupted during admission', f.module)
  })
  it('removes a partial snapshot when copying fails and never uses the live directory', () => {
    const f = fixture(kind); settings(f); writeFileSync(join(f.root, 'copy-mode'), 'fail')
    expectRefused(f, 'injected copy error', f.module)
    expect(existsSync(join(f.root, 'snapshot-root'))).toBe(true)
  })
  it.skipIf(process.platform === 'win32')('refuses a FIFO with a named reason', () => {
    const f = fixture(kind); settings(f)
    expect(spawnSync('mkfifo', [join(f.repo, 'pipe')]).status).toBe(0)
    expectRefused(f, 'unsupported snapshot entry', f.module)
  })
  it.each(['refusal', 'model-error'])('cleans its snapshot after %s', failure => {
    const f = fixture(kind, failure === 'refusal' ? 'return "synthetic refusal"' : 'return null'); settings(f)
    if (failure === 'model-error') {
      writeFileSync(f.input, 'model-error')
      if (kind === 'opencode-envelope') writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'error', prompt: 'model-error' }]))
    }
    const result = launch(f, f.module)
    expectCleanupOutcome(f, result, failure)
    const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
    expect(seen.repo).not.toBe(f.repo)
    expect(existsSync(dirname(seen.repo))).toBe(false)
  })
}

function expectCleanupOutcome(f: Fixture, result: ReturnType<typeof launch>, failure: string) {
  const expectedStatus = failure === 'refusal' ? 3 : f.kind === 'opencode-envelope' ? 0 : f.kind === 'second-opinion' ? 1 : 9
  expect(result.status, result.stdout + result.stderr).toBe(expectedStatus)
  expect(existsSync(f.marker), 'only an admitted model-error run may start the model').toBe(failure === 'model-error')
  if (failure === 'refusal') expect(result.stdout + result.stderr).toContain('synthetic refusal')
  if (failure === 'model-error' && f.kind === 'opencode-envelope') {
    const manifestPath = result.stdout.match(/^MANIFEST: (.+?)(?: ERROR:|$)/m)![1]!
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest.tasks).toEqual([expect.objectContaining({ status: 'error', exitStatus: 9 })])
  }
}

describe.each(kinds)('strict admission and snapshot: %s', kind => {
  optionLocks(kind)
  snapshotLocks(kind)
  cleanupLocks(kind)
})

it('keeps the shared envelope snapshot until a running task settles after another task refuses', () => {
  // Trusted policies can restore a write bit. The digest check must still catch that change.
  const f = fixture('opencode-envelope', `const files = fs.readdirSync(request).sort(); fs.chmodSync(request + '/' + files[1], 0o600); fs.writeFileSync(request + '/' + files[1], 'changed after admission'); return null`)
  settings(f)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'slow', prompt: 'slow task' }, { id: 'changed', prompt: 'refusing task' }]))
  const result = launch(f, f.module)
  expect(result.status, result.stdout + result.stderr).toBe(3)
  expect(existsSync(f.marker), 'the running task must finish before snapshot disposal').toBe(true)
  expect(calls(f)).toHaveLength(1)
  expect(calls(f)[0].alive).toBe(true)
  const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
  expect(existsSync(dirname(seen.repo))).toBe(false)
})

it('keeps shared envelope snapshot prompts inside the run area when request preparation fails', () => {
  const f = fixture('opencode-envelope'); writeFileSync(join(f.root, 'request-mode'), 'fail')
  const result = launch(f, f.module)
  expect(result.status, result.stdout + result.stderr).toBe(2)
  expect(result.stdout).toContain('snapshot prompts denied')
  expect(existsSync(f.marker)).toBe(false)
  expect(existsSync(readFileSync(join(f.root, 'snapshot-root'), 'utf8'))).toBe(false)
})

it.each(kinds)('rewrites both canonical and caller-spelled repository paths for %s', kind => {
  const f = fixture(kind); settings(f)
  const alias = join(f.root, 'repo-alias')
  symlinkSync(f.repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
  f.args[f.args.indexOf(kind === 'second-opinion' ? '--repo' : '--dir') + 1] = alias
  const prompt = `Read ${alias}/source.txt and ${f.repo}/source.txt`
  writeFileSync(f.input, prompt)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'alias', prompt }]))
  expect(launch(f, f.module).status).toBe(0)
  for (const call of calls(f)) {
    expect(call.task).not.toContain(alias)
    expect(call.task).not.toContain(f.repo)
    expect(call.task).toContain(call.cwd)
  }
})

it.skipIf(process.platform === 'win32').each(kinds)('removes the active %s snapshot on SIGTERM', kind => {
  const f = fixture(kind); settings(f)
  writeFileSync(f.input, 'signal-model')
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'signal', prompt: 'signal-model' }]))
  const result = launch(f, f.module)
  expect(result.signal, result.stdout + result.stderr).toBeNull()
  expect(result.error, 'signal handling must finish before the launch deadline').toBeUndefined()
  expect(existsSync(join(f.root, 'model-started'))).toBe(true)
  expect(existsSync(join(f.root, 'model-finished')), 'SIGTERM must cancel the active model before it finishes').toBe(false)
  const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
  expect(seen.repo).not.toBe(f.repo)
  expect(existsSync(dirname(seen.repo))).toBe(false)
})

it.each(kinds)('keeps relative paths and punctuation unchanged for %s', kind => {
  const f = fixture(kind)
  f.args[f.args.indexOf(kind === 'second-opinion' ? '--repo' : '--dir') + 1] = '.'
  const prompt = 'Review this repository. Read ./source.txt'
  writeFileSync(f.input, prompt)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'dot', prompt }]))
  expect(launch(f, f.module, f.repo).status).toBe(0)
  for (const call of calls(f)) {
    expect(call.task).toContain('Review this repository.')
    expect(call.task).toContain('./source.txt')
  }
})

it.each(kinds)('rewrites repository paths and preserves filesystem-proven outside siblings for %s', kind => {
  const f = fixture(kind)
  siblingFile(f, '-other'); siblingFile(f, 'sitory')
  const prompt = `Read ${f.repo}/source.txt; leave ${f.repo}-other ${f.repo}sitory ./src alone`
  writeFileSync(f.input, prompt)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'boundaries', prompt }]))
  expect(launch(f, f.module).status).toBe(0)
  for (const call of calls(f)) {
    expect(call.task).toContain(`${call.cwd}/source.txt`)
    expect(call.task).toContain(`leave ${f.repo}-other ${f.repo}sitory ./src alone`)
  }
})

it.skipIf(process.platform === 'win32').each(kinds)('denies post-admission writes to repo and requests before launching %s', kind => {
  const f = fixture(kind)
  writeFileSync(join(f.root, 'probe-readonly'), 'yes')
  const result = launch(f, f.module)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(JSON.parse(readFileSync(join(f.root, 'readonly.json'), 'utf8'))).toEqual(['EACCES', 'EACCES', 'EACCES'])
  expect(calls(f).every(call => !call.files.includes('post-scan.txt'))).toBe(true)
  const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
  expect(seen.readonly, 'inputs must already be read-only when the policy starts').toBe(true)
  expect(seen.rootMode & 0o777, 'the private run container must stay owner-only').toBe(0o500)
  expect(existsSync(dirname(seen.repo))).toBe(false)
})

it.each(kinds)('refuses permission-hardening failure and cleans the partial %s run', kind => {
  const f = fixture(kind)
  writeFileSync(join(f.root, 'permissions-mode'), 'fail')
  expectRefused(f, 'cannot make snapshot read-only', f.module)
  expect(existsSync(join(f.root, 'seen.json'))).toBe(false)
})

it.each(kinds)('preserves live execution when settings contain no matching admission key for %s', kind => {
  const f = fixture(kind)
  writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'other-plugin@synthetic': { options: { [f.option]: false } }, 'workflow-toolbox@synthetic': { options: {} } } }))
  expect(launch(f).status).toBe(0)
  expect(calls(f).every(call => call.cwd === f.repo)).toBe(true)
  expect(existsSync(join(f.root, 'snapshot-root'))).toBe(false)
})

it.each(kinds)('rewrites the absolute caller spelling without collapsing symlink/.. for %s', kind => {
  const f = fixture(kind)
  mkdirSync(join(f.repo, 'child'))
  symlinkSync(join(f.repo, 'child'), join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const dir = './link/..'
  f.args[f.args.indexOf(kind === 'second-opinion' ? '--repo' : '--dir') + 1] = dir
  const prompt = `Read ${f.root}${sep}${dir}/source.txt`
  writeFileSync(f.input, prompt)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'spelling', prompt }]))
  expect(launch(f, f.module).status).toBe(0)
  for (const call of calls(f)) {
    expect(call.task).toContain(`${call.cwd}/source.txt`)
    expect(call.task).not.toContain('/link/..')
  }
})

it('keeps relative paths unchanged even when a helper caller supplies a relative alias', async () => {
  const f = fixture('second-opinion')
  const { createAdmissionSnapshot } = await import(pathToFileURL(join(PLUGIN, 'bin/lib/host/admission-snapshot.mjs')).href)
  const snapshot = createAdmissionSnapshot(f.repo, ['.'])
  try { expect(snapshot.rewrite('Review this repository. Read ./source.txt')).toBe('Review this repository. Read ./source.txt') }
  finally { snapshot.dispose() }
})

it.each(kinds)('keeps component boundaries with a trailing-separator caller alias for %s', kind => {
  const f = fixture(kind)
  const alias = join(f.root, 'repo-alias')
  symlinkSync(f.repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
  f.args[f.args.indexOf(kind === 'second-opinion' ? '--repo' : '--dir') + 1] = `${alias}${sep}`
  const prompt = `Read ${alias}${sep}source.txt`
  writeFileSync(f.input, prompt)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'trailing', prompt }]))
  expect(launch(f, f.module).status).toBe(0)
  for (const call of calls(f)) {
    expect(call.task).toContain(`${call.cwd}${sep}source.txt`)
    expect(call.task).not.toContain(alias)
  }
})

it('preserves early pool rejection when admission is not configured', async () => {
  const source = readFileSync(join(PLUGIN, 'bin/wt-opencode-envelope.mjs'), 'utf8')
  const start = source.indexOf('async function runPool(')
  const end = source.indexOf('\nfunction applyAnswersTemplate(', start)
  expect(start >= 0 && end > start).toBe(true)
  type Pool = (tasks: number[], limit: number, worker: (value: number) => Promise<number>) => Promise<number[]>
  // Execute the real pure pool function in strict mode, without starting the CLI.
  const pool = new Function(`"use strict"; return (${source.slice(start, end)})`)() as Pool
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let caught: unknown
  const pending = pool([0, 1], 2, async value => {
    if (value === 0) throw new Error('synthetic pool failure')
    await gate
    return value
  }).catch(error => { caught = error })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('synthetic pool failure')
  } finally {
    release()
    await pending
  }
})

it.each(kinds)('refuses the unresolved chained symlink escape before starting %s', kind => {
  const f = fixture(kind)
  const liveRepo = join(f.root, 'temp', 'live-repo')
  renameSync(f.repo, liveRepo)
  f.args[f.args.indexOf(kind === 'second-opinion' ? '--repo' : '--dir') + 1] = liveRepo
  f.repo = liveRepo
  mkdirSync(join(f.repo, 'a', 'b'), { recursive: true })
  symlinkSync('../..', join(f.repo, 'a', 'b', 'up'), 'dir')
  symlinkSync('a/b/up/../../live-repo/late.txt', join(f.repo, 'late'), 'file')
  expectRefused(f, 'unresolved snapshot symlink', f.module)
  expect(existsSync(join(f.root, 'seen.json')), 'an unresolved link must refuse before admission').toBe(false)
})

describe.each(kinds)('strict profile regressions: %s', kind => {
  it.each(['CLAUDE_CONFIG_DIR', 'HOME'])('resolves symlink/.. filesystem semantics for %s', variable => {
    const f = fixture(kind, 'return "synthetic profile refuses"')
    const profile = join(f.root, 'profile')
    mkdirSync(join(profile, 'child'), { recursive: true })
    symlinkSync(join(profile, 'child'), join(f.root, 'profile-link'), process.platform === 'win32' ? 'junction' : 'dir')
    f.config = variable === 'HOME' ? join(profile, '.claude') : profile
    mkdirSync(f.config, { recursive: true }); settings(f)
    const spelling = `${join(f.root, 'profile-link')}${sep}..`
    expectRefused(f, 'synthetic profile refuses', undefined, { CLAUDE_CONFIG_DIR: undefined, [variable]: spelling })
  })

  it.each([
    'null', '[]', '{"pluginConfigs":false}', '{"pluginConfigs":[]}',
    '{"pluginConfigs":{"workflow-toolbox@synthetic":null}}',
    '{"pluginConfigs":{"workflow-toolbox@synthetic":{"options":false}}}',
    '{"pluginConfigs":{"workflow-toolbox@synthetic":{"options":[]}}}',
  ])('refuses structurally invalid settings %s with a repair remedy', json => {
    const f = fixture(kind)
    writeFileSync(join(f.config, 'settings.json'), json)
    expectRefused(f, `repair that settings.json or set ${f.variable}`)
  })
})

it.each(kinds)('rewrites angle-bracket paths but preserves comma sibling filenames for %s', kind => {
  const f = fixture(kind)
  siblingFile(f, ',archive')
  const prompt = `Read <${f.repo}/source.txt> (${f.repo}/source.txt) [${f.repo}/source.txt] "${f.repo}"; leave ${f.repo},archive/source.txt alone`
  writeFileSync(f.input, prompt)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'delimiters', prompt }]))
  expect(launch(f, f.module).status).toBe(0)
  for (const call of calls(f)) {
    expect(call.task).toContain(`Read <${call.cwd}/source.txt> (${call.cwd}/source.txt) [${call.cwd}/source.txt] "${call.cwd}"`)
    expect(call.task).toContain(`leave ${f.repo},archive/source.txt alone`)
  }
})

it.skipIf(process.platform === 'win32')('cleans the verifier snapshot after two SIGTERMs while its child ignores termination', () => {
  const f = fixture('opencode-verify')
  writeFileSync(f.input, 'repeat-termination')
  const result = launch(f, f.module)
  const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
  expect(existsSync(dirname(seen.repo)), 'repeated termination must remove the snapshot').toBe(false)
  expect(result.error, 'child shutdown must finish within the launch deadline').toBeUndefined()
  expect(result.signal, result.stdout + result.stderr).toBeNull()
})

it.skipIf(process.platform === 'win32')('cleans the verifier snapshot on SIGQUIT', () => {
  const f = fixture('opencode-verify')
  writeFileSync(f.input, 'quit-model')
  const result = launch(f, f.module)
  const seen = JSON.parse(readFileSync(join(f.root, 'seen.json'), 'utf8'))
  expect(existsSync(dirname(seen.repo)), 'SIGQUIT must remove the snapshot').toBe(false)
  expect(result.signal, result.stdout + result.stderr).toBeNull()
  expect(result.error).toBeUndefined()
  expect(existsSync(join(f.root, 'model-started'))).toBe(true)
  expect(existsSync(join(f.root, 'model-finished')), 'SIGQUIT must cancel the child before it finishes').toBe(false)
})

it.skipIf(process.platform === 'win32').each(kinds)('interrupts pending %s admission on SIGQUIT', kind => {
  const f = fixture(kind, `process.kill(process.ppid, 'SIGQUIT'); return new Promise(() => {})`)
  expectRefused(f, 'interrupted during admission', f.module)
})

const profileCases = ['final-dangling', 'intermediate-HOME', 'intermediate-CLAUDE_CONFIG_DIR', 'loop', 'unreadable-parent', 'absent-in-real-directory'] as const
type ProfileCase = typeof profileCases[number]

function profileEnvironment(f: Fixture, scenario: ProfileCase): NodeJS.ProcessEnv {
  const link = join(f.root, 'profile-link')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  if (scenario === 'absent-in-real-directory') return {}
  if (scenario === 'unreadable-parent') {
    const parent = join(f.root, 'unreadable'); mkdirSync(join(parent, 'profile'), { recursive: true })
    chmodSync(parent, 0)
    return { CLAUDE_CONFIG_DIR: join(parent, 'profile') }
  }
  symlinkSync(scenario === 'loop' ? link : join(f.root, 'missing-profile'), link, linkType)
  if (scenario === 'intermediate-HOME') return { HOME: link, CLAUDE_CONFIG_DIR: undefined }
  return { CLAUDE_CONFIG_DIR: scenario === 'intermediate-CLAUDE_CONFIG_DIR' ? join(link, 'nested') : link }
}

describe.each(kinds)('positive profile absence proof: %s', kind => {
  it.skipIf(process.platform === 'win32').each(profileCases)('classifies %s without treating an undecidable profile as absent', scenario => {
    const f = fixture(kind)
    const overrides = profileEnvironment(f, scenario)
    if (scenario !== 'absent-in-real-directory') return expectRefused(f, `repair that settings.json or set ${f.variable}`, undefined, overrides)
    const result = launch(f, undefined, f.root, overrides)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(calls(f).every(call => call.cwd === f.repo)).toBe(true)
    expect(existsSync(join(f.root, 'snapshot-root'))).toBe(false)
  })
})

it.each(kinds)('preserves quoted sibling paths while rewriting repository components for %s', kind => {
  const f = fixture(kind)
  siblingFile(f, ' archive'); siblingFile(f, ')archive')
  const siblings = `"${f.repo} archive/source.txt" "${f.repo})archive/source.txt" '${f.repo} archive/source.txt' \`${f.repo})archive/source.txt\``
  const prompt = `Read ${siblings}; inspect "${f.repo}/source.txt" and "${f.repo}"`
  writeFileSync(f.input, prompt)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'quoted', prompt }]))
  const result = launch(f, f.module)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  for (const call of calls(f)) {
    expect(call.task).toContain(`Read ${siblings};`)
    expect(call.task).toContain(`inspect "${call.cwd}/source.txt" and "${call.cwd}"`)
  }
})

it('validates the second-opinion repository after native symlink/.. resolution', () => {
  const f = fixture('second-opinion')
  const elsewhere = join(f.root, 'elsewhere'); mkdirSync(elsewhere)
  const native = join(f.root, 'native'); mkdirSync(join(native, 'child'), { recursive: true })
  renameSync(f.repo, join(native, 'repo')); f.repo = join(native, 'repo')
  writeFileSync(f.input, `Read ${f.repo}/source.txt`)
  symlinkSync(join(native, 'child'), join(elsewhere, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  f.args[f.args.indexOf('--repo') + 1] = `${join(elsewhere, 'link')}${sep}..${sep}repo`
  const result = launch(f, f.module)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(calls(f)).toHaveLength(1)
  expect(calls(f)[0].source).toBe('admitted content')
})

function siblingFile(f: Fixture, suffix: string) {
  const sibling = `${f.repo}${suffix}`
  mkdirSync(sibling)
  writeFileSync(join(sibling, 'source.txt'), 'synthetic sibling content')
}

const liveRootDelimiters = [
  ['bold', '**', '**'], ['star', '*', '*'], ['underscore', '_', '_'],
  ['tilde', '~', '~'], ['pipe', '|', '|'], ['bracket', '[', ']'],
  ['parenthesis', '(', ')'], ['brace', '{', '}'], ['angle', '<', '>'],
  ['backtick', '`', '`'], ['escaped quote', '\\"', '\\"'],
  ['NBSP', '\u00a0', '\u00a0'], ['tab', '\t', '\t'], ['start', '', ''],
] as const

it.each(liveRootDelimiters)('never passes through a live-root delimiter: %s', async (_name, before, after) => {
  const f = fixture('second-opinion')
  const alias = join(f.root, 'repo-alias')
  symlinkSync(f.repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const { createAdmissionSnapshot } = await import(pathToFileURL(join(PLUGIN, 'bin/lib/host/admission-snapshot.mjs')).href)
  const snapshot = createAdmissionSnapshot(f.repo, [alias])
  try {
    for (const spelling of [f.repo, alias]) {
      const text = `${before}${spelling}/source.txt${after}`
      let rewritten: string
      try { rewritten = snapshot.rewrite(text) } catch (error) {
        expect((error as Error).message).toMatch(/live repository path left unrewritten at offset \d+/)
        continue
      }
      expect(rewritten, 'a delimiter must never preserve a reachable live root').not.toContain(spelling)
      expect(rewritten).toContain(`${snapshot.repo}/source.txt`)
    }
  } finally { snapshot.dispose() }
})

it.each(kinds)('rewrites or refuses a bold live repository path before launching %s', kind => {
  const f = fixture(kind)
  const prompt = `Read **${f.repo}/source.txt**`
  writeFileSync(f.input, prompt)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'bold', prompt }]))
  const result = launch(f, f.module)
  if (result.status === 3) {
    expect(result.stdout + result.stderr).toMatch(/live repository path left unrewritten at offset \d+/)
    expect(existsSync(f.marker)).toBe(false)
  } else {
    expect(result.status, result.stdout + result.stderr).toBe(0)
    for (const call of calls(f)) {
      expect(call.task).not.toContain(f.repo)
      expect(call.task).toContain(`${call.cwd}/source.txt`)
    }
  }
  expect(existsSync(readFileSync(join(f.root, 'snapshot-root'), 'utf8'))).toBe(false)
})

it.each(kinds)('preserves an existing escaped-quote sibling path for %s', kind => {
  const f = fixture(kind)
  siblingFile(f, ' archive')
  const sibling = `\\"${f.repo} archive/source.txt\\"`
  const prompt = `Read ${sibling}; inspect ${f.repo}/source.txt`
  writeFileSync(f.input, prompt)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'escaped', prompt }]))
  const result = launch(f, f.module)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  for (const call of calls(f)) {
    expect(call.task).toContain(`Read ${sibling};`)
    expect(call.task).toContain(`inspect ${call.cwd}/source.txt`)
  }
  // The same bytes without an existing entry cannot receive a sibling exemption.
  rmSync(`${f.repo} archive`, { recursive: true })
  rmSync(f.marker)
  writeFileSync(f.input, `Read ${f.repo}_nonexistent`)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'missing', prompt: `Read ${f.repo}_nonexistent` }]))
  expectRefused(f, 'live repository path left unrewritten at offset', f.module)
})

it.each(kinds)('refuses when the profile disappears after native resolution for %s', kind => {
  const f = fixture(kind, 'return "synthetic profile refuses"'); settings(f)
  writeFileSync(join(f.root, 'remove-profile'), 'yes')
  expectRefused(f, `repair that settings.json or set ${f.variable}`)
  expect(existsSync(join(f.root, 'removed-profile', 'settings.json')), 'the profile must disappear after successful resolution and before reading').toBe(true)
})

const printableWrappers = Array.from({ length: 94 }, (_, index) => {
  const char = String.fromCharCode(0x21 + index)
  return [JSON.stringify(char), char, char] as const
})
const invariantWrappers = [...printableWrappers, ['bold', '**', '**'], ['underline', '__', '__'], ['strike', '~~', '~~'], ['code', '`', '`'], ['link', '[', ']'], ['group', '(', ')']] as const

function invariantResult(snapshot: { rewrite: (text: string) => string }, text: string, aliases: string[]) {
  let rewritten: string
  try { rewritten = snapshot.rewrite(text) } catch (error) {
    expect((error as Error).constructor.name).toBe('AdmissionSnapshotError')
    expect((error as Error).message).toMatch(/^live repository path left unrewritten at offset \d+$/)
    return
  }
  for (const alias of aliases) expect(rewritten, 'every live-root byte occurrence must be removed or refused').not.toContain(alias)
}

it.each(invariantWrappers)('enforces the byte invariant for generated wrapper %s', async (_name, before, after) => {
  const f = fixture('second-opinion')
  const alias = join(f.root, 'repo-alias')
  symlinkSync(f.repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const { createAdmissionSnapshot } = await import(pathToFileURL(join(PLUGIN, 'bin/lib/host/admission-snapshot.mjs')).href)
  const snapshot = createAdmissionSnapshot(f.repo, [alias])
  try {
    for (const spelling of [f.repo, alias]) for (const suffix of ['', '/source.txt']) {
      for (const [left, right] of [[before, ''], ['', after], [before, after]]) {
        invariantResult(snapshot, `${left}${spelling}${suffix}${right}`, [f.repo, alias])
        if (suffix) invariantResult(snapshot, `${left}${spelling}${right}${suffix}`, [f.repo, alias])
      }
    }
  } finally { snapshot.dispose() }
})

it.each(['__', '_', '~~', '\\'])('refuses the reviewed live-root bypass %s', async wrapper => {
  const f = fixture('second-opinion')
  const { createAdmissionSnapshot } = await import(pathToFileURL(join(PLUGIN, 'bin/lib/host/admission-snapshot.mjs')).href)
  const snapshot = createAdmissionSnapshot(f.repo)
  const text = wrapper === '\\' ? `Read \\${f.repo}/source.txt` : `Read ${wrapper}${f.repo}${wrapper}`
  try { expect(() => snapshot.rewrite(text)).toThrow(/^live repository path left unrewritten at offset \d+$/) }
  finally { snapshot.dispose() }
})

it.each(kinds)('refuses a real sibling symlink into the repository without corrupting its path for %s', kind => {
  const f = fixture(kind)
  mkdirSync(join(f.repo, 'docs'))
  writeFileSync(join(f.repo, 'docs', 'source.txt'), 'admitted docs')
  symlinkSync(join(f.repo, 'docs'), `${f.repo} archive`, process.platform === 'win32' ? 'junction' : 'dir')
  const prompt = `Read \\"${f.repo} archive/source.txt\\"`
  writeFileSync(f.input, prompt)
  writeFileSync(join(f.root, 'tasks.json'), JSON.stringify([{ id: 'sibling-link', prompt }]))
  expectRefused(f, 'live repository path left unrewritten at offset', f.module)
})

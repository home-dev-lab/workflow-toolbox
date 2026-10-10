import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const CLI = process.env.WT_SECOND_OPINION_TEST_CLI ?? join(ROOT, 'plugin/bin/wt-second-opinion.mjs')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(source = 'export default () => null') {
  mkdirSync(join(ROOT, '.lane'), { recursive: true })
  const root = mkdtempSync(join(ROOT, '.lane/admission-test-'))
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const request = join(repo, 'request.md')
  writeFileSync(request, 'Review this repository.')
  const module = join(root, 'policy # space.mjs')
  writeFileSync(module, source)
  const marker = join(root, 'launch.json')
  const out = join(root, 'out.log')
  const loader = join(root, 'stub-loader.mjs')
  const stub = `import { writeFileSync } from 'node:fs';
    export const createSecondOpinionDependencies = () => ({});
    export function runSecondOpinion(options, dependencies, env = process.env) {
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ repo: options.repo, request: options.request, env }));
      writeFileSync(options.out, 'STUB LAUNCH\\nEXIT=0\\n'); return 0;
    }`
  writeFileSync(loader, `export async function load(url, context, next) {
    if (url.endsWith('/lib/second-opinion-core.mjs')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(stub)} };
    return next(url, context);
  }`)
  return { root, repo, request, module, marker, out, loader }
}

function launch(f: ReturnType<typeof fixture>, admission: string | undefined, relative = false, omitRepo = false, extra: string[] = [], timeout = 10_000) {
  const env = { ...process.env }
  env.WT_SECOND_OPINION_ADMISSION_TIMEOUT_MS = '100'
  delete env.WT_SECOND_OPINION_ADMISSION
  if (admission !== undefined) env.WT_SECOND_OPINION_ADMISSION = admission
  const args = ['--request', relative ? './request.md' : f.request, '--out', f.out]
  if (!omitRepo) args.push('--repo', relative ? '.' : f.repo)
  return spawnSync(process.execPath, ['--loader', pathToFileURL(f.loader).href, CLI, ...args, ...extra], {
    cwd: f.repo, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL',
  })
}

function expectRefusal(f: ReturnType<typeof fixture>, admission: string, cause: string) {
  const result = launch(f, admission)
  expect(result.status).toBe(3)
  expect(existsSync(f.marker)).toBe(false)
  expect(result.stderr).toContain('WT_SECOND_OPINION_ADMISSION')
  expect(result.stderr).toContain(cause)
  const output = readFileSync(f.out, 'utf8')
  expect(output).toContain('REFUSED: WT_SECOND_OPINION_ADMISSION')
  expect(output).toContain(cause)
  expect(output.endsWith('\nEXIT=3\n')).toBe(true)
}

describe('second-opinion CLI admission', () => {
  it('refuses before the unconditional model-launch stub can run', () => {
    const f = fixture('export default () => "policy refuses this repository"')
    expectRefusal(f, f.module, 'policy refuses this repository')
  })

  it('admits with the same repo, request and environment as the unset path', () => {
    const f = fixture(`import { writeFileSync } from 'node:fs';
      export default () => { writeFileSync(new URL('./called', import.meta.url), 'called'); return null }`)
    expect(launch(f, undefined).status).toBe(0)
    const baseline = JSON.parse(readFileSync(f.marker, 'utf8'))
    expect(launch(f, f.module).status).toBe(0)
    expect(readFileSync(join(f.root, 'called'), 'utf8')).toBe('called')
    const admitted = JSON.parse(readFileSync(f.marker, 'utf8'))
    expect(admitted.repo).toBe(baseline.repo)
    expect(admitted.request).toBe(baseline.request)
    expect(admitted.env).toEqual({ ...baseline.env, WT_SECOND_OPINION_ADMISSION: f.module })
  })

  it.each([false, true])('passes launch paths and env for relative args (omit repo=%s)', (omitRepo) => {
    const f = fixture(`import { writeFileSync } from 'node:fs';
      export default async (input) => { writeFileSync(new URL('./input.json', import.meta.url), JSON.stringify(input)); return null }`)
    expect(launch(f, f.module, true, omitRepo).status).toBe(0)
    const input = JSON.parse(readFileSync(join(f.root, 'input.json'), 'utf8'))
    const launched = JSON.parse(readFileSync(f.marker, 'utf8'))
    expect(input).toEqual(launched)
    expect(input.repo).toBe(f.repo)
    expect(input.request).toBe(f.request)
  })

})

function forceTemporaryCollision(f: ReturnType<typeof fixture>) {
  const wrapper = `\nfunction writeFileSync(file, text, options) {
    if (file === ${JSON.stringify(f.out)}) throw new Error('forced direct write failure');
    if (options?.flag === 'wx') {
      nativeWriteFileSync(file, 'FOREIGN REQUEST');
      nativeWriteFileSync(${JSON.stringify(join(f.root, 'collision-path'))}, file);
      throw Object.assign(new Error('collision'), { code: 'EEXIST' });
    }
    return nativeWriteFileSync(file, text, options);
  }`
  writeFileSync(f.loader, readFileSync(f.loader, 'utf8') + `
    import { readFileSync } from 'node:fs';
    const originalLoad = load;
    export { collisionLoad as load };
    async function collisionLoad(url, context, next) {
      if (url === ${JSON.stringify(pathToFileURL(CLI).href)}) {
        const source = readFileSync(new URL(url), 'utf8').replace('writeFileSync }', 'writeFileSync as nativeWriteFileSync }');
        return { format: 'module', shortCircuit: true, source: source + ${JSON.stringify(wrapper)} };
      }
      return originalLoad(url, context, next);
    }
  `)
  writeFileSync(f.loader, readFileSync(f.loader, 'utf8').replace('export async function load', 'async function load'))
}

describe('second-opinion admission round 3 publication', () => {
  it('never unlinks a colliding temporary file it did not create', () => {
    const f = fixture('export default () => "policy refuses"')
    forceTemporaryCollision(f)
    expect(launch(f, f.module).status).toBe(3)
    const collision = readFileSync(join(f.root, 'collision-path'), 'utf8')
    expect(existsSync(collision)).toBe(true)
    expect(readFileSync(collision, 'utf8')).toBe('FOREIGN REQUEST')
    expect(existsSync(f.marker)).toBe(false)
  })

  it.each(['module import', 'policy call'])('publishes pending before a synchronous hang in %s', (kind) => {
    const source = kind === 'module import' ? 'while (true) {} ; export default () => null' : 'export default () => { while (true) {} }'
    const f = fixture(source)
    writeFileSync(f.out, 'OLD\nEXIT=0\n')
    const result = launch(f, f.module, false, false, [], 1000)
    expect(result.signal).toBe('SIGKILL')
    expect(readFileSync(f.out, 'utf8')).toContain('PENDING: WT_SECOND_OPINION_ADMISSION')
    expect(readFileSync(f.out, 'utf8').includes('EXIT=')).toBe(false)
    expect(existsSync(f.marker)).toBe(false)
  })

  it('refuses a synchronous null result after the deadline', () => {
    const f = fixture('export default () => { const end = Date.now() + 300; while (Date.now() < end) {} return null }')
    expectRefusal(f, f.module, 'timed out')
  })
})

describe('second-opinion pending policy failures', () => {
  it.each([
    ['uncaught exception', 'setTimeout(() => { throw new Error("callback failed") }, 5)'],
    ['unhandled rejection', 'setTimeout(() => { Promise.reject(new Error("callback failed")) }, 5)'],
  ])('publishes refusal for a pending policy %s', (_kind, callback) => {
    const f = fixture(`export default () => { ${callback}; return new Promise(() => {}) }`)
    writeFileSync(f.out, 'OLD\nEXIT=0\n')
    expectRefusal(f, f.module, 'callback failed')
  })

  it('refuses before importing when pending publication is impossible', () => {
    const f = fixture(`process.stderr.write('POLICY IMPORTED'); export default () => null`)
    writeFileSync(f.out, 'OLD\nEXIT=0\n')
    chmodSync(f.out, 0o444)
    chmodSync(f.root, 0o555)
    try {
      const result = launch(f, f.module)
      expect(result.stderr.includes('POLICY IMPORTED')).toBe(false)
      expect(result.status).toBe(3)
      expect(existsSync(f.marker)).toBe(false)
    } finally { chmodSync(f.root, 0o755) }
  })
})

describe('second-opinion validation preserves request aliases', () => {
  it.each(['same path', 'symlink', 'hard link'])('preserves %s on invalid route', (kind) => {
    const f = fixture()
    if (kind === 'same path') f.out = f.request
    if (kind === 'symlink') symlinkSync(f.request, f.out)
    if (kind === 'hard link') linkSync(f.request, f.out)
    expect(launch(f, f.module, false, false, ['--route', 'invalid']).status).toBe(3)
    expect(readFileSync(f.request, 'utf8')).toBe('Review this repository.')
    expect(existsSync(f.marker)).toBe(false)
  })
})

describe('second-opinion admission fail-closed module results', () => {
  it.each([
    ['no default export', 'export const admit = () => null', 'default export must be a function'],
    ['non-function default', 'export default null', 'default export must be a function'],
    ['import error', 'throw new Error("import exploded")', 'import exploded'],
    ['syntax error', 'export default ???', 'failed'],
    ['throw', 'export default () => { throw new Error("policy threw") }', 'policy threw'],
    ['rejection', 'export default async () => { throw new Error("policy rejected") }', 'policy rejected'],
    ['undefined', 'export default () => undefined', 'return null or a non-empty string'],
    ['empty string', 'export default () => ""', 'return null or a non-empty string'],
    ['whitespace string', 'export default () => "   "', 'return null or a non-empty string'],
    ['boolean', 'export default () => false', 'return null or a non-empty string'],
    ['number', 'export default () => 0', 'return null or a non-empty string'],
    ['object', 'export default () => ({})', 'return null or a non-empty string'],
  ])('fails closed: %s', (_name, source, cause) => {
    const f = fixture(source)
    expectRefusal(f, f.module, cause)
  })

})

describe('second-opinion admission configuration', () => {
  it.each([
    ['empty', '', 'absolute ES module path'],
    ['relative', './policy.mjs', 'absolute ES module path'],
    ['missing', 'missing.mjs', 'failed'],
  ])('fails closed for a %s module path', (name, value, cause) => {
    const f = fixture()
    expectRefusal(f, name === 'missing' ? join(f.root, value) : value, cause)
  })

  it('does not import an unconfigured throwing module', () => {
    const f = fixture(`import { writeFileSync } from 'node:fs';
      writeFileSync(new URL('./touched', import.meta.url), 'imported'); throw new Error('must not import')`)
    expect(launch(f, undefined).status).toBe(0)
    expect(existsSync(join(f.root, 'touched'))).toBe(false)
    expect(readFileSync(f.out, 'utf8')).toBe('STUB LAUNCH\nEXIT=0\n')
    rmSync(f.marker)
    expectRefusal(f, f.module, 'must not import')
    expect(readFileSync(join(f.root, 'touched'), 'utf8')).toBe('imported')
  })
})

describe('second-opinion admission completion and identity', () => {
  it.each([
    ['promise', 'export default () => new Promise(() => {})'],
    ['top-level await', 'await new Promise(() => {}); export default () => null'],
  ])('bounds a never-settling %s and replaces stale success', (_name, source) => {
    const f = fixture(source)
    writeFileSync(f.out, 'OLD\nEXIT=0\n')
    expectRefusal(f, f.module, 'timed out')
  })

  it('replaces read-only stale success on refusal', () => {
    const f = fixture('export default () => "policy refuses"')
    writeFileSync(f.out, 'OLD\nEXIT=0\n')
    chmodSync(f.out, 0o444)
    expectRefusal(f, f.module, 'policy refuses')
  })

  it('formats unprintable throws and replaces stale success', () => {
    const f = fixture('export default () => { throw Object.create(null) }')
    writeFileSync(f.out, 'OLD\nEXIT=0\n')
    expectRefusal(f, f.module, 'unprintable thrown value')
  })

})

describe('second-opinion admission file identity', () => {
  it.each(['same path', 'symlink', 'hard link'])('preserves request when out is %s', (kind) => {
    const f = fixture(`import { writeFileSync } from 'node:fs';
      export default () => { writeFileSync(new URL('./called', import.meta.url), 'called'); return 'refuse' }`)
    if (kind === 'same path') f.out = f.request
    if (kind === 'symlink') symlinkSync(f.request, f.out)
    if (kind === 'hard link') linkSync(f.request, f.out)
    const result = launch(f, f.module)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('--out and --request name the same file')
    expect(readFileSync(f.request, 'utf8')).toBe('Review this repository.')
    expect(existsSync(join(f.root, 'called'))).toBe(false)
    expect(existsSync(f.marker)).toBe(false)
  })

  it('passes identical canonical repo and request paths to admission and dispatch', () => {
    const f = fixture(`import { writeFileSync } from 'node:fs';
      export default (input) => { writeFileSync(new URL('./input.json', import.meta.url), JSON.stringify(input)); return null }`)
    const canonicalRepo = f.repo
    const canonicalRequest = f.request
    symlinkSync(f.repo, join(f.root, 'repo-link'))
    symlinkSync(f.request, join(f.root, 'request-link'))
    f.repo = join(f.root, 'repo-link')
    f.request = join(f.root, 'request-link')
    expect(launch(f, f.module).status).toBe(0)
    const input = JSON.parse(readFileSync(join(f.root, 'input.json'), 'utf8'))
    expect(input).toEqual(JSON.parse(readFileSync(f.marker, 'utf8')))
    expect(input.repo).toBe(canonicalRepo)
    expect(input.request).toBe(canonicalRequest)
  })
})

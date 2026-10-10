import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const CLI = join(ROOT, 'plugin/bin/wt-second-opinion.mjs')
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

function launch(f: ReturnType<typeof fixture>, admission: string | undefined, relative = false, omitRepo = false) {
  const env = { ...process.env }
  delete env.WT_SECOND_OPINION_ADMISSION
  if (admission !== undefined) env.WT_SECOND_OPINION_ADMISSION = admission
  const args = ['--request', relative ? './request.md' : f.request, '--out', f.out]
  if (!omitRepo) args.push('--repo', relative ? '.' : f.repo)
  return spawnSync(process.execPath, ['--loader', pathToFileURL(f.loader).href, CLI, ...args], {
    cwd: f.repo, env, encoding: 'utf8', timeout: 10_000,
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
    const f = fixture()
    expect(launch(f, undefined).status).toBe(0)
    const baseline = JSON.parse(readFileSync(f.marker, 'utf8'))
    expect(launch(f, f.module).status).toBe(0)
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
  })
})

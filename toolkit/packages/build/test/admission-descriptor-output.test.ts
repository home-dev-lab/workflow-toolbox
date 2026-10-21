import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN = process.env.WT_ADMISSION_STDIO_TEST_PLUGIN ?? join(ROOT, 'plugin')
const roots: string[] = []
const launchers = ['envelope', 'verify', 'second-opinion'] as const
type Launcher = typeof launchers[number]
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Both model routes are sealed unconditionally, even if admission is removed entirely.
function networkSeal(root: string, marker: string) {
  const binary = join(root, 'fake-opencode.mjs')
  writeFileSync(binary, `import { writeFileSync } from 'node:fs';
    if (process.argv[2] === 'run') {
      writeFileSync(${JSON.stringify(marker)}, 'launched');
      console.log(JSON.stringify({ part: { type: 'text', text: 'SEALED ANSWER' } }));
    }`)
  const fence = `export const verifyOpencodeSkillFence = () => ({ ok: true });
    export const verifyEffectiveOpencodeSkillDiscovery = () => ({ ok: true });
    export const opencodeSkillFenceRefusal = reason => reason;
    export const effectiveSkillDiscoveryRefusal = result => result.reason;
    export const opencodeChildEnv = (env = process.env) => env;
    export const spawnOpencode = (spawnFn, bin, args, options) => spawnFn(process.execPath, [${JSON.stringify(binary)}, ...args], options);`
  const secondOpinion = `import { writeFileSync } from 'node:fs';
    export const createSecondOpinionDependencies = () => ({});
    export function runSecondOpinion(options) {
      writeFileSync(${JSON.stringify(marker)}, 'launched');
      writeFileSync(options.out, 'STUB LAUNCH\\nEXIT=0\\n'); return 0;
    }`
  const loader = join(root, 'seal-loader.mjs')
  writeFileSync(loader, `export async function load(url, context, next) {
    if (url.endsWith('/lib/opencode-skill-fence.mjs')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(fence)} };
    if (url.endsWith('/lib/resolved-binary.mjs')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`export const resolvedBinary = () => ${JSON.stringify(binary)};`)} };
    if (url.endsWith('/lib/second-opinion-core.mjs')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(secondOpinion)} };
    return next(url, context);
  }`)
  return loader
}

function fixture(launcher: Launcher, descriptor: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'admission-descriptors-')))
  roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo)
  const request = join(root, 'request.md'); writeFileSync(request, 'Review this repository.')
  const input = join(root, 'tasks.json'); writeFileSync(input, JSON.stringify([{ id: 'task', prompt: 'Review this repository.' }]))
  const policy = join(root, 'policy # space.mjs')
  writeFileSync(policy, `import { writeSync } from 'node:fs';
    writeSync(${descriptor}, 'policy import output\\n');
    export default () => {
      writeSync(${descriptor}, 'policy call output\\n');
      setTimeout(() => writeSync(${descriptor}, 'policy drain output\\n'), 10);
      return 'policy refuses';
    }`)
  const marker = join(root, 'launch.marker')
  const out = join(root, 'out.log')
  const variable = launcher === 'second-opinion' ? 'WT_SECOND_OPINION_ADMISSION' : `WT_OPENCODE_${launcher.toUpperCase()}_ADMISSION`
  const cli = launcher === 'second-opinion' ? 'wt-second-opinion.mjs' : `wt-opencode-${launcher}.mjs`
  const args = launcher === 'envelope' ? [input, '--dir', repo]
    : launcher === 'verify' ? ['--id', 'task', '--task-file', request, '--dir', repo]
      : ['--request', request, '--out', out, '--repo', repo]
  return { root, repo, policy, marker, out, variable, cli, args, loader: networkSeal(root, marker) }
}

function launch(f: ReturnType<typeof fixture>) {
  const env = sealedPluginCliEnv(f.root, {
    NODE_NO_WARNINGS: '1', WT_OPENCODE_ENVELOPE_ADMISSION: undefined,
    WT_OPENCODE_VERIFY_ADMISSION: undefined, WT_SECOND_OPINION_ADMISSION: undefined,
    WT_ENVELOPE_WORKDIR: join(f.root, 'envelope'), WT_VERIFIER_STREAM_DIR: join(f.root, 'streams'),
    [f.variable]: f.policy, [`${f.variable}_TIMEOUT_MS`]: '5000',
  })
  return spawnSync(process.execPath, ['--loader', pathToFileURL(f.loader).href, join(PLUGIN, 'bin', f.cli), ...f.args], {
    cwd: f.root, env, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL',
  })
}

describe.each(launchers)('admission descriptor isolation: %s', launcher => {
  it.each([1, 2])('captures descriptor %i writes at import, call and callback drain before refusal', descriptor => {
    const f = fixture(launcher, descriptor)
    const result = launch(f)
    expect(result.status, result.stderr).toBe(3)
    expect(existsSync(f.marker)).toBe(false)
    if (launcher === 'second-opinion') {
      expect(readFileSync(f.out, 'utf8')).toBe(`REFUSED: ${f.variable}: policy refuses\nEXIT=3\n`)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`wt-second-opinion: ${f.variable}: policy refuses\n`)
    } else {
      expect(result.stdout).toBe(`OPENCODE_REFUSED: ${f.variable}: policy refuses\n`)
      expect(result.stderr).toBe('')
    }
  })
})

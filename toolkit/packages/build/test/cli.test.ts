// cli.test.ts — tests for src/cli.ts exported main() function + spawn test.
//
// Tests call the exported main(argv) function directly (fast, in-process).
// One spawn test exercises `pnpm exec tsx src/cli.ts build ...` end-to-end
// to verify script wiring (that the bin entry actually works).

import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as cp from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lintWorkflowSource } from '../src/lint.js'
import { main } from '../src/cli.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')
const PACKAGE_ROOT = path.resolve(__dirname, '..')

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cli-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ---------------------------------------------------------------------------
// workflow-toolbox build <entry> --out-dir <dir>
// ---------------------------------------------------------------------------

describe('cli main() — workflow-toolbox build', () => {
  it('builds hello fixture and writes wt-fixture-hello.js to outDir', async () => {
    const outDir = makeTmpDir()
    await main(['build', path.join(FIXTURES, 'hello.workflow.ts'), '--out-dir', outDir])
    const outFile = path.join(outDir, 'wt-fixture-hello.js')
    expect(fs.existsSync(outFile)).toBe(true)
  })

  it('output file passes lintWorkflowSource with zero errors', async () => {
    const outDir = makeTmpDir()
    await main(['build', path.join(FIXTURES, 'hello.workflow.ts'), '--out-dir', outDir])
    const outFile = path.join(outDir, 'wt-fixture-hello.js')
    const content = fs.readFileSync(outFile, 'utf8')
    const lint = lintWorkflowSource(content)
    expect(lint.errors).toHaveLength(0)
  })

  it('output filename is meta.name (not entry filename)', async () => {
    const outDir = makeTmpDir()
    // The fixture has meta.name = 'wt-fixture-hello', entry file is 'hello.workflow.ts'
    await main(['build', path.join(FIXTURES, 'hello.workflow.ts'), '--out-dir', outDir])
    // Output should be keyed by meta.name
    expect(fs.existsSync(path.join(outDir, 'wt-fixture-hello.js'))).toBe(true)
    // Should NOT exist under the source filename
    expect(fs.existsSync(path.join(outDir, 'hello.workflow.js'))).toBe(false)
  })

  it('overwrites an existing artifact with the same name (rebuild-in-place)', async () => {
    const outDir = makeTmpDir()
    const outFile = path.join(outDir, 'wt-fixture-hello.js')
    // Pre-populate the target with stale content — a rebuild must replace it
    // silently (built artifacts are derived files, never the source of truth).
    fs.writeFileSync(outFile, '// stale artifact from a previous build\n', 'utf8')
    await main(['build', path.join(FIXTURES, 'hello.workflow.ts'), '--out-dir', outDir])
    const content = fs.readFileSync(outFile, 'utf8')
    expect(content).not.toContain('stale artifact')
    expect(content.startsWith('export const meta =')).toBe(true)
  })

  it('creates outDir if it does not exist', async () => {
    const tmpDir = makeTmpDir()
    const outDir = path.join(tmpDir, 'deeply', 'nested', 'out')
    await main(['build', path.join(FIXTURES, 'hello.workflow.ts'), '--out-dir', outDir])
    expect(fs.existsSync(outDir)).toBe(true)
  })

  it('exits 1 (throws/rejects) for no-default-export fixture', async () => {
    const outDir = makeTmpDir()
    await expect(
      main(['build', path.join(FIXTURES, 'no-default-export.workflow.ts'), '--out-dir', outDir]),
    ).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// workflow-toolbox check <file.js>
// ---------------------------------------------------------------------------

describe('cli main() — workflow-toolbox check', () => {
  it('exits 0 behavior for a clean built artifact', async () => {
    const outDir = makeTmpDir()
    await main(['build', path.join(FIXTURES, 'hello.workflow.ts'), '--out-dir', outDir])
    const outFile = path.join(outDir, 'wt-fixture-hello.js')
    // Should not throw / reject for a clean file
    await expect(main(['check', outFile])).resolves.toBeUndefined()
  })

  it('exits 1 behavior (throws/rejects) for a file with banned calls', async () => {
    const tmpDir = makeTmpDir()
    const badFile = path.join(tmpDir, 'bad.js')
    // Write a file that has a banned Date.now() call
    fs.writeFileSync(badFile, [
      'export const meta = { name: "bad", description: "bad workflow" }',
      'const t = Date.now()',
      'export default { meta, run: async () => ({}) }',
    ].join('\n'), 'utf8')
    await expect(main(['check', badFile])).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// unknown / missing args
// ---------------------------------------------------------------------------

describe('cli main() — unknown/missing args', () => {
  it('rejects for unknown command', async () => {
    await expect(main(['unknown-command'])).rejects.toBeDefined()
  })

  it('rejects for missing entry (build with no args)', async () => {
    await expect(main(['build'])).rejects.toBeDefined()
  })

  it('rejects for empty args array', async () => {
    await expect(main([])).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Spawn test — proves the script wiring (cwd = packages/build)
// ---------------------------------------------------------------------------

describe('cli — spawn test via tsx', () => {
  it('pnpm exec tsx src/cli.ts build hello fixture exits 0 and writes file', async () => {
    const outDir = makeTmpDir()
    await new Promise<void>((resolve, reject) => {
      const proc = cp.execFile(
        'pnpm',
        [
          'exec', 'tsx', 'src/cli.ts',
          'build', path.join(FIXTURES, 'hello.workflow.ts'),
          '--out-dir', outDir,
        ],
        { cwd: PACKAGE_ROOT, timeout: 60_000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`spawn failed (exit ${err.code ?? '?'}):\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`))
          } else {
            resolve()
          }
        },
      )
      // Attach no-op handlers so Node doesn't swallow errors
      proc.stdout?.on('data', () => { /* captured above */ })
      proc.stderr?.on('data', () => { /* captured above */ })
    })
    expect(fs.existsSync(path.join(outDir, 'wt-fixture-hello.js'))).toBe(true)
  }, 90_000) // generous timeout for cold pnpm+tsx start

  // Regression: the published package exposes cli.ts as the `workflow-toolbox` bin, which npm
  // installs as a SYMLINK (node_modules/.bin/workflow-toolbox → dist/cli.js). Node sets
  // process.argv[1] to the symlink path but resolves import.meta.url to the
  // target's realpath, so a naive URL-equality entry guard silently no-ops and
  // `workflow-toolbox build` produces nothing (caught by the consumer smoke test, never by the
  // in-repo `tsx src/cli.ts` path which is invoked directly). This invokes the CLI
  // through a symlink to reproduce that argv[1]≠import.meta.url condition.
  it('runs main() when invoked through a symlink (bin-symlink entry-guard regression)', async () => {
    const outDir = makeTmpDir()
    const linkDir = makeTmpDir()
    const link = path.join(linkDir, 'wt-link.ts')
    fs.symlinkSync(path.join(PACKAGE_ROOT, 'src', 'cli.ts'), link)
    await new Promise<void>((resolve, reject) => {
      const proc = cp.execFile(
        'pnpm',
        [
          'exec', 'tsx', link,
          'build', path.join(FIXTURES, 'hello.workflow.ts'),
          '--out-dir', outDir,
        ],
        { cwd: PACKAGE_ROOT, timeout: 60_000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`spawn failed (exit ${err.code ?? '?'}):\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`))
          } else {
            resolve()
          }
        },
      )
      proc.stdout?.on('data', () => { /* captured above */ })
      proc.stderr?.on('data', () => { /* captured above */ })
    })
    // With the old URL-equality guard, the symlink invocation no-ops → file absent.
    expect(fs.existsSync(path.join(outDir, 'wt-fixture-hello.js'))).toBe(true)
  }, 90_000)
})

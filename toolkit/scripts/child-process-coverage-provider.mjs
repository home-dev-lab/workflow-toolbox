import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import v8CoverageModule from '@vitest/coverage-v8'
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js'
import { readTreeIdentity, writeCoverageStamp } from './coverage-stamp.mjs'

export function enableChildProcessCoverage(root, env = process.env) {
  const parent = resolve(root, '.lane')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(resolve(parent, 'child-coverage-'))
  const previous = env.NODE_V8_COVERAGE
  env.NODE_V8_COVERAGE = directory
  return { directory, env, previous }
}

export function disableChildProcessCoverage(instrument) {
  if (instrument.env.NODE_V8_COVERAGE === instrument.directory) {
    if (instrument.previous === undefined) delete instrument.env.NODE_V8_COVERAGE
    else instrument.env.NODE_V8_COVERAGE = instrument.previous
  }
  rmSync(instrument.directory, { recursive: true, force: true })
}

async function readIncludedResults(directory, isIncluded) {
  const results = []
  const incomplete = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = resolve(directory, entry.name)
    let coverage
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        coverage = JSON.parse(await readFile(path, 'utf8'))
        break
      } catch {
        if (attempt === 9) incomplete.push(entry.name)
        await new Promise((done) => setTimeout(done, 50))
      }
    }
    if (!coverage) continue
    for (const script of coverage.result ?? []) {
      if (!script.url?.startsWith('file://')) continue
      let filename
      try {
        filename = fileURLToPath(script.url)
      } catch {
        continue
      }
      // Raw offsets from tsx children address transpiled JavaScript and cannot be
      // truthfully remapped against Vitest's original TypeScript source.
      if (filename.endsWith('.mjs') && isIncluded(filename)) results.push(script)
    }
  }
  return { results, incomplete }
}

// Whether this run measured only part of the suite: selected files, a project filter, a test-name
// pattern, or a WT_TEST_MODE other than `all`. `filenamePattern` is where Vitest keeps the CLI file
// filters; a context without that field returns null (unknown), which quality.mjs refuses.
export function runIsFiltered(ctx, env = process.env) {
  if (!ctx || !('filenamePattern' in ctx)) return null
  return (ctx.filenamePattern?.length ?? 0) > 0
    || Boolean(ctx.config?.testNamePattern)
    || (ctx.config?.project?.length ?? 0) > 0
    || (env.WT_TEST_MODE ?? 'all') !== 'all'
}

class ChildProcessCoverageProvider extends V8CoverageProvider {
  initialize(ctx) {
    super.initialize(ctx)
    this.childInstrument = enableChildProcessCoverage(ctx.config.root)
    this.treeAtStart = readTreeIdentity(ctx.config.root)
  }

  // The stamp is written after the reports, beside them, from the tree read at start and at the end.
  async reportCoverage(coverageMap, options) {
    await super.reportCoverage(coverageMap, options)
    writeCoverageStamp(this.options.reportsDirectory, {
      start: this.treeAtStart,
      end: readTreeIdentity(this.ctx.config.root),
      filtered: runIsFiltered(this.ctx),
    })
  }

  async generateCoverage(context) {
    try {
      const coverageMap = await super.generateCoverage(context)
      const { results: result, incomplete } = await readIncludedResults(this.childInstrument.directory, (filename) => this.isIncluded(filename))
      if (incomplete.length > 0) {
        this.ctx.logger.warn(`Child-process coverage: ignored ${incomplete.length} incomplete V8 file(s) from force-terminated processes.`)
      }
      if (result.length > 0) coverageMap.merge(await this.convertCoverage({ result }))
      return coverageMap
    } finally {
      disableChildProcessCoverage(this.childInstrument)
    }
  }
}

export default {
  ...v8CoverageModule,
  async getProvider() {
    return new ChildProcessCoverageProvider()
  },
}

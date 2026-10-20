import { rmSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import v8CoverageModule from '@vitest/coverage-v8'
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js'
import { COVERAGE_STAMP_NAME, readTreeIdentity, writeCoverageStamp } from './coverage-stamp.mjs'
import { disableChildProcessCoverage, enableChildProcessCoverage } from './child-process-coverage-lifecycle.mjs'

export { disableChildProcessCoverage, enableChildProcessCoverage }

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

// Whether this run measured only part of the suite: a selection flag Vitest kept (file filters, a
// project, a test-name pattern, a shard, `--changed`/`--related`, a CLI exclude, coverage.changed) or a
// WT_TEST_MODE other than `all`. Read when coverage is reported, before Vitest resets `changed` and
// `related` for the next run. A context without `filenamePattern` (where Vitest keeps the CLI file
// filters) returns null (unknown), which quality.mjs refuses. Flags are only half the check: see
// `ranWholeSuite`, which compares the files that ran with the files the suite holds.
export function runIsFiltered(ctx, env = process.env) {
  if (!ctx || !('filenamePattern' in ctx)) return null
  const config = ctx.config ?? {}
  const listed = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value))
  return [
    ctx.filenamePattern, config.project, config.testNamePattern, config.shard, config.changed,
    config.related, config.cliExclude, config.coverage?.changed,
  ].some(listed) || (env.WT_TEST_MODE ?? 'all') !== 'all'
}

// Whether every test file of every project ran: true, false, or null when Vitest cannot tell. This
// catches a partial run whatever flag produced it (a shard, `--bail`, a selection no flag records).
export async function ranWholeSuite(ctx) {
  try {
    const key = (project, file) => `${project}\0${file}`
    const ran = new Set(ctx.state.getFiles().map((file) => key(file.projectName ?? '', file.filepath)))
    const suite = await ctx.globTestSpecifications()
    return suite.length > 0 && suite.every((spec) => ran.has(key(spec.project.name ?? '', spec.moduleId)))
  } catch {
    return null
  }
}

async function runCoverageScope(ctx) {
  const filtered = runIsFiltered(ctx)
  if (filtered !== false) return filtered
  const whole = await ranWholeSuite(ctx)
  return whole === null ? null : !whole
}

class ChildProcessCoverageProvider extends V8CoverageProvider {
  initialize(ctx) {
    super.initialize(ctx)
    this.childInstrument = enableChildProcessCoverage(ctx.config.root)
    this.treeAtStart = readTreeIdentity(ctx.config.root)
    // A path that writes reports without cleaning first (`--merge-reports`, coverage.clean=false)
    // must not leave an older stamp beside the new summary.
    try {
      rmSync(resolve(this.options.reportsDirectory, COVERAGE_STAMP_NAME), { recursive: true, force: true })
    } catch {
      // A stamp that cannot be removed is overwritten or removed again when the reports are written.
    }
  }

  // The stamp is written after the reports, beside them, from the tree read at start and at the end.
  async reportCoverage(coverageMap, options) {
    await super.reportCoverage(coverageMap, options)
    this.stampReports(await runCoverageScope(this.ctx))
  }

  // `--merge-reports` writes a summary from blobs whose runs this process never saw: it is stamped
  // as unknown, so quality.mjs refuses it rather than reading it beside an older stamp.
  async mergeReports(coverageMaps) {
    await super.mergeReports(coverageMaps)
    this.stampReports(null)
  }

  stampReports(filtered) {
    const end = readTreeIdentity(this.ctx.config.root)
    writeCoverageStamp(this.options.reportsDirectory, { start: this.treeAtStart ?? end, end, filtered })
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

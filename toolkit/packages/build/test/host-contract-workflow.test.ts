import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'
import { expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper
import { processRelationshipOperation } from '../../../../plugin/bin/lib/host/win32.mjs'

const root = resolve(import.meta.dirname, '../../../..')
type Step = { name?: string; run?: string; shell?: string; if?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown>; 'continue-on-error'?: unknown }
type Workflow = { on: Record<string, { paths?: string[] } | unknown[]>; permissions: Record<string, string>; jobs: Record<string, { steps: Step[]; defaults?: { run: { 'working-directory': string } }; strategy: { 'fail-fast': boolean; matrix: { os: string[] } }; 'timeout-minutes': number }> }
function workflow(name: string): Workflow {
  const file = resolve(root, `.github/workflows/${name}.yml`)
  expect(existsSync(file), `${name} workflow exists`).toBe(true)
  return parse(readFileSync(file, 'utf8')) as Workflow
}

  it('runs a weekly, dispatched and path-filtered real contract on every runner', () => {
    const config = workflow('host-contract')
    expect(Object.keys(config.on).sort()).toEqual(['push', 'schedule', 'workflow_dispatch'])
    expect(config.on.push).toEqual({ paths: ['.github/workflows/host-contract.yml', 'plugin/bin/lib/host/**', 'probes/host-platform/**', 'toolkit/packages/build/test/host-adapter.contract.test.ts'] })
    expect(config.on.schedule).toEqual([{ cron: expect.stringMatching(/^\d+ \d+ \* \* [0-6]$/) }])
    expect(config.permissions).toEqual({ contents: 'read' })
    const job = Object.values(config.jobs)[0]!
    expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { os: ['ubuntu-latest', 'macos-latest', 'windows-latest'] } })
    expect(job['timeout-minutes']).toBe(10)
    expect(job.defaults?.run['working-directory']).toBe('toolkit')
    expect(job.steps).toEqual(expect.arrayContaining([expect.objectContaining({ uses: 'actions/setup-node@v4', with: { 'node-version': 24 } }), expect.objectContaining({ run: 'corepack enable' }), expect.objectContaining({ run: 'pnpm install' })]))
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact'))!
    expect(upload.if).toBe('${{ always() }}')
    expect(upload.with).toMatchObject({ name: 'host-contract-${{ matrix.os }}', path: 'toolkit/ci-diagnostics/' })
    expect(job.steps.some((step) => step.run?.includes('ImageOS') && step.run.includes('ImageVersion'))).toBe(true)
  })

  it.each(['host-contract', 'cross-os'])('makes %s real-mode failures gating with diagnostic logs', (name) => {
    const jobs = Object.values(workflow(name).jobs)
    const steps = jobs.flatMap((job) => job.steps).filter((step) => step.run?.includes('packages/build/test/host-adapter.contract.test.ts'))
    expect(steps).toHaveLength(1)
    const step = steps[0]!
    expect(step['continue-on-error']).toBeUndefined()
    expect(step.env?.WT_HOST_CONTRACT_REAL).toBe('1')
    expect(step.shell).toBe('bash')
    expect(step.run).toContain('pnpm test:shard packages/build/test/host-adapter.contract.test.ts')
    expect(step.run).toContain('ci-diagnostics/host-contract-')
    if (name === 'cross-os') expect(step.if).toBe('${{ matrix.shard != 2 && matrix.shard != 3 }}')
  })

  it('separates the Windows adapter clock assignment from process enumeration', () => {
    expect(processRelationshipOperation.args.at(-1)).toMatch(/\$now = Get-Date;\s+Get-CimInstance/)
  })

  it('separates the Windows probe clock assignment from process enumeration', () => {
    const source = readFileSync(resolve(root, 'probes/host-platform/process-table.mjs'), 'utf8')
    const expression = /const script = (\[[\s\S]*?\]\.join\('[^']*'\))/.exec(source)?.[1]
    expect(expression, 'probe script assembly').toBeDefined()
    expect(runInNewContext(expression!)).toMatch(/\$now = Get-Date;\s+Get-CimInstance/)
  })

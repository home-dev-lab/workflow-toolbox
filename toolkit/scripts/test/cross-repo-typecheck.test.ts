import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import { runCrossRepoTypecheck } from '../cross-repo-typecheck.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(producerType: 'string' | 'number'): {
  root: string
  consumerRoot: string
  producerToolkitRoot: string
} {
  const root = mkdtempSync(join(tmpdir(), 'wt-cross-repo-gate-'))
  temporaryRoots.push(root)
  const consumerRoot = join(root, 'workflow-observatory')
  const producerToolkitRoot = join(root, 'producer', 'toolkit')
  const packageRoot = join(producerToolkitRoot, 'packages', 'example')

  mkdirSync(join(consumerRoot, 'apps', 'observe-ui', 'server'), { recursive: true })
  mkdirSync(join(consumerRoot, 'src'), { recursive: true })
  mkdirSync(join(packageRoot, 'src'), { recursive: true })
  writeFileSync(join(consumerRoot, 'apps', 'observe-ui', 'package.json'), '{"name":"@workflow-toolbox/observe-ui"}\n')
  writeFileSync(join(consumerRoot, 'apps', 'observe-ui', 'server', 'dev-api.ts'), 'export {}\n')
  writeFileSync(
    join(consumerRoot, 'pnpm-workspace.yaml'),
    "overrides:\n  '@workflow-toolbox/example': 'link:../producer/toolkit/packages/example'\n",
  )
  writeFileSync(
    join(consumerRoot, 'tsconfig.json'),
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler","noEmit":true},"include":["src/**/*.ts"]}\n',
  )
  writeFileSync(
    join(consumerRoot, 'src', 'consumer.ts'),
    "import type { Contract } from '@workflow-toolbox/example'\nconst contract: Contract = { value: 'sound' }\nexport { contract }\n",
  )
  writeFileSync(
    join(packageRoot, 'package.json'),
    '{"name":"@workflow-toolbox/example","type":"module","exports":{".":{"types":"./src/index.ts","import":"./src/index.ts"}}}\n',
  )
  writeFileSync(join(packageRoot, 'src', 'index.ts'), `export interface Contract { value: ${producerType} }\n`)
  return { root, consumerRoot, producerToolkitRoot }
}

function run(consumerRoot: string, producerToolkitRoot: string): { code: number; lines: string[] } {
  const lines: string[] = []
  const code = runCrossRepoTypecheck({
    cwd: consumerRoot,
    env: { DWT_OBSERVE_ROOT: consumerRoot },
    producerToolkitRoot,
    log: (line) => lines.push(line),
  })
  return { code, lines }
}

describe('cross-repo typecheck gate', () => {
  it('exits zero and states that an absent private checkout was skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-cross-repo-absent-'))
    temporaryRoots.push(root)
    const missing = join(root, 'workflow-observatory')
    const lines: string[] = []

    const code = runCrossRepoTypecheck({
      cwd: root,
      env: { DWT_OBSERVE_ROOT: missing },
      producerToolkitRoot: join(root, 'toolkit'),
      log: (line) => lines.push(line),
    })

    expect(code).toBe(0)
    expect(lines).toEqual([`cross-repo gate: private checkout not found at ${missing} - SKIPPED`])
  })

  it('exits zero when the present consumer surface accepts the producer type', () => {
    const { consumerRoot, producerToolkitRoot } = fixture('string')
    const result = run(consumerRoot, producerToolkitRoot)

    expect(result.code).toBe(0)
    expect(result.lines).toContain('cross-repo gate: PASS - 1 package(s), 1 consumer TypeScript file(s)')
  })

  it('fails and names the producer package and consumer file for a broken producer type', () => {
    const { consumerRoot, producerToolkitRoot } = fixture('number')
    const result = run(consumerRoot, producerToolkitRoot)

    expect(result.code).not.toBe(0)
    expect(result.lines).toContain(
      'cross-repo gate: TYPE ERROR: package @workflow-toolbox/example; consumer src/consumer.ts',
    )
    expect(result.lines.join('\n')).toMatch(/src\/consumer\.ts:\d+:\d+: Type 'string' is not assignable to type 'number'/)
  })
})

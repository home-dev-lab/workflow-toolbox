import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { failedTestNames } from '../../../../plugin/bin/lib/lifecycle-launch.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { detectFailedTestFramework } from '../../../../plugin/bin/lib/host/test-framework-detection.mjs'

const outputs = {
  vitest: readFileSync(new URL('./fixtures/failed-test-output/vitest.txt', import.meta.url), 'utf8'),
  pytest: readFileSync(new URL('./fixtures/failed-test-output/pytest.txt', import.meta.url), 'utf8'),
  'junit-gradle': readFileSync(new URL('./fixtures/failed-test-output/gradle-junit.txt', import.meta.url), 'utf8'),
}
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))

function withProject(files: string[], assertion: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'wt-failed-test-adapter-'))
  try {
    for (const name of files) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      writeFileSync(join(root, name), '')
    }
    assertion(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('failed-test adapters', () => {
  it.each([
    ['vitest', 'adds numbers'],
    ['pytest', 'test_failure.py::TestCalculator::test_adds_numbers'],
    ['junit-gradle', 'CalculatorTest > addsNumbers()'],
  ] as const)('extracts an exact name only from %s failure output', (framework, expected) => {
    expect([...failedTestNames(outputs[framework], framework)]).toContain(expected)
    expect([...failedTestNames('1 passed\n✓ passing test\nBUILD SUCCESSFUL\n', framework)]).toEqual([])
    for (const [otherFramework, output] of Object.entries(outputs)) {
      if (otherFramework !== framework) expect([...failedTestNames(output, framework)]).toEqual([])
    }
  })

  it.each([
    ['example.ts', 'vitest'],
    ['example.py', 'pytest'],
    ['build.gradle', 'junit-gradle'],
  ])('selects the adapter declared by the active pack for %s', (name, expected) => {
    withProject([name], (root) => expect(detectFailedTestFramework(root)).toBe(expected))
  })

  it('does not parse a unittest failure summary as a pytest test name', () => {
    expect([...failedTestNames('FAILED (failures=1)', 'pytest')]).toEqual([])
  })

  it('preserves separators inside a parameterized pytest node id', () => {
    const names = [...failedTestNames('FAILED tests/test_x.py::test_x[a - b] - assert False', 'pytest')]
    expect(names).toContain('tests/test_x.py::test_x[a - b]')
    expect(names).not.toContain('tests/test_x.py::test_x[a')
  })

  it.each([
    [[], 'undetected'],
    [['main.rs'], 'undetected'],
    [['example.ts', 'other.ts', 'test_example.py'], 'ambiguous:pytest,vitest'],
    [['build.gradle', 'test_example.py'], 'ambiguous:junit-gradle,pytest'],
  ] as const)('fails closed when project signals are absent or conflicting: %j', (files, expected) => {
    withProject([...files], (root) => expect(detectFailedTestFramework(root)).toBe(expected))
  })

  it('uses package.json as an explicit JavaScript project signal', () => {
    withProject(['package.json'], (root) => expect(detectFailedTestFramework(root)).toBe('vitest'))
  })

  it.each([
    repositoryRoot,
    join(repositoryRoot, 'toolkit'),
    join(repositoryRoot, 'toolkit', 'examples'),
    join(repositoryRoot, 'plugins', 'wt-deep-search'),
    join(repositoryRoot, 'plugins', 'wt-secret-guard'),
  ])('continues to select vitest for current JavaScript/TypeScript project %s', (root) => {
    expect(detectFailedTestFramework(root)).toBe('vitest')
  })

  it('skips an unreadable subdirectory instead of throwing', () => {
    withProject(['example.ts', 'blocked/ignored.py'], (root) => {
      const blocked = join(root, 'blocked')
      chmodSync(blocked, 0o000)
      try {
        expect(() => detectFailedTestFramework(root)).not.toThrow()
        expect(detectFailedTestFramework(root)).toBe('vitest')
      } finally {
        chmodSync(blocked, 0o700)
      }
    })
  })
})

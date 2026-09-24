import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const root = mkdtempSync(join(tmpdir(), 'wt-failed-test-adapter-'))
    try {
      if (name.includes('/')) mkdirSync(join(root, name.slice(0, name.lastIndexOf('/'))), { recursive: true })
      writeFileSync(join(root, name), '')
      expect(detectFailedTestFramework(root)).toBe(expected)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

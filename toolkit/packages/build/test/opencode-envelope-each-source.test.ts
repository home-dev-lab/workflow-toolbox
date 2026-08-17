import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- runtime .mjs helper intentionally has no declaration file.
import { DEFAULT_MAX_TASKS, applyItemTemplate, generateEachTasks, parseEachSource } from '../../../../plugin/bin/lib/opencode-envelope-tasks.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-opencode-envelope.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wt-opencode-envelope-each-'))
  roots.push(root)
  return root
}

function generated(items: unknown[], maxTasks = DEFAULT_MAX_TASKS) {
  return generateEachTasks({
    items,
    promptTemplate: 'Review {{item}}',
    idTemplate: 'item-{{item}}',
    maxTasks,
  })
}

function installFakeOpencode(root: string) {
  const bin = join(root, 'opencode')
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "if (process.argv[2] === 'providers') process.exit(0)",
    "process.stdout.write(JSON.stringify({ part: { type: 'text', text: 'answer' } }) + '\\n')",
    '',
  ].join('\n'))
  chmodSync(bin, 0o755)
}

describe('wt-opencode-envelope generated task sources', () => {
  it('the same rule generates 3 tasks from a 3-element JSON array', () => {
    const result = generated(parseEachSource('["a","b","c"]', 'json'))
    expect(result.sourceCount).toBe(3)
    expect(result.tasks).toHaveLength(3)
  })

  it('the same rule generates 200 tasks from source data without CLI calls', () => {
    const source = JSON.stringify(Array.from({ length: 200 }, (_, index) => `value-${index}`))
    const result = generated(parseEachSource(source, 'json'))
    expect(result.sourceCount).toBe(200)
    expect(result.tasks).toHaveLength(200)
  })

  it('an empty source generates zero tasks rather than one empty task', () => {
    const result = generated(parseEachSource('[]', 'json'))
    expect(result.sourceCount).toBe(0)
    expect(result.tasks).toHaveLength(0)
  })

  it('a source past the cap records both the capped count and dropped count', () => {
    const result = generated(['a', 'b', 'c', 'd'], 3)
    expect(result.tasks).toHaveLength(3)
    expect(result.dropped).toBe(1)
  })

  it('--each-lines skips blank lines instead of generating empty tasks', () => {
    expect(parseEachSource('first\n\n  \nsecond\n', 'lines')).toEqual(['first', 'second'])
  })

  it('substitutes the whole string element', () => {
    expect(applyItemTemplate('Ask about {{item}}.', 'alpha')).toBe('Ask about alpha.')
  })

  it('substitutes object fields, including dotted paths', () => {
    const item = { id: 'A-7', details: { question: 'why?' } }
    expect(applyItemTemplate('{{item.id}}: {{item.details.question}}', item)).toBe('A-7: why?')
  })

  it('help documents explicit source modes and numeric default cap', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--each-json <path>')
    expect(result.stdout).toContain('--each-lines <path>')
    expect(result.stdout).toContain('--max-tasks <n>')
    expect(result.stdout).toContain('Default: 256')
  })

  it('empty generated source writes a zero-task nothing_to_do manifest without invoking opencode', () => {
    const root = makeRoot()
    const source = join(root, 'items.json')
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(source, '[]\n')
    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--each-json', source,
      '--prompt-template', 'Review {{item}}',
      '--id-template', 'item-{{item}}',
      '--dir', root,
      '--manifest', manifestPath,
    ], { encoding: 'utf8', env: { ...process.env, PATH: '' } })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`MANIFEST: ${manifestPath}\n`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest).toMatchObject({ status: 'nothing_to_do', nothingToDo: true, total: 0, dropped: 0, tasks: [] })
  })

  it('capped execution logs and manifests the number dropped', () => {
    const root = makeRoot()
    const workdir = join(root, 'workdir')
    mkdirSync(workdir)
    installFakeOpencode(root)
    const source = join(root, 'items.json')
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(source, '["a","b","c","d"]\n')
    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--each-json', source,
      '--prompt-template', 'Review {{item}}',
      '--id-template', 'item-{{item}}',
      '--max-tasks', '2',
      '--dir', workdir,
      '--manifest', manifestPath,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, XDG_STATE_HOME: root } })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('dropped 2 of 4 source items because --max-tasks=2')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest).toMatchObject({ maxTasks: 2, dropped: 2, total: 2, nothingToDo: false })
    expect(manifest.tasks).toHaveLength(2)
    expect(manifest.tasks[0]).not.toHaveProperty('usage')
  })
})

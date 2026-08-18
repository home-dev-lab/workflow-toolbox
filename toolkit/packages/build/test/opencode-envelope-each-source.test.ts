import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    "const taskFile = process.argv[process.argv.indexOf('-f') + 1]",
    "if (process.env.FAKE_PROMPT_CAPTURE) require('node:fs').writeFileSync(process.env.FAKE_PROMPT_CAPTURE, require('node:fs').readFileSync(taskFile, 'utf8'))",
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
    expect(result.stdout).toContain('--reduce <manifest-path>')
    expect(result.stdout).toContain('--max-reduce-chars <n>')
    expect(result.stdout).toContain('Default: 131072')
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

  it('reduces successful answers into one external call and names failed tasks in its manifest', () => {
    const root = makeRoot()
    const workdir = join(root, 'workdir')
    mkdirSync(workdir)
    installFakeOpencode(root)
    const firstAnswer = join(root, 'first.answer.txt')
    writeFileSync(firstAnswer, 'first result')
    const sourceManifest = join(root, 'fan-out.manifest.json')
    writeFileSync(sourceManifest, JSON.stringify({
      tasks: [
        { id: 'first', status: 'answer', exitStatus: 0, answerFile: firstAnswer },
        { id: 'broken', status: 'error', exitStatus: 1, reason: 'opencode exited 1' },
      ],
    }))
    const manifestPath = join(root, 'reduce.manifest.json')
    const promptCapture = join(root, 'reduce-prompt.txt')
    const result = spawnSync(process.execPath, [
      SCRIPT, '--reduce', sourceManifest, '--reduce-prompt', 'Synthesize:\n{{answers}}',
      '--dir', workdir, '--manifest', manifestPath,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, XDG_STATE_HOME: root, FAKE_PROMPT_CAPTURE: promptCapture } })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`MANIFEST: ${manifestPath}\n`)
    expect(readFileSync(promptCapture, 'utf8')).toBe('Synthesize:\n--- BEGIN ANSWER id=first exitStatus=0 ---\nfirst result\n--- END ANSWER id=first ---')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest).toMatchObject({ total: 1, answered: 1, errored: 0, skippedFailedTaskIds: ['broken'] })
    expect(manifest.tasks[0]).toMatchObject({ status: 'answer', exitStatus: 0 })
    // the id is derived from the source manifest, so it is a stable prefix plus a digest
    expect(manifest.tasks[0].id).toMatch(/^reduce-[0-9a-f]{8}$/)
  })

  it('renders an answer containing dollar substitution patterns verbatim', () => {
    // ⚠ A string replacement makes JS interpret `$&`, `$1` and `$$` in the REPLACEMENT.
    // Measured 2026-08-18 before this lock existed: an answer reading `use $& to repeat`
    // rendered as `use {{answers}} to repeat` — the placeholder re-inserted into the prompt,
    // silently. An external model discussing a regex or a shell command produces exactly this.
    const root = makeRoot()
    const workdir = join(root, 'workdir')
    mkdirSync(workdir)
    installFakeOpencode(root)
    const dollarAnswer = join(root, 'dollar.answer.txt')
    const literal = 'use $& to repeat the match, $1 for group one, $$ for a literal dollar'
    writeFileSync(dollarAnswer, literal)
    const sourceManifest = join(root, 'fan-out.manifest.json')
    writeFileSync(sourceManifest, JSON.stringify({
      tasks: [{ id: 'dollars', status: 'answer', exitStatus: 0, answerFile: dollarAnswer }],
    }))
    const manifestPath = join(root, 'reduce.manifest.json')
    const promptCapture = join(root, 'reduce-prompt.txt')
    const result = spawnSync(process.execPath, [
      SCRIPT, '--reduce', sourceManifest, '--reduce-prompt', 'Synthesize:\n{{answers}}',
      '--dir', workdir, '--manifest', manifestPath,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, XDG_STATE_HOME: root, FAKE_PROMPT_CAPTURE: promptCapture } })

    expect(result.status).toBe(0)
    const rendered = readFileSync(promptCapture, 'utf8')
    expect(rendered).toContain(literal)
    expect(rendered).not.toContain('{{answers}}')
  })

  it('two reduces over one directory do not overwrite each other', () => {
    // ⚠ The failure this locks is SILENT: with a fixed id both reduces wrote
    // <dir>/reduce.answer.txt, the second overwrote the first, and the first manifest still
    // reported `answered: 1, errored: 0` while naming a file holding the OTHER question's
    // answer. Measured 2026-08-18 on a real nested run — a shape this mode supports, since a
    // reduce manifest satisfies --reduce's own input contract.
    const root = makeRoot()
    const workdir = join(root, 'workdir')
    mkdirSync(workdir)
    installFakeOpencode(root)
    const answerA = join(root, 'a.answer.txt')
    const answerB = join(root, 'b.answer.txt')
    writeFileSync(answerA, 'alpha')
    writeFileSync(answerB, 'beta')
    const sourceA = join(root, 'fan-a.manifest.json')
    const sourceB = join(root, 'fan-b.manifest.json')
    writeFileSync(sourceA, JSON.stringify({ tasks: [{ id: 'a', status: 'answer', exitStatus: 0, answerFile: answerA }] }))
    writeFileSync(sourceB, JSON.stringify({ tasks: [{ id: 'b', status: 'answer', exitStatus: 0, answerFile: answerB }] }))
    const env = { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, XDG_STATE_HOME: root }
    const run = (source: string, manifest: string) =>
      spawnSync(process.execPath, [
        SCRIPT, '--reduce', source, '--reduce-prompt', 'Synthesize:\n{{answers}}',
        '--dir', workdir, '--manifest', manifest,
      ], { encoding: 'utf8', env })

    const manifestA = join(root, 'reduce-a.manifest.json')
    const manifestB = join(root, 'reduce-b.manifest.json')
    expect(run(sourceA, manifestA).status).toBe(0)
    expect(run(sourceB, manifestB).status).toBe(0)

    const fileA = JSON.parse(readFileSync(manifestA, 'utf8')).tasks[0].answerFile
    const fileB = JSON.parse(readFileSync(manifestB, 'utf8')).tasks[0].answerFile
    expect(fileA).not.toBe(fileB)
    // and the first answer must still exist after the second run
    expect(existsSync(fileA)).toBe(true)
  })

  it('refuses a reduce template without the literal {{answers}} placeholder', () => {
    const root = makeRoot()
    const workdir = join(root, 'workdir')
    mkdirSync(workdir)
    const sourceManifest = join(root, 'fan-out.manifest.json')
    writeFileSync(sourceManifest, JSON.stringify({ tasks: [] }))
    const result = spawnSync(process.execPath, [
      SCRIPT, '--reduce', sourceManifest, '--reduce-prompt', 'No answers go here', '--dir', workdir,
    ], { encoding: 'utf8', env: { ...process.env, PATH: '' } })

    expect(result.status).toBe(2)
    expect(result.stdout).toContain('reduce prompt template must contain {{answers}}')
  })

  it('refuses a reduce template with more than one literal {{answers}} placeholder', () => {
    const root = makeRoot()
    const workdir = join(root, 'workdir')
    mkdirSync(workdir)
    const sourceManifest = join(root, 'fan-out.manifest.json')
    writeFileSync(sourceManifest, JSON.stringify({ tasks: [] }))
    const result = spawnSync(process.execPath, [
      SCRIPT, '--reduce', sourceManifest, '--reduce-prompt', '{{answers}} again {{answers}}', '--dir', workdir,
    ], { encoding: 'utf8', env: { ...process.env, PATH: '' } })

    expect(result.status).toBe(2)
    expect(result.stdout).toContain('reduce prompt template must contain exactly one {{answers}}')
  })

  it('empty reduce input makes zero calls and records its stated reason', () => {
    const root = makeRoot()
    const workdir = join(root, 'workdir')
    mkdirSync(workdir)
    installFakeOpencode(root)
    const sourceManifest = join(root, 'fan-out.manifest.json')
    const manifestPath = join(root, 'reduce.manifest.json')
    const promptCapture = join(root, 'reduce-prompt.txt')
    writeFileSync(sourceManifest, JSON.stringify({ tasks: [] }))
    const result = spawnSync(process.execPath, [
      SCRIPT, '--reduce', sourceManifest, '--reduce-prompt', '{{answers}}', '--dir', workdir, '--manifest', manifestPath,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, XDG_STATE_HOME: root, FAKE_PROMPT_CAPTURE: promptCapture } })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`MANIFEST: ${manifestPath} (nothing_to_do: no usable answers in source manifest)\n`)
    expect(existsSync(promptCapture)).toBe(false)
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ status: 'nothing_to_do', reason: 'no usable answers in source manifest', total: 0 })
  })

  it('caps reduce input by its literal numeric character limit and logs dropped answer ids', () => {
    const root = makeRoot()
    const workdir = join(root, 'workdir')
    mkdirSync(workdir)
    installFakeOpencode(root)
    const firstAnswer = join(root, 'first.answer.txt')
    const secondAnswer = join(root, 'second.answer.txt')
    writeFileSync(firstAnswer, 'one')
    writeFileSync(secondAnswer, 'two')
    const sourceManifest = join(root, 'fan-out.manifest.json')
    const manifestPath = join(root, 'reduce.manifest.json')
    writeFileSync(sourceManifest, JSON.stringify({ tasks: [
      { id: 'first', status: 'answer', exitStatus: 0, answerFile: firstAnswer },
      { id: 'second', status: 'answer', exitStatus: 0, answerFile: secondAnswer },
    ] }))
    const result = spawnSync(process.execPath, [
      SCRIPT, '--reduce', sourceManifest, '--reduce-prompt', '{{answers}}', '--max-reduce-chars', '90',
      '--dir', workdir, '--manifest', manifestPath,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, XDG_STATE_HOME: root } })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('dropped 1 answers because --max-reduce-chars=90: second')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ maxReduceChars: 90, cappedAnswerIds: ['second'], total: 1 })
  })
})

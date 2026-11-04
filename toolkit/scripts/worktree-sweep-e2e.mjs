#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, fingerprint, git, repository } from '../test-support/worktree-sweep-fixture.mjs'
import { populate } from '../test-support/worktree-sweep-population.mjs'

const f = fixture()
const cli = fileURLToPath(new URL('../../plugin/bin/wt-worktree-sweep.mjs', import.meta.url))
let reset = () => {}
if (process.argv.includes('--populated')) {
  try {
    const population = populate(f)
    reset = population.restore
    const before = fingerprint(f.project)
    const out = join(f.root, 'report.json')
    const output = execFileSync(process.execPath, [cli, 'run', '--mode', 'report', '--project', f.project, '--out', out], { env: f.env, encoding: 'utf8' })
    const report = JSON.parse(readFileSync(out, 'utf8'))
    assert.deepEqual(fingerprint(f.project), before)
    assert.ok(report.entries.length >= 40)
    for (const entry of report.entries) assert.equal(entry.reason, population.expected[entry.name], entry.name)
    process.stdout.write(`${output.split('\n')[0]}\n`)
    console.log(JSON.stringify(report.summary, null, 2))
    console.log('PASS: every populated fixture verdict and every project byte/size/mtime/ctime')
  } finally { reset(); rmSync(f.root, { recursive: true, force: true }) }
} else {
try {
  const main = repository(f, 'main')
  git(main, f.env, 'worktree', 'add', '-qb', 'dirty', join(f.source, 'dirty-wt'))
  git(main, f.env, 'worktree', 'add', '-qb', 'lane', join(f.source, 'lane-wt'))
  writeFileSync(join(f.source, 'dirty-wt', 'tracked'), 'owner edit\n')
  writeFileSync(join(f.source, 'dirty-wt', 'untracked'), 'owner addition\n')
  mkdirSync(join(f.source, 'nogit-dir'))
  writeFileSync(join(f.source, 'nogit-dir', 'plain'), 'no git\n')
  mkdirSync(join(f.source, 'lane-wt', '.lane'))
  for (const name of ['report.md', 'gate.log', 'review.diff']) writeFileSync(join(f.source, 'lane-wt', '.lane', name), `keep ${name}\n`)
  mkdirSync(join(f.source, 'lane-wt-export.base'))
  writeFileSync(join(f.source, 'lane-wt-export.base', 'tracked'), 'committed\n')
  const before = fingerprint(f.project)
  const context = join(f.root, 'bin', 'context-mode')
  writeFileSync(context, `#!/bin/sh\nprintf called >> ${JSON.stringify(join(f.root, 'context.log'))}\nexit 99\n`)
  chmodSync(context, 0o755)
  for (const mode of ['present', 'absent']) {
    if (mode === 'absent') unlinkSync(context)
    const out = join(f.root, `report-${mode}.json`)
    const line = execFileSync(process.execPath, [cli, 'run', '--mode', 'report', '--project', f.project, '--out', out], { env: f.env, encoding: 'utf8' })
    const report = JSON.parse(readFileSync(out, 'utf8'))
    assert.deepEqual(fingerprint(f.project), before)
    assert.equal(report.entries.find(entry => entry.name === 'dirty-wt').reason, 'uncommitted')
    assert.equal(report.entries.find(entry => entry.name === 'nogit-dir').reason, 'no-git')
    assert.equal(report.entries.length, 5)
    assert.equal(existsSync(join(f.root, 'context.log')), false)
    console.log(`context-mode ${mode}:`)
    process.stdout.write(line)
  }
  console.log('PASS: report-only CLI preserves every fixture byte, size, mtime and ctime; context-mode is never invoked')
} finally { rmSync(f.root, { recursive: true, force: true }) }
}

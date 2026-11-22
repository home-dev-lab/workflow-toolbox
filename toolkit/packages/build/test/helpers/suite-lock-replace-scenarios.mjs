import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

function environment(root) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^WT_SUITE_(LOCK|LEASE)/.test(key)) delete env[key]
  return { ...env, WT_SUITE_LOCK_DIR: root }
}

async function until(predicate) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fixture must reach the requested state')
    await delay(10)
  }
}

function fixture(cli) {
  const root = mkdtempSync(join(tmpdir(), 'suite-replace-'))
  const env = environment(root)
  const children = []
  const run = (flags, text) => spawnSync(process.execPath, [cli, 'run', ...flags, '--', process.execPath, '-e', text], { env, encoding: 'utf8', timeout: 5000 })
  const start = (text, flags = []) => {
    const child = spawn(process.execPath, [cli, 'run', ...flags, '--', process.execPath, '-e', text], { env, stdio: 'pipe' })
    children.push(child)
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data })
    const done = new Promise((resolve) => child.once('exit', (code) => resolve({ code, stderr })))
    return { child, done }
  }
  const queue = join(root, 'queue.d')
  const tickets = () => existsSync(queue) ? readdirSync(queue).filter((name) => /^\d{16}\.json$/.test(name)).sort() : []
  const finish = async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? null : new Promise((resolve) => child.once('exit', resolve))))
    rmSync(root, { recursive: true, force: true })
  }
  return { root, queue, run, start, tickets, finish }
}

async function waiting(cli, scenario) {
  const f = fixture(cli)
  mkdirSync(join(f.root, 'lock.d'))
  writeFileSync(join(f.root, 'lock.d/holder.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
  try {
    const original = f.start('process.stdout.write("original")')
    await until(() => f.tickets().length === 1)
    const name = f.tickets()[0]
    await scenario(f, original, name, Number(name.slice(0, 16)))
  } finally { await f.finish() }
}

export const replaceScenarios = {
  'replaces argv atomically while preserving the complete ranked record and queue order': (cli) => waiting(cli, async (f, original, name, ticket) => {
    const before = readFileSync(join(f.queue, name), 'utf8')
    const output = join(f.root, 'order')
    const second = f.start(`require('node:fs').appendFileSync(${JSON.stringify(output)}, 'B')`)
    await until(() => f.tickets().length === 2)
    const result = f.run(['--replace', String(ticket)], `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'A');process.exit(19)`)
    assert.equal(result.status, 0, `queued replacement must succeed: ${result.stderr}`)
    assert.equal(readFileSync(join(f.queue, name), 'utf8'), before, 'replacement must preserve every ranking and ownership field')
    rmSync(join(f.root, 'lock.d'), { recursive: true })
    assert.equal((await original.done).code, 19, 'original executor must return replacement exit status')
    assert.equal((await second.done).code, 0)
    assert.equal(readFileSync(output, 'utf8'), 'AB', 'replacement must keep the original rank')
  }),
  'the latest of repeated queued replacements wins without starting either predecessor': (cli) => waiting(cli, async (f, original, name, ticket) => {
    const output = join(f.root, 'selected')
    for (const value of ['first', 'last']) {
      const result = f.run(['--replace', String(ticket)], `require('node:fs').writeFileSync(${JSON.stringify(output)}, ${JSON.stringify(value)})`)
      assert.equal(result.status, 0, `repeated replacement must succeed: ${result.stderr}`)
    }
    assert.equal(existsSync(output), false, 'replacement only publishes; it never starts work')
    rmSync(join(f.root, 'lock.d'), { recursive: true })
    assert.equal((await original.done).code, 0)
    assert.equal(readFileSync(output, 'utf8'), 'last')
  }),
  'refuses replacement after the original command starts': async (cli) => {
    const f = fixture(cli)
    try {
      const ready = join(f.root, 'ready')
      const child = f.start(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'yes');setInterval(()=>{},1000)`)
      await until(() => existsSync(ready))
      const number = Math.max(...readdirSync(f.queue).filter((name) => name.endsWith('.ticket')).map((name) => Number(name.slice(0, 16))))
      const result = f.run(['--replace', String(number)], 'process.exit(23)')
      assert.equal(result.status, 2)
      assert.match(result.stderr, /cannot replace.*(started|not queued)/, 'running replacement must explicitly refuse the started ticket')
      child.child.kill('SIGTERM')
      await child.done
    } finally { await f.finish() }
  },
  'refuses legacy tickets without replacement support': (cli) => waiting(cli, async (f, original, name, ticket) => {
    const record = JSON.parse(readFileSync(join(f.queue, name), 'utf8'))
    delete record.replaceToken
    writeFileSync(join(f.queue, name), JSON.stringify(record))
    const result = f.run(['--replace', String(ticket)], 'process.exit(0)')
    assert.equal(result.status, 2)
    assert.match(result.stderr, /cannot replace.*(legacy|support)/, 'legacy target must be refused explicitly')
  }),
  'refuses missing tickets and invalid ticket identifiers precisely': async (cli) => {
    const f = fixture(cli)
    try {
      for (const ticket of ['1', '../1', '0', 'NaN']) {
        const result = f.run(['--replace', ticket], 'process.exit(0)')
        assert.equal(result.status, 2)
        assert.match(result.stderr, /(--replace requires a positive safe ticket number|cannot replace.*not queued)/, 'invalid or absent target must be diagnosed')
      }
    } finally { await f.finish() }
  },
  'rejects scheduling flags instead of silently changing the target class': (cli) => waiting(cli, async (f, original, name, ticket) => {
    const result = f.run(['--replace', String(ticket), '--light'], 'process.exit(0)')
    assert.equal(result.status, 2)
    assert.match(result.stderr, /--replace accepts only a ticket and command/, 'replacement must reject rank-changing options')
  }),
}

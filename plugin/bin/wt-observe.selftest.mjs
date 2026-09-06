// node plugin/bin/wt-observe.selftest.mjs — known-answer coverage for the checkout
// orientation and non-main refusal before the real observatory is ever launched.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = new URL('../..', import.meta.url).pathname
const cli = join(repo, 'plugin/bin/wt-observe.mjs')
const root = mkdtempSync(join(tmpdir(), 'wt-observe-selftest-'))
const stateHome = join(root, 'state')

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function git(...args) {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
}

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, DWT_OBSERVE_ROOT: root, OBSERVE_UI_SERVER_PORT: '0', XDG_STATE_HOME: stateHome },
  })
}

function expect(result, name, predicate) {
  const text = `${result.stdout}${result.stderr}`
  const ok = predicate(result, text)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n${text}`}`)
  return ok
}

let failed = 0
try {
  write(join(root, 'package.json'), '{}\n')
  write(join(root, 'apps/observe-ui/package.json'), '{"name":"@workflow-toolbox/observe-ui"}\n')
  write(join(root, 'apps/observe-ui/dist/assets/index-selftest.js'), 'selftest\n')
  write(join(root, 'node_modules/tsx/package.json'), '{"main":"cli.js"}\n')
  write(join(root, 'node_modules/tsx/cli.js'), "require(require('node:path').resolve(process.cwd(), process.argv[2]))\n")
  write(join(root, 'apps/observe-ui/server/dev-api.ts'), [
    "const http = require('node:http')",
    "const port = Number(process.env.OBSERVE_UI_SERVER_PORT)",
    "const server = http.createServer((_, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ app: 'observe-ui', pid: process.pid, port: server.address().port, configDir: process.env.CLAUDE_CONFIG_DIR, startedAt: new Date().toISOString() })) })",
    "server.listen(port, '127.0.0.1', () => console.log(`[observe-ui] app + run discovery on http://127.0.0.1:${server.address().port}`))",
  ].join('\n'))
  git('init', '-b', 'main')
  git('add', '.')
  git('-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', 'commit', '-m', 'fixture')

  const main = run('start')
  if (!expect(main, 'main proceeds and prints branch, head, and bundle', (r, text) => r.status === 0 && /branch=main\b/.test(text) && /head=[0-9a-f]{7}\b/.test(text) && /bundle=apps\/observe-ui\/dist\/assets\/index-selftest\.js/.test(text))) failed++
  const status = run('status')
  if (!expect(status, 'status reads branch, head, and bundle from server.json', (r, text) => r.status === 0 && /branch\s+: main/.test(text) && /head\s+: [0-9a-f]{7}/.test(text) && /bundle\s+: apps\/observe-ui\/dist\/assets\/index-selftest\.js/.test(text))) failed++

  git('checkout', '-b', 'selftest-branch')
  const refused = run('start')
  if (!expect(refused, 'branch is refused with checkout remedy', (r, text) => r.status !== 0 && text.includes(`git -C ${root} checkout main`) && text.includes('pnpm ui:build'))) failed++
  const allowed = run('start', '--allow-branch')
  if (!expect(allowed, 'allow-branch proceeds and prints a loud override', (r, text) => r.status === 0 && /ALLOW-BRANCH OVERRIDE/.test(text) && /branch=selftest-branch\b/.test(text))) failed++
} finally {
  run('stop')
  rmSync(root, { recursive: true, force: true })
}

console.log(`${4 - failed}/4 passed`)
process.exit(failed === 0 ? 0 : 1)

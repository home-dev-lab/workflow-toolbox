import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'

// An unconditional network seal: even a guard mutation ignoring the binary override
// resolves `claude` to this fixture, never to a logged-in CLI.
const STUB = `#!/usr/bin/env node
import fs from 'node:fs'
import { spawn } from 'node:child_process'
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { stdin += chunk })
process.stdin.on('end', () => {
  const mode = process.env.TEST_RULE_STUB_MODE || 'valid'
  const record = { pid: process.pid, argv: process.argv.slice(2), stdin, cwd: process.cwd(), env: {
    ATRIUM_IDENTITY: process.env.ATRIUM_IDENTITY, CLAUDECODE: process.env.CLAUDECODE,
    CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
    CLAUDE_CODE_DISABLE_THINKING: process.env.CLAUDE_CODE_DISABLE_THINKING,
    WT_RULE_NARRATIVE_SPLIT_CHILD: process.env.WT_RULE_NARRATIVE_SPLIT_CHILD,
  } }
  if (mode === 'grandchild' || mode === 'exit-descendant') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' })
    record.grandchild = child.pid
  }
  fs.writeFileSync(process.env.TEST_RULE_STUB_RECORD, JSON.stringify(record))
  if (mode === 'stall' || mode === 'grandchild') {
    process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return
  }
  if (mode === 'exit-descendant') process.exit(0)
  if (mode === 'exit') process.exit(1)
  if (mode === 'invalid') { console.log('not JSON'); return }
  if (mode === 'flood') { process.stdout.write('x'.repeat(70000)); return }
  const request = JSON.parse(stdin)
  let proposals = request.lines.map(line => ({ line: line.line, text: 'Keep retries enabled.' }))
  if (mode === 'dated') proposals[0].text = 'Keep retries since 2026-10-01.'
  if (mode === 'missing') proposals = []
  if (mode === 'empty') proposals[0].text = ''
  const json = JSON.stringify({ proposals })
  console.log(mode === 'fenced' ? '\x60\x60\x60json\\n' + json + '\\n\x60\x60\x60' : json)
})
`

export function sealRuleNarrative(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bin = join(root, 'sealed-bin')
  const home = join(root, 'sealed-home')
  mkdirSync(bin, { recursive: true })
  mkdirSync(home, { recursive: true })
  const stub = join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  // Extensionless launchers are parsed as CommonJS by Node; an explicit module
  // wrapper keeps the fixture independent of the project's package type.
  writeFileSync(join(bin, 'stub.mjs'), STUB)
  writeFileSync(stub, process.platform === 'win32'
    ? `@"${process.execPath}" "${join(bin, 'stub.mjs')}" %*\r\n`
    : `#!${process.execPath}\nimport(${JSON.stringify(join(bin, 'stub.mjs'))})\n`)
  chmodSync(stub, 0o755)
  return { ...env, HOME: home, CLAUDE_CONFIG_DIR: home,
    PATH: `${bin}${delimiter}${env.PATH ?? ''}`,
    WT_RULE_NARRATIVE_CLAUDE_BIN: env.TEST_RULE_STUB_MODE === 'absent' ? join(bin, 'absent') : stub,
    TEST_RULE_STUB_RECORD: env.TEST_RULE_STUB_RECORD ?? join(root, 'stub-record.json'),
  }
}

// Install at file evaluation, before any test can reach an injected or mutated
// runner. Per-process seals remain useful for independent fixture records.
export function sealRuleNarrativeFile() {
  const root = mkdtempSync(join(tmpdir(), 'wt-rule-file-seal-'))
  const sealed = sealRuleNarrative(root, { ...process.env, TEST_RULE_STUB_MODE: 'valid',
    TEST_RULE_STUB_RECORD: join(root, 'stub-record.json') })
  const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'PATH', 'WT_RULE_NARRATIVE_CLAUDE_BIN', 'TEST_RULE_STUB_RECORD']
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  for (const key of keys) process.env[key] = sealed[key]
  return { root, env: sealed, restore() {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  } }
}

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(__dirname, '..', '..', '..', '..')
const ENTRY = path.join(ROOT, 'plugin/bin/wt-opencode-verify.mjs')

describe('wt-opencode-verify', () => {
  it('parses stable command arguments and builds the exact opencode argv', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wt-opencode-verify-'))
    const source = path.join(dir, 'task.md')
    const binDir = path.join(dir, 'bin')
    const calls = path.join(dir, 'calls.json')
    writeFileSync(source, 'review this')
    try {
      mkdirSync(binDir)
      writeFileSync(path.join(binDir, 'opencode'), `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2); if(args[0]==='providers') process.exit(0); fs.writeFileSync(process.env.CALLS, JSON.stringify(args)); process.stdout.write('{"part":{"type":"text","text":"VERDICT"}}\\n')\n`)
      chmodSync(path.join(binDir, 'opencode'), 0o755)
      const result = spawnSync('node', [ENTRY, '--dir', dir, '--id', 'vote-123', '-m', 'openai/gpt-5.6-terra', '--fallback-model', 'openai/gpt-5.6-luna', '--variant', 'max', '--task-file', source], { encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CALLS: calls } })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('VERDICT')
      const argv = JSON.parse(readFileSync(calls, 'utf8'))
      expect(argv.slice(0, -1)).toEqual(['run', 'Follow the instructions in the attached file and output ONLY what it asks for (e.g. the verdict JSON). Do not add commentary.', '--agent', 'plan', '--model', 'openai/gpt-5.6-terra', '--variant', 'max', '--auto', '--dir', dir, '--format', 'json', '-f'])
      expect(argv.at(-1)).toMatch(new RegExp(`^${dir}/\\.oc-verify-vote-123-\\d+\\.md$`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

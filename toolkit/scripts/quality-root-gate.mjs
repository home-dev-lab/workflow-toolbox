#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const gate = process.argv[2]
const argv = gate === 'lint'
  ? ['toolkit/node_modules/eslint/bin/eslint.js', '--config', 'toolkit/eslint.config.mjs', 'toolkit/packages/*/src/**/*.ts', 'plugin/**/*.mjs', 'plugin/**/*.js', 'plugin/**/*.{ts,mts,cts}', 'plugins/wt-rules-on-demand/**/*.mjs', 'plugins/wt-rules-on-demand/**/*.js', '--max-warnings', '685']
  : gate === 'dead' ? ['toolkit/node_modules/knip/bin/knip.js', '--config', 'knip.json', '--max-issues', '221'] : null
if (!argv) throw new Error('usage: quality-root-gate.mjs lint|dead')
const result = spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit' })
if (result.error) process.stderr.write(`${result.error.message}\n`)
process.exitCode = result.status ?? 2

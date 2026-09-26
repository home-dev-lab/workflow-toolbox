#!/usr/bin/env node
import { runSuiteLockCliEntrypoint } from './wt-suite-lock.mjs'

process.exitCode = await runSuiteLockCliEntrypoint(['run', '--', ...process.argv.slice(2)])

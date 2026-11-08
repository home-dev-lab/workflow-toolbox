#!/usr/bin/env node
import { sessionSummary, tick } from './lib/worktree-sweep/trigger.mjs'
import { reportMode } from './lib/worktree-sweep/report.mjs'
import { resolveSweepProject } from './lib/worktree-sweep/git.mjs'
try {
  const project = resolveSweepProject()
  reportMode()
  process.stdout.write(`${sessionSummary(project)}\n`)
  tick({ project })
} catch (error) { process.stderr.write(`${error.message}\n`) }

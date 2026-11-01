#!/usr/bin/env node
import { tick } from './lib/worktree-sweep/trigger.mjs'
import { resolveSweepProject } from './lib/worktree-sweep/git.mjs'
try { tick({ project: resolveSweepProject() }) } catch { /* Prompt hook stays silent. */ }

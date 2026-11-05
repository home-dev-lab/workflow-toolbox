#!/usr/bin/env node
// Protocol-only stdout; host resolution and process lifecycle live under lib/host.
import { runTsIdleSession } from './lib/host/ts-idle-session.mjs'
import { lowerTsPriority } from './lib/host/ts-priority.mjs'

lowerTsPriority()
runTsIdleSession()

#!/usr/bin/env node
// Protocol-only stdout; host resolution and process lifecycle live under lib/host.
import { runTsLaunch } from './lib/host/ts-language-server.mjs'

runTsLaunch()

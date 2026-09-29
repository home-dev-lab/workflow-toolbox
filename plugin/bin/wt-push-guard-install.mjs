#!/usr/bin/env node
import { runInstaller } from './lib/host/push-guard-install.mjs';

runInstaller(process.argv.slice(2));

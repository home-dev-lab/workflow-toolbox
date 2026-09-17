#!/usr/bin/env node
// session-start-registry — at session start, ANSWER the question instead of reminding someone
// to ask it.
//
// A periodic scan has to be armed, and anything that has to be armed eventually is not — that is
// discipline wearing a mechanism's clothes. This hook runs the scan itself, at the one moment
// that fires without anyone remembering: the start of a session.
//
// It covers the gap a session cannot see by definition — what happened while it was dead. An
// agent that froze, hit a quota wall, or died with the machine leaves an entry that nothing ever
// closed; the next session opens already knowing.
//
// It does NOT cover mid-session silence (an agent going quiet at 3am while the session runs).
// Only a periodic loop does, which is why the reminder to arm one is emitted alongside — and
// stated as what it is, not as coverage already obtained.
//
// Never blocks, never fails a session start: any internal error exits 0 but leaves one trace on
// stderr. A session-start hook that can break session start is not worth its output.
//
// SHIPPED (plugin/bin/): registered on SessionStart in plugin/.claude-plugin/plugin.json. Reads
// the registry written by wt-outbound-guard-hook.mjs, via its sibling scan script
// wt-spawn-registry-scan.mjs (resolved relative to THIS file, not a hardcoded project path).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFailOpenHook } from './lib/fail-open-trace.mjs';
import { declaredHookPaths } from './lib/hook-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, 'wt-spawn-registry-scan.mjs');
const OWN_ROOT = join(HERE, '..');

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8')) || {};
} catch {}

function jsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function canonical(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function duplicateHookNotice() {
  const currentRoot = canonical(process.env.CLAUDE_PLUGIN_ROOT || OWN_ROOT);
  const ownManifestPath = join(currentRoot, '.claude-plugin', 'plugin.json');
  const ownManifest = jsonFile(ownManifestPath);
  if (!ownManifest?.name) return null;

  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const installed = jsonFile(join(configDir, 'plugins', 'installed_plugins.json'));
  const plugins = installed?.plugins && typeof installed.plugins === 'object' ? installed.plugins : installed;
  const settings = jsonFile(join(configDir, 'settings.json'));
  if (!plugins || typeof plugins !== 'object') return null;

  for (const [key, values] of Object.entries(plugins)) {
    if (!key.startsWith(`${ownManifest.name}@`) || settings?.enabledPlugins?.[key] !== true) continue;
    for (const value of Array.isArray(values) ? values : [values]) {
      if (typeof value?.installPath !== 'string') continue;
      const installedRoot = canonical(value.installPath);
      if (installedRoot === currentRoot) continue;
      const installedManifestPath = join(installedRoot, '.claude-plugin', 'plugin.json');
      if (!existsSync(installedManifestPath)) continue;

      const ownHooks = declaredHookPaths(ownManifestPath);
      const installedHooks = new Set(declaredHookPaths(installedManifestPath).map(({ event, rel }) => `${event}:${rel}`));
      const duplicates = [...new Set(ownHooks
        .filter(({ event, rel }) => installedHooks.has(`${event}:${rel}`))
        .map(({ event, rel }) => `${event}: ${rel.replace(/^\//, '')}`))];
      if (!duplicates.length) continue;
      return 'DUPLICATE HOOK REGISTRATION: workflow-toolbox is loaded from two roots:\n'
        + `- ${currentRoot}\n- ${installedRoot}\n`
        + `Hooks that run twice: ${duplicates.join(', ')}.\n`
        + `Disable one copy (${key} or the extra --plugin-dir root). This warning detects the enabled installed copy plus this hook's own CLAUDE_PLUGIN_ROOT; the SessionStart payload does not enumerate arbitrary other plugin roots.\n`;
    }
  }
  return null;
}

function main() {
  if (typeof payload?.agent_id === 'string' && payload.agent_id) return;
  const duplicateNotice = duplicateHookNotice();
  if (duplicateNotice) process.stdout.write(duplicateNotice);
  if (!existsSync(SCAN)) process.exit(0);

  const sessionId = typeof payload?.session_id === 'string' && payload.session_id ? payload.session_id : null;
  const scanArgs = [SCAN];
  if (sessionId) scanArgs.push('--session', sessionId);
  scanArgs.push('--quiet-min', '20');

  const res = spawnSync(process.execPath, scanArgs, {
    encoding: 'utf8',
    timeout: 10_000,
  });

  // Exit 1 means the scan found open + silent agents. Anything else (0 = clean, 2 = no registry,
  // null = timeout/crash) is not worth spending a session's context on.
  if (res.status === 1 && res.stdout) {
    process.stdout.write(
      'UNFINISHED AGENT ARCS from a previous session — the spawn registry has entries that were '
      + 'never closed. Nothing fires when an agent freezes or is killed, so these are exactly the '
      + 'cases no notification could have reported:\n\n'
      + res.stdout.trim()
      + '\n\nBefore relying on any of these, ASK each one (SendMessage). A substantive reply means '
      + 'it was working; "resumed from transcript" means it had died and is now back with its '
      + 'context. Close the loop either way.\n'
    );
  }

  // The standing gap, stated once, plainly. This hook sees only what happened BEFORE now.
  process.stdout.write(
    'Agent-liveness coverage: the spawn registry is checked at session start (just done). '
    + 'Mid-session silence is NOT covered unless a periodic scan is running — arm one if agents '
    + `will be working unattended: node ${SCAN} --session ${sessionId || '<session-id>'} --quiet-min 20\n`
  );
}

runFailOpenHook('wt-session-start-registry-hook.mjs', main);
process.exit(0);

#!/usr/bin/env node
// SubagentStart: places the rules a project lists for this agent type (WT_ROD_PRESERVE_RULES) in the sub-agent's first
// context, in the engine's served form, so its first matching act is not refused. It runs at every spawn: the cheap
// checks come before the resolution modules load. It never fails a spawn: any error prints nothing on stdout.
import { resolve } from 'node:path';
import { configDirectory } from '../paths.js';
import { parsePreserveRules } from '../scripts/preserve-list.mjs';

async function readInput() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input || '{}');
}

const enabled = (env) => ['true', '1'].includes(env.CLAUDE_PLUGIN_OPTION_ENABLED);

// The rule names to serve, or null when this spawn gets nothing at all.
function listedRules(event, env) {
  if (!enabled(env)) return null;
  const type = event?.agent_type;
  if (typeof type !== 'string' || !type) return null;
  return parsePreserveRules(env.WT_ROD_PRESERVE_RULES).get(type) ?? null;
}

async function contextFor(event, env) {
  const names = listedRules(event, env);
  const configDir = names && configDirectory(env);
  if (!configDir) return '';
  // The engine resolves from the session root, or from the call's cwd without one: a cwd that differs is a second root.
  const agentDir = typeof event.cwd === 'string' && event.cwd ? resolve(event.cwd) : null;
  const root = resolve(env.CLAUDE_PROJECT_DIR || agentDir || process.cwd());
  const { preserveContext } = await import('../scripts/preserve-rules.mjs');
  return preserveContext({ names, root, agentDir, configDir });
}

async function main() {
  try {
    const context = await contextFor(await readInput(), process.env);
    if (context) {
      const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context } });
      process.stdout.write(output);
    }
  } catch (error) {
    const reason = String(error?.message ?? error).replace(/[\r\n]+/g, ' ');
    process.stderr.write(`wt-rules-on-demand: sub-agent pre-serve failed: ${reason}\n`);
  }
  process.exitCode = 0;
}

await main();

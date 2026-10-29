// Shared fixtures for the sub-agent pre-serve tests: temp config and project trees, rule texts, the hook subprocess.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';

export const hookScript = fileURLToPath(new URL('../hooks/subagent-start.mjs', import.meta.url));
export const startScript = fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url));

export function ruleText(body, trigger = "    - kind: 'tool'\n      tool: '^Bash$'\n      unconditional: 'true'\n      before-first-act: 'true'") {
  return `---\non-demand:\n  triggers:\n${trigger}\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\n${body}`;
}

// A body of exactly `size` characters that starts with a marker unique to it.
export const sizedBody = (marker, size) => `${marker} ${'x'.repeat(size - marker.length - 2)}\n`;

export async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'rod-preserve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const project = join(root, 'project');
  await mkdir(join(config, 'rules-on-demand'), { recursive: true });
  await mkdir(join(project, '.claude', 'rules-on-demand'), { recursive: true });
  return { root, config, project };
}

export async function put(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

export function runHook(input, env = {}) {
  const run = spawnSync(process.execPath, [hookScript], {
    encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify(input),
    env: cleanEnv({ CLAUDE_PLUGIN_OPTION_ENABLED: 'true', CLAUDE_PROJECT_DIR: '', ...env }),
  });
  return { ...run, json: run.stdout ? JSON.parse(run.stdout) : null };
}

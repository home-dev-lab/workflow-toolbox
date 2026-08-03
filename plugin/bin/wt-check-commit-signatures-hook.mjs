#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'wt-check-commit-signatures.mjs');
const GIT_COMMIT = /\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+commit\b/;

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main() {
  const input = readInput();
  if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return;
  if (input.tool_name && input.tool_name !== 'Bash') return;

  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !GIT_COMMIT.test(command)) return;
  if (!fs.existsSync(CLI)) return;

  let res;
  try {
    res = spawnSync(process.execPath, [CLI, '--repo', input.cwd || process.cwd()], {
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch {
    return;
  }
  if (!res || res.error || res.status !== 1) return;

  const stdout = String(res.stdout || '').trim();
  if (!stdout) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          'COMMIT SIGNATURE PROBLEM — the commit landed, but HEAD is missing an acceptable signature for this repository policy. Fix it before more history accumulates:\n' +
          stdout,
      },
    }),
  );
}

try {
  main();
} catch {
  // A hook that can break a session is not worth its output.
}

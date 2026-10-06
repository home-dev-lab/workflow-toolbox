import { openSync, closeSync, readSync, fstatSync, mkdirSync, readdirSync, statSync,
  writeFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { configDirectory } from '../paths.js';
import { sessionKey } from '../session-key.mjs';
import { scanPlan, scanTranscript, announcement } from '../scripts/unload-watch-lib.mjs';

const INPUT_CAP = 64 * 1024;
const STATE_CAP = 16 * 1024;
const MAX_FILES = 200;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function hookInput() {
  const chunks = [], buffer = Buffer.alloc(INPUT_CAP + 1);
  let length = 0;
  for (let count = readSync(0, buffer); count > 0; count = readSync(0, buffer)) {
    length += count;
    if (length > INPUT_CAP) throw new Error('Hook input exceeds bound');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input.session_id !== 'string' || !input.session_id
    || typeof input.transcript_path !== 'string' || !input.transcript_path
    || !['UserPromptSubmit', 'SessionStart', 'PreToolUse'].includes(input.hook_event_name)) {
    throw new Error('Incomplete hook input');
  }
  return input;
}

function readRange(fd, start, length) {
  const buffer = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const read = readSync(fd, buffer, count, length - count, start + count);
    if (!read) break;
    count += read;
  }
  return buffer.subarray(0, count);
}

function readState(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size > STATE_CAP) throw new Error('State exceeds bound');
    return JSON.parse(readRange(fd, 0, size).toString('utf8'));
  } catch { return null; }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* A bad state file never disables detection. */ }
    }
  }
}

function transcriptState(path, state) {
  const fd = openSync(path, 'r');
  try {
    const plan = scanPlan(fstatSync(fd).size, state);
    if (plan.start > 0) plan.align = readRange(fd, plan.start - 1, 1)[0] !== 10;
    return scanTranscript(readRange(fd, plan.start, plan.length), plan);
  } finally { closeSync(fd); }
}

function pruneState(dir, now) {
  const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile());
  if (files.length <= MAX_FILES) return;
  for (const file of files) {
    const path = join(dir, file.name);
    if (Date.parse(now) - statSync(path).mtimeMs > MAX_AGE) unlinkSync(path);
  }
}

function inflightPruneBatch(dir) {
  const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile())
    .sort((a, b) => a.name.localeCompare(b.name));
  const path = join(dir, '..', 'unload-watch', '.inflight-prune');
  let lastName = '';
  try { lastName = readState(path)?.lastName ?? ''; } catch { /* Start a new sweep if the cursor is unreadable. */ }
  const remaining = files.filter((entry) => entry.name.localeCompare(lastName) > 0);
  return { path, files: (remaining.length ? remaining : files).slice(0, MAX_FILES) };
}

function pruneInflight(dir, now) {
  try {
    const batch = inflightPruneBatch(dir);
    for (const file of batch.files) {
      try {
        const path = join(dir, file.name);
        if (Date.parse(now) - statSync(path).mtimeMs > MAX_AGE) unlinkSync(path);
      } catch { /* A raced or inaccessible file does not stop the remaining batch. */ }
    }
    // A persisted cursor prevents fresh files at the front from starving old sessions.
    saveState(batch.path, { lastName: batch.files.at(-1)?.name ?? '' });
  } catch { /* Missing/inaccessible recorder directories are normal. */ }
}

function saveState(path, state) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function main() {
  const input = hookInput();
  const config = configDirectory(process.env);
  const now = process.env.WT_ROD_NOW ?? new Date().toISOString();
  if (!config || !Number.isFinite(Date.parse(now))) return;
  const dir = join(config, 'plugins', 'data', 'wt-rules-on-demand', 'unload-watch');
  const session = sessionKey(input.session_id);
  const path = join(dir, `${session}.json`);
  const scanned = transcriptState(input.transcript_path, readState(path));
  const { state, output } = announcement(scanned, input, now);
  try {
    // Announce before committing warnedAt: duplicates are preferable to lost warnings.
    if (output) writeSync(1, JSON.stringify(output) + '\n');
    mkdirSync(dir, { recursive: true });
    saveState(path, state);
  } finally {
    pruneInflight(join(dir, '..', 'inflight'), now);
    try { pruneState(dir, now); } catch { /* Retention cannot consume a warning. */ }
  }
}

// This command hook survives a Function Hooks worker crash and never blocks a session on errors.
try { main(); } catch { /* Detection is best effort; stdout is reserved for complete announcements. */ }
process.exitCode = 0;

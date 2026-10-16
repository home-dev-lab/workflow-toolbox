#!/usr/bin/env node
// The compaction boundaries the host wrote to a session transcript since a byte offset, for the main loop's compaction
// detection (hooks.js). A transcript can be far larger than one `$.fs.read` (4 MiB), so the hook runs this file as a
// child process: it reads only the bytes past the offset, in fixed-size chunks, and prints one JSON line
// `{ path, offset, size, identity, tail, restarted, partial, boundaries: [{ uuid, timestamp }] }`.
// - `--snapshot` reads nothing: `offset` is the end of the last complete line, where the next scan starts.
// - An unfinished last line is left for the next scan: `offset` stops at the last complete line. A line longer than
//   MAX_LINE_BYTES is skipped (a boundary row is about 1.5 KB), so an unfinished line never holds more than that; the
//   offset moves past the bytes skipped, so a scan stopped inside such a line resumes further on.
// - `--budget-ms` bounds the reading time: past it the scan stops at the last complete line read and says `partial`,
//   and the next scan resumes there.
// - `tail` is the base64 of the bytes just before `offset` (TAIL_BYTES at most). A scan given `--tail` compares them
//   first: a file replaced (another device:inode), shorter than the offset, or whose bytes before the offset changed
//   (truncated, then written again past it) is read again from 0 and says `restarted`. `identity` is null where the
//   filesystem reports inode 0; only the size and `tail` checks apply there.
// - A missing transcript is searched for once under `--projects` by its file name (`<session>.jsonl`): the hook derives
//   the path from the session's root, which `/cd` or a very long path can make differ from where the host writes it.
// Usage: compact-boundary.mjs --transcript <file> [--snapshot] [--from <offset>] [--identity <dev:ino>] [--tail <base64>]
//        [--budget-ms <ms>] [--projects <dir> --session <id>]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHUNK_BYTES = 64 * 1024;
export const MAX_LINE_BYTES = 256 * 1024;
const TAIL_BYTES = 64;
// `dev:ino`, or null when the filesystem reports no inode (0, as some Windows and network filesystems do): two files there
// can share one string, so an identity is only a fact when its inode is set.
export const identityOf = (stat) => (stat.ino ? `${stat.dev}:${stat.ino}` : null);

// Main-loop compaction boundaries only: a sub-agent's rows are sidechain rows.
export function boundaryRows(text) {
  return text.split('\n').map(boundaryOf).filter(Boolean);
}
function boundaryOf(line) {
  if (!line.includes('compact_boundary')) return null;
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (!mainBoundary(row)) return null;
  return { uuid: row.uuid, timestamp: typeof row.timestamp === 'string' ? row.timestamp : null };
}
const mainBoundary = (row) => row?.type === 'system' && row.subtype === 'compact_boundary' && row.isSidechain !== true &&
  typeof row.uuid === 'string' && row.uuid !== '';

// Complete lines only, from `start`; a start inside a line (a cursor from another file) skips to the next line.
function readLines(fd, start, size, { chunkBytes, budgetMs, now }) {
  const prior = Buffer.alloc(1);
  const state = { skip: start > 0 && fs.readSync(fd, prior, 0, 1, start - 1) === 1 && prior[0] !== 10, parts: [], partBytes: 0, offset: start, boundaries: [] };
  const began = now();
  let pos = start;
  while (pos < size && !(budgetMs !== null && now() - began > budgetMs)) {
    const bytes = Buffer.alloc(Math.min(chunkBytes, size - pos));
    const read = fs.readSync(fd, bytes, 0, bytes.length, pos);
    if (read === 0) break;
    consume(state, bytes.subarray(0, read), pos);
    pos += read;
  }
  return { offset: state.offset, boundaries: state.boundaries, partial: pos < size };
}
// Exported for a test: an unfinished line is held only up to MAX_LINE_BYTES.
export function consume(state, bytes, pos) {
  let begin = 0;
  for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, begin)) {
    if (!state.skip && state.partBytes + end - begin <= MAX_LINE_BYTES) state.boundaries.push(...boundaryRows(Buffer.concat([...state.parts, bytes.subarray(begin, end)]).toString('utf8')));
    state.parts = [];
    state.partBytes = 0;
    state.skip = false;
    begin = end + 1;
    state.offset = pos + begin;
  }
  if (begin >= bytes.length) return;
  if (!state.skip) {
    state.partBytes += bytes.length - begin;
    if (state.partBytes <= MAX_LINE_BYTES) {
      state.parts.push(Buffer.from(bytes.subarray(begin)));
      return;
    }
    state.parts = [];
    state.skip = true;
  }
  // A line given up (past the cap, or entered part-way) is skipped to its end, and the offset moves past what was
  // dropped: a scan stopped by its budget inside it resumes further on, never at the same place.
  state.offset = pos + bytes.length;
}

// The end of the last complete line at or before `size`, searched back over MAX_LINE_BYTES at most; else `size` (a scan
// starting inside a line skips to the next one).
function lineEnd(fd, size, chunkBytes) {
  for (let end = size; end > 0 && size - end <= MAX_LINE_BYTES; end -= chunkBytes) {
    const length = Math.min(chunkBytes, end);
    const bytes = Buffer.alloc(length);
    fs.readSync(fd, bytes, 0, length, end - length);
    const last = bytes.lastIndexOf(10);
    if (last !== -1) return end - length + last + 1;
  }
  return size;
}
function tailOf(fd, offset) {
  const length = Math.min(TAIL_BYTES, offset);
  const bytes = Buffer.alloc(length);
  fs.readSync(fd, bytes, 0, length, offset - length);
  return bytes.toString('base64');
}

function locate(file, projects, session) {
  if (fs.existsSync(file) || !projects || !session) return file;
  let entries;
  try { entries = fs.readdirSync(projects, { withFileTypes: true }); } catch { return file; }
  for (const entry of entries) {
    const candidate = path.join(projects, entry.name, `${session}.jsonl`);
    if (entry.isDirectory() && fs.existsSync(candidate)) return candidate;
  }
  return file;
}

// `chunkBytes` and `now` (the clock the budget reads) are for tests.
export function scanTranscript(request, { chunkBytes = CHUNK_BYTES, now = Date.now } = {}) {
  const found = locate(request.file, request.projects, request.session);
  const fd = openTranscript(found);
  if (fd === null) return { path: found, offset: 0, size: 0, identity: null, tail: '', restarted: false, partial: false, boundaries: [], missing: true };
  try {
    const stat = fs.fstatSync(fd), identity = identityOf(stat);
    if (request.snapshot) {
      const offset = stat.size ? lineEnd(fd, stat.size, chunkBytes) : 0;
      return { path: found, offset, size: stat.size, identity, tail: tailOf(fd, offset), restarted: false, partial: false, boundaries: [] };
    }
    const asked = request.from ?? 0;
    const from = keepsPlace(fd, stat, identity, { ...request, from: asked }) ? asked : 0;
    const scan = readLines(fd, from, stat.size, { chunkBytes, budgetMs: request.budgetMs ?? null, now });
    return { path: found, ...scan, size: stat.size, identity, tail: tailOf(fd, scan.offset), restarted: from !== asked };
  } finally { fs.closeSync(fd); }
}
function openTranscript(file) {
  try { return fs.openSync(file, 'r'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
// The same file (device:inode), at least as long as the offset, and the bytes before the offset unchanged.
function keepsPlace(fd, stat, identity, { from, identity: was = null, tail = null }) {
  if ((was !== null && was !== identity) || stat.size < from) return false;
  return tail === null || tailOf(fd, from) === tail;
}

export function parseArgs(argv) {
  const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const file = value('--transcript'), from = Number(value('--from') ?? 0), budgetMs = value('--budget-ms') === undefined ? null : Number(value('--budget-ms'));
  if (!file || !validNumbers(from, budgetMs)) {
    throw new Error('usage: compact-boundary.mjs --transcript <file> [--snapshot] [--from <offset>] [--identity <dev:ino>] [--tail <base64>] [--budget-ms <ms>] [--projects <dir> --session <id>]');
  }
  return { file, from, budgetMs, snapshot: argv.includes('--snapshot'), identity: value('--identity') ?? null, tail: value('--tail') ?? null,
    projects: value('--projects') ?? null, session: value('--session') ?? null };
}
const validNumbers = (from, budgetMs) => Number.isSafeInteger(from) && from >= 0 && (budgetMs === null || budgetMs >= 0);

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(scanTranscript(parseArgs(process.argv.slice(2))))); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

// Preserve-in-place adapter: host reads and byte-range writes never replace prompt files.
import { locateReplacements } from './prompt-storage.js';

let storageFailureNoticed = false;
let toolStorageFailureNoticed = false;
const joinPath = (parent, ...parts) => [parent.replace(/[\\/]+$/, ''), ...parts.map((part) => String(part).replace(/^[\\/]+|[\\/]+$/g, ''))].join('/');

async function configDir($) {
  const configured = await $.configDir();
  if (configured) return configured;
  const home = await $.home();
  if (!home) throw new Error('home unavailable');
  return joinPath(home, '.claude');
}

const MAX_TAIL = 4 * 1024 * 1024;
function base64Utf8(value) {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function byteRange($, mode, path, offset, length, replacement = '') {
  if (await $.isWindows()) {
    const root = await $.pluginRoot();
    if (!root) throw new Error('plugin root unavailable');
    // Measured 2026-09-21: PowerShell positional argv reaches $args only with -File;
    // -Command appends trailing values to source and exposes paths to command injection.
    const argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-File', joinPath(root, 'hooks', 'prompt-storage-range.ps1'), path, String(offset), String(length), mode];
    if (mode === 'write') argv.push(base64Utf8(replacement));
    const result = await $.processRun(argv);
    if (mode !== 'read' || result?.exitCode !== 0) return result;
    const bytes = Uint8Array.from(atob(result.stdout), (character) => character.charCodeAt(0));
    return { ...result, stdout: new TextDecoder().decode(bytes) };
  }
  return mode === 'read'
    ? $.processRun(['dd', `if=${path}`, 'bs=1', `skip=${offset}`, `count=${length}`])
    : $.processRun(['dd', `of=${path}`, 'bs=1', `seek=${offset}`, 'conv=notrunc'], { stdin: replacement });
}

async function replaceByteRange($, path, change, identity) {
  if (await $.isWindows()) return byteRange($, 'write', path, change.offset, change.length, change.replacement);
  const root = await $.pluginRoot();
  if (!root) throw new Error('plugin root unavailable');
  return $.processRun(
    ['node', joinPath(root, 'hooks', 'prompt-storage-range.mjs'), path, String(change.offset), String(change.length), String(identity.inode ?? '')],
    { stdin: JSON.stringify({ expected: base64Utf8(change.expected), replacement: base64Utf8(change.replacement) }) },
  );
}

async function fileIdentity($, path) {
  const stat = await $.fsStat(path);
  const size = Number(stat?.size);
  const prefixLength = Math.min(64, size);
  const prefix = prefixLength ? await byteRange($, 'read', path, 0, prefixLength) : { exitCode: 0, stdout: '' };
  if (prefix?.exitCode !== 0) throw new Error('file identity unavailable');
  return { inode: stat?.ino ?? stat?.inode, size, prefix: prefix.stdout };
}

async function identityMatches($, path, original) {
  const current = await fileIdentity($, path);
  if (original.inode !== undefined && current.inode !== undefined) return original.inode === current.inode;
  return current.size >= original.size && current.prefix === original.prefix;
}

async function rewriteStoredPrompt($, path, replacements, target) {
  let identity;
  try { identity = await fileIdentity($, path); } catch (error) {
    if (error?.code === 'ENOENT' || String(error?.message).includes('ENOENT')) return false;
    throw error;
  }
  const length = Math.min(identity.size, MAX_TAIL);
  let offset = identity.size - length;
  const read = await byteRange($, 'read', path, offset, length);
  if (read?.exitCode !== 0) throw new Error('tail read failed');
  let text = read.stdout;
  if (offset) {
    const newline = text.indexOf('\n');
    if (newline < 0) return false;
    const discarded = text.slice(0, newline + 1);
    offset += new TextEncoder().encode(discarded).length;
    text = text.slice(newline + 1);
  }
  if (text && !text.endsWith('\n')) {
    try { JSON.parse(text.slice(text.lastIndexOf('\n') + 1)); } catch { return false; }
  }
  const changes = locateReplacements(text, replacements, target).map((change) => ({ ...change, offset: change.offset + offset }));
  for (const change of changes) {
    const compare = await byteRange($, 'read', path, change.offset, change.length);
    if (compare?.exitCode !== 0 || compare?.stdout !== change.expected) throw new Error('stored bytes changed');
    if (!await identityMatches($, path, identity)) throw new Error('stored file changed');
    const write = await replaceByteRange($, path, change, identity);
    if (write?.exitCode !== 0) throw new Error('in-place overwrite failed');
    const verify = await byteRange($, 'read', path, change.offset, change.length);
    if (verify?.exitCode !== 0 || verify?.stdout !== change.replacement) throw new Error('in-place verification failed');
  }
  return changes.length > 0;
}

export async function scrubPromptStorage($, replacements, signal) {
  try {
    const root = await configDir($);
    const cwd = await $.sessionCwd();
    const sessionId = await $.sessionId();
    const targets = [
      { path: joinPath(root, 'history.jsonl'), target: 'history' },
      { path: joinPath(root, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${sessionId}.jsonl`), target: 'queue' },
    ];
    let scrubbed = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      for (const target of targets) scrubbed = await rewriteStoredPrompt($, target.path, replacements, target.target) || scrubbed;
      if (scrubbed) return true;
      if (attempt < 4) await $.sleep(40, signal ? { signal } : undefined);
    }
    throw new Error('record not found');
  } catch {
    if (!storageFailureNoticed) {
      storageFailureNoticed = true;
      await $.uiLog('wt-secret-guard: could not scrub Claude Code prompt storage; a raw secret may remain in history.');
    }
  }
  return false;
}

export async function scrubToolUseStorage($, replacements, toolUseId, signal) {
  try {
    const root = await configDir($);
    const cwd = await $.sessionCwd();
    const sessionId = await $.sessionId();
    const path = joinPath(root, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${sessionId}.jsonl`);
    let scrubbed = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      scrubbed = await rewriteStoredPrompt($, path, replacements, { kind: 'tool-use', toolUseId }) || scrubbed;
      if (scrubbed) return true;
      if (attempt < 4) await $.sleep(40, signal ? { signal } : undefined);
    }
    throw new Error('record not found');
  } catch {
    if (!toolStorageFailureNoticed) {
      toolStorageFailureNoticed = true;
      await $.uiLog('wt-secret-guard: could not scrub a denied tool input from Claude Code storage; the call was refused but a raw secret may remain in its transcript.');
    }
    return false;
  }
}

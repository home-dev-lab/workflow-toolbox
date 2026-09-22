// Preserve-in-place adapter: host reads and byte-range writes never replace prompt files.
import { locateReplacements } from './prompt-storage.js';

let storageFailureNoticed = false;
const joinPath = (parent, ...parts) => [parent.replace(/[\\/]+$/, ''), ...parts.map((part) => String(part).replace(/^[\\/]+|[\\/]+$/g, ''))].join('/');

async function configDir($) {
  const configured = await $.configDir();
  if (configured) return configured;
  const home = await $.home();
  if (!home) throw new Error('home unavailable');
  return joinPath(home, '.claude');
}

async function rewriteStoredPrompt($, path, replacements, target) {
  let text;
  try { text = await $.fsRead(path); } catch (error) {
    if (error?.code === 'ENOENT' || String(error?.message).includes('ENOENT')) return false;
    throw error;
  }
  const changes = locateReplacements(text, replacements, target);
  for (const change of changes) {
    const read = await $.processRun(['dd', `if=${path}`, 'bs=1', `skip=${change.offset}`, `count=${change.length}`]);
    if (read?.exitCode !== 0 || read?.stdout !== change.expected) throw new Error('stored bytes changed');
    const write = await $.processRun(['dd', `of=${path}`, 'bs=1', `seek=${change.offset}`, 'conv=notrunc'], { stdin: change.replacement });
    if (write?.exitCode !== 0) throw new Error('in-place overwrite failed');
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
      if (attempt < 4) await $.sleep(40, signal ? { signal } : undefined);
    }
    if (!scrubbed) throw new Error('record not found');
  } catch {
    if (!storageFailureNoticed) {
      storageFailureNoticed = true;
      await $.uiLog('wt-secret-guard: could not scrub Claude Code prompt storage; a raw secret may remain in history.');
    }
  }
}

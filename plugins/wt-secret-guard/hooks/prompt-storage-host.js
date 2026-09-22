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

const POWERSHELL = '$p=$args[0];$o=[int64]$args[1];$n=[int]$args[2];$m=$args[3];$f=[IO.FileStream]::new($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite);try{$f.Seek($o,[IO.SeekOrigin]::Begin)>$null;if($m -eq "read"){$b=New-Object byte[] $n;$r=$f.Read($b,0,$n);[Console]::Write([Convert]::ToBase64String($b,0,$r))}else{$b=[Convert]::FromBase64String($args[4]);$f.Write($b,0,$b.Length);$f.Flush()}}finally{$f.Dispose()}';

async function byteRange($, mode, path, offset, length, replacement = '') {
  if (await $.isWindows()) {
    const argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL, path, String(offset), String(length), mode];
    if (mode === 'write') argv.push(btoa(replacement));
    const result = await $.processRun(argv);
    return mode === 'read' && result?.exitCode === 0 ? { ...result, stdout: atob(result.stdout) } : result;
  }
  return mode === 'read'
    ? $.processRun(['dd', `if=${path}`, 'bs=1', `skip=${offset}`, `count=${length}`])
    : $.processRun(['dd', `of=${path}`, 'bs=1', `seek=${offset}`, 'conv=notrunc'], { stdin: replacement });
}

async function rewriteStoredPrompt($, path, replacements, target) {
  let text;
  try { text = await $.fsRead(path); } catch (error) {
    if (error?.code === 'ENOENT' || String(error?.message).includes('ENOENT')) return false;
    throw error;
  }
  const changes = locateReplacements(text, replacements, target);
  for (const change of changes) {
    const read = await byteRange($, 'read', path, change.offset, change.length);
    if (read?.exitCode !== 0 || read?.stdout !== change.expected) throw new Error('stored bytes changed');
    const write = await byteRange($, 'write', path, change.offset, change.length, change.replacement);
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

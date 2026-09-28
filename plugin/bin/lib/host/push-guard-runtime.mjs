import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesGuardPath, normalizePushPath, recognizedPushShape } from './push-guard-identity.mjs';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const ZERO = /^0+$/;
const ENGINE = fileURLToPath(new URL('../../wt-push-scope-check.mjs', import.meta.url));

function stop(code, message) { console.error(message); process.exit(code); }
function git(args, options = {}) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60_000,
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options,
  }).trim();
}

export function isPinnedEngine(engine, canonicalInstallDir, platform = process.platform) {
  const expected = (platform === 'win32' ? win32 : posix).join(canonicalInstallDir, 'bin/wt-push-scope-check.mjs');
  return platform === 'win32' ? engine.toLowerCase() === expected.toLowerCase() : engine === expected;
}

function verifyInstall(dir) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); }
  catch { stop(2, `manifest.json missing or malformed; run wt-push-guard-install.mjs --check / --install`); }
  if (!manifest.files || typeof manifest.files !== 'object' || !Object.keys(manifest.files).includes('config.json')) stop(2, 'manifest.json incomplete; run wt-push-guard-install.mjs --check / --install');
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (name.startsWith('/') || name.split('/').includes('..')) stop(2, `invalid manifest path ${name}; run wt-push-guard-install.mjs --check / --install`);
    try {
      if (createHash('sha256').update(readFileSync(join(dir, name))).digest('hex') !== hash) throw Error('hash mismatch');
    } catch { stop(2, `${name} missing or changed; run wt-push-guard-install.mjs --check / --install`); }
  }
  let pinned = false;
  try { pinned = isPinnedEngine(ENGINE, realpathSync(dir)); }
  catch { /* An unresolved engine is not pinned. */ }
  if (!Object.keys(manifest.files).includes('bin/wt-push-scope-check.mjs') || !pinned) stop(2, 'engine not installed; run wt-push-guard-install.mjs --check / --install');
  try { return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')); }
  catch { stop(2, 'config.json malformed; run wt-push-guard-install.mjs --check / --install'); }
}

function identity(config, remote, url, authorized) {
  const baseDir = process.cwd();
  const names = config.guardRemotes;
  const paths = config.guardPaths;
  if (!Array.isArray(names) || !Array.isArray(paths) || (!names.length && !paths.length)) stop(2, 'guard config has no identities');
  let normalized;
  try { if (recognizedPushShape(url)) normalized = normalizePushPath(url, baseDir); }
  catch (err) {
    // A missing local destination and remote-helper syntax remain unmeasurable.
    if (/relative local path not found/.test(err.message)) throw err;
  }
  if (normalized === undefined && /^[^/]+::/.test(url)) throw Error(`unmeasurable push URL: ${url}`);
  if (normalized === undefined && !readScope(authorized)) {
    stop(2, `wt-push-scope-check: unmeasurable push URL: ${url}; the guard could not recognise its form. Push through the named remote (git push <remote> …), or use a standard URL / absolute path; to publish to the guarded repository, write the single-use authorization at ${authorized}`);
  }
  let guarded = normalized === undefined || names.includes(remote) || matchesGuardPath(url, paths, baseDir);
  for (const name of names) {
    for (const args of [['remote', 'get-url', '--all', name], ['remote', 'get-url', '--push', '--all', name]]) {
      try { if (normalized !== undefined && git(args).split('\n').some((item) => normalizePushPath(item, baseDir) === normalized)) guarded = true; }
      catch { /* A configured remote may not exist in this checkout. */ }
    }
  }
  if (guarded && remote && git(['remote']).split('\n').includes(remote)) {
    const urls = git(['remote', 'get-url', '--push', '--all', remote]).split('\n').filter(Boolean);
    if (urls.length > 1) stop(2, 'multiple push URLs on a guarded remote are not supported: push each URL separately');
  }
  return guarded;
}

function linesFromStdin() {
  const text = readFileSync(0, 'utf8');
  return text.split('\n').filter((line, index, lines) => index !== lines.length - 1 || line !== '').map((line) => {
    const parts = line.split(' ');
    if (parts.length !== 4 || !parts[0] || !parts[2] || !SHA.test(parts[1]) || !SHA.test(parts[3])) stop(2, `malformed pre-push stdin line: ${line}`);
    return { localRef: parts[0], local: parts[1], remoteRef: parts[2], remote: parts[3] };
  });
}

function ancestryCheck() {
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false' || Object.hasOwn(process.env, 'GIT_GRAFT_FILE') || existsSync(git(['rev-parse', '--git-path', 'info/grafts']))) stop(2, 'shallow repository or grafted history: outgoing commits cannot be measured');
}

function advertised(url) {
  if (git(['ls-remote', '--get-url', url]) !== url) stop(2, 'the push URL is rewritten again; the lookup would contact another repository');
  const listing = git(['ls-remote', '--heads', '--tags', url]);
  const ids = [...new Set(listing.split('\n').map((line) => line.split('\t')[0]).filter((s) => SHA.test(s)))];
  if (!ids.length) return [];
  const types = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${ids.join('\n')}\n` });
  return types.split('\n').filter((line) => / (commit|tag)$/.test(line)).map((line) => line.split(' ')[0]);
}

function outgoing(lines, url) {
  const shas = new Set();
  let known;
  for (const line of lines) {
    if (ZERO.test(line.local)) continue;
    let local;
    try { local = git(['rev-parse', '--verify', '--quiet', `${line.local}^{commit}`]); }
    catch { throw Error(`local ref ${line.localRef} is not a commit in this clone`); }
    let exclusions;
    if (ZERO.test(line.remote)) {
      known ??= advertised(url);
      exclusions = known;
    } else {
      try { exclusions = [git(['rev-parse', '--verify', '--quiet', `${line.remote}^{commit}`])]; }
      catch { throw Error(`the destination tip ${line.remote} is not in this clone (fetch first)`); }
    }
    const result = git(['rev-list', '--stdin', local], { input: exclusions.map((s) => `^${s}\n`).join('') });
    for (const sha of result.split('\n').filter(Boolean)) shas.add(sha);
  }
  return [...shas];
}

function readScope(path) {
  let bytes;
  try { bytes = readFileSync(path); } catch { return null; }
  let scope;
  try { scope = JSON.parse(bytes.toString('utf8')); }
  catch { stop(2, `authorization FILE malformed: ${path}`); }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
    (!Array.isArray(scope.commits) && !(typeof scope.maxCount === 'number' && Number.isSafeInteger(scope.maxCount) && scope.maxCount >= 0)) ||
    (scope.commits !== undefined && (!Array.isArray(scope.commits) || scope.commits.some((s) => typeof s !== 'string' || !/^[0-9a-f]{7,64}$/i.test(s.trim()))))) stop(2, `authorization FILE malformed: ${path}`);
  return { bytes, scope };
}

function refusalHelp(path, shas, reason = 'no outgoing commits') {
  const parent = dirname(path);
  const consumed = readdirSync(parent).filter((s) => /^wt-push-authorized\.consumed-.*\.json$/.test(s)).sort().at(-1);
  const lastConsumed = consumed ? '; last consumed: ' + join(parent, consumed) : '';
  const commits = shas.length ? shas.join(' ') : '(none computed — ' + reason + ')';
  const scope = JSON.stringify({ commits: shas });
  console.error(`wt-push-scope-check: single-use authorization missing: ${path}${lastConsumed}`);
  console.error(`commits this push sends: ${commits}`);
  console.error(`printf '%s\\n' '${scope}' > '${path.replaceAll("'", "'\\''")}'`);
  console.error(`alternative: {"maxCount": ${shas.length}}`);
  console.error('One authorization covers one approved hook attempt; a failed push or --dry-run still consumes it.');
  stop(1, 'wt-push-scope-check: authorization check refused');
}

function judge(auth, shas) {
  const { scope } = auth;
  const offending = Array.isArray(scope.commits) ? shas.filter((sha) => !scope.commits.some((item) => sha.startsWith(item.trim().toLowerCase()))) : shas.slice(scope.maxCount);
  for (const sha of offending) {
    let subject = '';
    try { subject = git(['show', '-s', '--no-show-signature', '--format=%s', sha]); } catch { /* cosmetic */ }
    console.error(`UNAUTHORIZED COMMIT: ${sha.slice(0, 12)} ${subject}`);
  }
  if (offending.length) stop(1, `wt-push-scope-check: ${offending.length} commit(s) outside the authorized scope — scope check refused`);
}

function signatures(lines, dir) {
  const checker = join(dir, 'bin/wt-check-commit-signatures.mjs');
  for (const line of lines) {
    if (ZERO.test(line.local)) continue;
    if (ZERO.test(line.remote)) { console.log(`signature check NOT RUN for ${line.remoteRef} (new remote ref, no base to range against)`); continue; }
    if (!existsSync(checker)) { console.log('signature check NOT RUN (checker absent)'); continue; }
    const result = spawnSync(process.execPath, [checker, '--range', `${line.remote}..${line.local}`], { encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
    if (result.status !== 0) stop(1, `${result.stdout || ''}${result.stderr || ''}unsigned — the authorized SCOPE was fine; signature check refused`);
  }
}

export function runPrePush({ installDir, remote, url, authorized, afterConsume = () => {} }) {
  try {
    const config = verifyInstall(installDir);
    if (!identity(config, remote, url, authorized)) { readFileSync(0); return; }
    const lines = linesFromStdin();
    ancestryCheck();
    const auth = readScope(authorized);
    let shas;
    try { shas = outgoing(lines, url); }
    catch (err) {
      if (!auth) refusalHelp(authorized, [], `could not measure outgoing commits: ${err.message}`);
      stop(2, `could not measure outgoing commits: ${err.message}`);
    }
    if (!auth) refusalHelp(authorized, shas);
    judge(auth, shas);
    signatures(lines, installDir);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const consumed = join(dirname(authorized), `wt-push-authorized.consumed-${stamp}-${process.pid}.json`);
    try { renameSync(authorized, consumed); afterConsume(consumed); if (!readFileSync(consumed).equals(auth.bytes)) throw Error('authorization changed after rename'); }
    catch (err) { stop(1, `authorization consume check refused: ${err.message}`); }
    console.log(`pre-push: authorization consumed -> ${consumed}`);
    console.log(shas.length ? `wt-push-scope-check: all ${shas.length} commit(s) covered by authorized scope — OK` : 'wt-push-scope-check: no commits to push — OK');
  } catch (err) { stop(2, `wt-push-scope-check: cannot measure push: ${err.message}`); }
}

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandIO } from './command-io.mjs';

const bin = fileURLToPath(new URL('../../', import.meta.url));
const template = join(bin, 'git-hooks', 'pre-push');
const files = [
  'bin/wt-push-scope-check.mjs', 'bin/wt-check-commit-signatures.mjs',
  'bin/lib/cli-help.mjs', 'bin/lib/commit-signature-core.mjs',
  'bin/lib/host/push-guard-identity.mjs', 'bin/lib/host/push-guard-runtime.mjs',
];
const help = 'Usage: wt-push-guard-install.mjs (--install | --check) --repo <path> [--guard-remote <name>] [--guard-path <owner/repo>] [--replace-existing]';
function fail(code, message) { console.error(message); process.exit(code); }
function git(repo, ...args) {
  const result = commandIO.run('git', ['-C', repo, ...args], { cwd: repo });
  if (result.status !== 0) throw Object.assign(new Error(result.stderr), { status: result.status });
  return result.stdout.trim();
}
function hash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function source(name) { return join(dirname(bin), name); }
function parse(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(help); process.exit(0); }
  const result = { mode: null, repo: null, guardRemotes: [], guardPaths: [], replace: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--install' || a === '--check') {
      if (result.mode) fail(2, help);
      result.mode = a;
    }
    else if (a === '--replace-existing') result.replace = true;
    else if (['--repo', '--guard-remote', '--guard-path'].includes(a)) {
      const value = args[++i];
      if (!value) fail(2, `${a} requires a value`);
      if (a === '--repo') result.repo = value;
      else result[a === '--guard-remote' ? 'guardRemotes' : 'guardPaths'].push(value);
    } else fail(2, `unknown argument: ${a}`);
  }
  if (!result.mode || !result.repo || (result.mode === '--install' && !result.guardRemotes.length && !result.guardPaths.length)) fail(2, help);
  return result;
}
function hooksPath(repo) {
  try { return git(repo, 'config', '--get', 'core.hooksPath'); }
  catch (err) {
    if (err.status === 1) return null;
    throw err;
  }
}
function paths(repo) {
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const hooks = join(common, 'hooks');
  return { hooks, shim: join(hooks, 'pre-push'), installed: join(hooks, 'wt-push-guard') };
}
function marker() { return `${Date.now()}-${process.pid}`; }

function install(opts, p, fsOps) {
  if (hooksPath(opts.repo) !== null) fail(2, 'core.hooksPath is set; unset it before installing the guard');
  mkdirSync(p.hooks, { recursive: true });
  const previous = existsSync(p.shim) ? readFileSync(p.shim) : null;
  if (previous && !previous.equals(readFileSync(template)) && !opts.replace) fail(2, 'foreign pre-push hook: pass --replace-existing to keep a backup');
  const stage = join(p.hooks, `wt-push-guard.stage-${marker()}`);
  const old = join(p.hooks, `wt-push-guard.old-${marker()}`);
  const shimStage = join(p.hooks, `pre-push.stage-${marker()}`);
  const backup = join(p.hooks, `pre-push.replaced-${marker()}`);
  let moved = false;
  let placed = false;
  let savedHook = false;
  try {
    mkdirSync(stage);
    const digests = {};
    for (const name of files) {
      const dest = join(stage, name);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source(name), dest);
      digests[name] = hash(dest);
    }
    const config = join(stage, 'config.json');
    writeFileSync(config, JSON.stringify({ guardRemotes: opts.guardRemotes, guardPaths: opts.guardPaths }) + '\n');
    digests['config.json'] = hash(config);
    let rev = null;
    try { rev = git(bin, 'rev-parse', 'HEAD'); } catch { /* installed outside a source checkout */ }
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ sourceDir: bin, sourceRev: rev, installedAt: new Date().toISOString(), shimHash: hash(template), files: digests }, null, 2) + '\n');
    copyFileSync(template, shimStage);
    chmodSync(shimStage, 0o755);
    if (existsSync(p.installed)) { fsOps.renameSync(p.installed, old); moved = true; }
    fsOps.renameSync(stage, p.installed);
    placed = true;
    if (previous) { renameSync(p.shim, backup); savedHook = true; }
    renameSync(shimStage, p.shim);
  } catch (err) {
    if (placed) rmSync(p.installed, { recursive: true, force: true });
    if (moved) fsOps.renameSync(old, p.installed);
    if (savedHook) { rmSync(p.shim, { force: true }); renameSync(backup, p.shim); }
    rmSync(stage, { recursive: true, force: true });
    rmSync(shimStage, { force: true });
    fail(2, `install failed: ${err.message}`);
  }
  // The replacement is live. Discarding the old copy cannot roll back a committed installation.
  if (moved) { try { fsOps.rmSync(old, { recursive: true }); } catch (err) { console.error(`warning: old push guard cleanup failed: ${err.message}`); } }
  if (savedHook && previous.equals(readFileSync(template))) { try { rmSync(backup); } catch (err) { console.error(`warning: old pre-push cleanup failed: ${err.message}`); } }
  console.log(`installed pinned push guard at ${p.shim}`);
}

function check(opts, p) {
  if (!existsSync(p.installed) || !existsSync(p.shim)) fail(2, 'push guard not installed');
  const broken = [];
  const ahead = [];
  if (hooksPath(opts.repo) !== null) broken.push('core.hooksPath is set');
  try {
    if (lstatSync(p.shim).isSymbolicLink()) broken.push('pre-push shim is a symlink');
    // On Windows Node's X_OK only checks existence; Git for Windows uses its own shell rules.
    try { accessSync(p.shim, constants.X_OK); } catch { broken.push('pre-push shim not executable'); }
  } catch { broken.push('pre-push shim unreadable'); }
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(p.installed, 'manifest.json'), 'utf8')); }
  catch { fail(1, 'manifest.json missing or malformed'); }
  try {
    if (!manifest.shimHash || hash(p.shim) !== manifest.shimHash) broken.push('pre-push shim edited');
    if (hash(template) !== manifest.shimHash) ahead.push('pre-push shim source differs; reinstall suggested');
  } catch { broken.push('pre-push shim unreadable'); }
  if (!manifest.files || files.some((name) => !Object.hasOwn(manifest.files, name)) || !Object.hasOwn(manifest.files, 'config.json')) broken.push('manifest incomplete');
  if (opts.guardRemotes.length || opts.guardPaths.length) {
    try {
      const config = JSON.parse(readFileSync(join(p.installed, 'config.json'), 'utf8'));
      for (const [key, requested] of [['guardRemotes', opts.guardRemotes], ['guardPaths', opts.guardPaths]]) {
        if (requested.length && (!Array.isArray(config[key]) || JSON.stringify(config[key]) !== JSON.stringify(requested))) broken.push(`${key} mismatch`);
      }
    } catch { broken.push('config.json missing or malformed'); }
  }
  for (const [name, expected] of Object.entries(manifest.files ?? {})) {
    if (name.startsWith('/') || name.split('/').includes('..')) { broken.push(`unsafe manifest entry ${name}`); continue; }
    const installed = join(p.installed, name);
    if (!existsSync(installed) || hash(installed) !== expected) broken.push(`${name} missing or edited`);
    if (files.includes(name) && (!existsSync(source(name)) || hash(source(name)) !== expected)) ahead.push(`${name} source differs; reinstall suggested`);
  }
  if (broken.length) fail(1, broken.join('\n'));
  if (ahead.length) fail(3, ahead.join('\n'));
  console.log('push guard installation intact — OK');
}

export function runInstaller(args, fsOps = { renameSync, rmSync }) {
  try {
    const opts = parse(args);
    const p = paths(resolve(opts.repo));
    if (opts.mode === '--install') install(opts, p, fsOps); else check(opts, p);
  } catch (err) { fail(2, `push guard installer: ${err.message}`); }
}

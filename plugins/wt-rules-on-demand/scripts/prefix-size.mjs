#!/usr/bin/env node
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ancestorsOf, projectRuleRoots, sameDirectory } from '../paths.js';
import { linkedWorktree } from './worktree-node.mjs';

const missing = (error) => ['ENOENT', 'ENOTDIR'].includes(error.code);
const inside = (path, root) => sameDirectory(path, root) || (!relative(root, path).startsWith('..' + sep) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));

export function limitsFor(contextTokens = 1000000) {
  const perFileLimit = Math.max(40000, Math.round(contextTokens * 0.05 * 3));
  return { contextTokens, perFileLimit, totalLimit: Math.max(120000, perFileLimit) };
}

// A YAML list item or scalar without its dash and quotes.
function scalarValue(value) {
  let text = value.trim();
  while (text.startsWith('-')) text = text.slice(1).trim();
  if (text.startsWith("'") || text.startsWith('"')) text = text.slice(1);
  if (text.endsWith("'") || text.endsWith('"')) text = text.slice(0, -1);
  return text.trim();
}

export function instructionContent(raw) {
  let text = raw;
  let conditional = false;
  if (/^---\s*\r?\n/.test(text)) {
    const end = /^---\s*$/m.exec(text.slice(text.indexOf('\n') + 1));
    if (end) {
      const offset = text.indexOf('\n') + 1;
      const header = text.slice(offset, offset + end.index);
      const paths = /^paths:([^\n]*)$/m.exec(header);
      if (paths) {
        const next = header.slice(header.indexOf(paths[0]) + paths[0].length).split('\n');
        const values = [paths[1], ...next.filter((line) => /^\s*-\s+/.test(line)).map((line) => line.replace(/^\s*-\s+/, ''))]
          .map((value) => scalarValue(value).replace(/\/\*\*$/, '')).filter(Boolean);
        conditional = values.some((value) => value !== '**');
      }
      text = text.slice(offset + end.index + end[0].length).replace(/^\r?\n/, '');
    }
  }
  let fenced = false, comment = false, block = '';
  let result = '';
  for (const line of text.split(/(?<=\n)/).filter(Boolean)) {
    if (!comment && /^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && (comment || /^\s*<!--/.test(line))) {
      block += line;
      if (line.includes('-->')) {
        const leftover = block.replace(/<!--[\s\S]*?-->/g, '');
        // The harness drops the comment and keeps the block's line end (calibrated: 186,591 chars on a real profile).
        result += leftover.trim() ? leftover : (/\r?\n$/.exec(block)?.[0] ?? '');
        block = ''; comment = false;
      } else comment = true;
    } else result += line;
  }
  return { content: result, conditional };
}

async function walkMarkdown(dir, errors, visited = new Set()) {
  // The harness follows symlinked rule directories; a loop is walked once.
  const real = await realpath(dir).catch(() => dir);
  if (visited.has(real)) return [];
  visited.add(real);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if (!missing(error)) errors.push(`${dir}: ${error.message}`);
    return [];
  }
  const files = [];
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    let directory = entry.isDirectory();
    if (entry.isSymbolicLink()) directory = await stat(path).then((info) => info.isDirectory(), (error) => {
      if (!missing(error)) errors.push(`${path}: ${error.message}`);
      return false;
    });
    if (directory) files.push(...await walkMarkdown(path, errors, visited));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

function managedDefault() {
  if (process.platform === 'win32') return join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode');
  return process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
}

function imports(text) {
  let fenced = false;
  const found = [];
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced) for (const match of line.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) found.push(match[1].replace(/\\ /g, ' ').split('#')[0]);
  }
  return found;
}

export async function staticPrefix({ configDir, cwd, top, managedDir = managedDefault(), contextTokens = 1000000, totalLimit, perFileLimit, configMissing = false } = {}) {
  const positive = (value, name) => { if (value !== undefined && !(Number.isFinite(value) && value > 0)) throw new Error(`${name} must be a positive number, got ${value}`); };
  positive(contextTokens, 'context tokens');
  positive(totalLimit, 'total limit');
  positive(perFileLimit, 'per-file limit');
  const limits = limitsFor(contextTokens);
  totalLimit ??= limits.totalLimit;
  perFileLimit ??= limits.perFileLimit;
  configDir = resolve(configDir ?? join(homedir(), '.claude'));
  cwd = resolve(cwd ?? process.cwd());
  const files = [], errors = [], skippedImports = [], seen = new Set();
  const ancestors = ancestorsOf(cwd).filter((dir) => !sameDirectory(dir, dirname(dir)) && (!top || inside(dir, resolve(top))));
  const configReal = await realpath(configDir).catch(() => configDir);
  // configMissing: the caller saw the directory absent before it created anything under it.
  if (configMissing) errors.push(`config dir ${configDir}: missing`);
  else await stat(configDir).catch((error) => errors.push(`config dir ${configDir}: ${error.message}`));
  const cwdReal = await realpath(cwd).catch(() => cwd);
  const worktree = await linkedWorktree(cwd);
  if (worktree.unknown) errors.push(worktree.unknown);
  const project = projectRuleRoots(cwd, { configDir, ...worktree });
  let totalChars = 0, loadedChars = 0;
  async function add(path, type, depth = 0, rawOverride) {
    let physical, raw;
    try {
      physical = rawOverride === undefined ? await realpath(path) : path;
      if (seen.has(physical)) return;
      if (rawOverride === undefined) {
        const info = await stat(path);
        if (info.size > 4 * 1024 * 1024 || !info.isFile()) return;
        raw = await readFile(path, 'utf8');
      } else raw = rawOverride;
    } catch (error) {
      if (!missing(error)) errors.push(`${path}: ${error.message}`);
      return;
    }
    seen.add(physical);
    const { content, conditional } = instructionContent(raw);
    if (conditional || !content.trim()) return;
    const chars = content.length;
    const row = { path, type, chars };
    loadedChars += chars;
    // Out of the harness's combined count (it warns about this file on its own), yet loaded into every session.
    if (chars > perFileLimit) row.overFileLimit = true;
    else totalChars += chars;
    files.push(row);
    if (depth >= 4 || rawOverride !== undefined) return;
    for (const name of imports(content)) {
      if (!/^(?:\.\/|~\/|\/|[A-Za-z0-9._-])/.test(name)) continue;
      const target = name.startsWith('~/') ? resolve(homedir(), name.slice(2)) : resolve(dirname(path), name);
      if (!['.md', '.txt'].includes(extname(target).toLowerCase())) continue;
      const actual = await realpath(target).catch((error) => {
        if (!missing(error)) errors.push(`${target}: ${error.message}`);
        return target;
      });
      if (type !== 'user' && type !== 'managed' && !inside(actual, cwdReal)) { skippedImports.push(target); continue; }
      await add(target, type, depth + 1);
    }
  }
  await add(join(managedDir, 'CLAUDE.md'), 'managed');
  try {
    const settings = JSON.parse(await readFile(join(managedDir, 'managed-settings.json'), 'utf8'));
    if (typeof settings.claudeMd === 'string') await add(join(managedDir, 'managed-settings.json'), 'managed', 0, settings.claudeMd);
  } catch (error) { if (!missing(error)) errors.push(`${managedDir}/managed-settings.json: ${error.message}`); }
  await add(join(configDir, 'CLAUDE.md'), 'user');
  for (const file of await walkMarkdown(join(configDir, 'rules'), errors)) await add(file, 'user');
  let hasClaude = false;
  for (const dir of ancestors) {
    const candidates = [join(dir, 'CLAUDE.md'), join(dir, '.claude', 'CLAUDE.md'), join(dir, 'CLAUDE.local.md')];
    for (const file of candidates) {
      if (sameDirectory(await realpath(file).catch(() => file), join(configReal, 'CLAUDE.md'))) continue;
      try { await stat(file); hasClaude = true; } catch (error) { if (!missing(error)) errors.push(`${file}: ${error.message}`); }
    }
    // The harness gates CLAUDE.md, .claude/CLAUDE.md and .claude/rules on the project test, never CLAUDE.local.md.
    if (!project.includes(dir) && !sameDirectory(await realpath(join(dir, '.claude')).catch(() => join(dir, '.claude')), configReal)) {
      await add(candidates[2], 'local');
      continue;
    }
    await add(candidates[0], 'project');
    await add(candidates[1], 'project');
    if (project.includes(dir)) for (const file of await walkMarkdown(join(dir, '.claude', 'rules'), errors)) await add(file, 'project');
    await add(candidates[2], 'local');
  }
  if (!hasClaude) for (const dir of ancestors) for (const file of [join(dir, 'AGENTS.md'), join(dir, '.claude', 'AGENTS.md')]) await add(file, 'project');
  const overFile = files.some((file) => file.overFileLimit);
  let status = 'ok';
  if (totalChars > totalLimit || loadedChars > totalLimit) status = 'over';
  else if (errors.length) status = 'unknown';
  else if (overFile || totalChars > totalLimit * 0.9) status = 'warn';
  return { configDir, root: cwd, files, fileCount: files.length, totalChars, loadedChars, totalLimit, perFileLimit, contextTokens, status,
    largest: [...files].sort((a, b) => b.chars - a.chars).slice(0, 3), errors, skippedImports };
}

async function transcriptRoots(config, days, now, unresolved) {
  const dir = join(config, 'projects');
  const roots = [];
  let slugs;
  try { slugs = await readdir(dir, { withFileTypes: true }); } catch { return roots; }
  const temp = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  for (const slug of slugs.filter((entry) => entry.isDirectory())) {
    let candidates;
    try { candidates = await readdir(join(dir, slug.name)); } catch { continue; }
    const recent = [];
    for (const name of candidates.filter((name) => name.endsWith('.jsonl'))) {
      const file = join(dir, slug.name, name);
      try { const info = await stat(file); if (now - info.mtimeMs <= days * 86400000) recent.push({ file, time: info.mtimeMs }); } catch { /* disappeared */ }
    }
    const file = recent.sort((a, b) => b.time - a.time)[0]?.file;
    if (!file) continue;
    let cwd;
    try {
      const handle = await open(file, 'r');
      let text;
      try {
        const buffer = Buffer.alloc(4 * 1024 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer.toString('utf8', 0, bytesRead);
      } finally { await handle.close(); }
      for (const line of text.split('\n').slice(0, 500)) {
        try { const row = JSON.parse(line); if (typeof row.cwd === 'string') { cwd = row.cwd; break; } } catch { /* malformed record */ }
      }
      if (cwd && isAbsolute(cwd)) {
        const real = await realpath(cwd);
        // Report the root as the session recorded it, like every other root; deduplication compares real paths.
        if ((!inside(real, temp) || inside(await realpath(config).catch(() => config), temp)) && (await stat(real)).isDirectory()) { roots.push(resolve(cwd)); continue; }
      }
    } catch { /* unreadable or vanished */ }
    unresolved.push(file);
  }
  return roots;
}

export async function measureStaticPrefix({ configDirs = [process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')], roots = [], home = homedir(), top, days = 7, now = Date.now(), missingConfigDirs = [], ...options } = {}) {
  const checks = [], unresolved = [];
  for (const configDir of configDirs) {
    let followed = [];
    try { followed = JSON.parse(await readFile(join(configDir, 'rules-on-demand', 'followed-projects.json'), 'utf8')); } catch { /* no followed projects */ }
    const candidates = [home, ...roots.filter(Boolean), ...(Array.isArray(followed) ? followed.map((item) => item.root) : []), ...await transcriptRoots(configDir, days, now, unresolved)];
    const seen = new Set();
    for (const root of candidates) {
      if (typeof root !== 'string') continue;
      const real = await realpath(root).catch(() => resolve(root));
      if (seen.has(real)) continue;
      seen.add(real);
      checks.push(await staticPrefix({ configDir, cwd: root, top, ...options, configMissing: missingConfigDirs.includes(configDir) }));
    }
  }
  const rank = { ok: 0, warn: 1, unknown: 2, over: 3 };
  checks.sort((a, b) => rank[b.status] - rank[a.status] || b.totalChars - a.totalChars);
  const limit = options.totalLimit ?? limitsFor(options.contextTokens).totalLimit;
  return { status: checks[0]?.status ?? 'ok', limit, warnAt: limit * 0.9, contextTokens: options.contextTokens ?? 1000000, checks, unresolved };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = { configDirs: [], roots: [] };
    let json = false;
    for (let i = 2; i < process.argv.length; i++) {
      const flag = process.argv[i];
      if (flag === '--json') { json = true; continue; }
      const value = process.argv[++i];
      if (flag === '--config-dir') options.configDirs.push(resolve(value));
      else if (flag === '--project') options.roots.push(resolve(value));
      else if (flag === '--home') options.home = resolve(value);
      else if (flag === '--top') options.top = resolve(value);
      else if (flag === '--limit') options.totalLimit = Number(value);
      else if (flag === '--per-file-limit') options.perFileLimit = Number(value);
      else if (flag === '--context-tokens') options.contextTokens = Number(value);
      else if (flag === '--days') options.days = Number(value);
      else throw new Error(`unknown option: ${flag}`);
    }
    if (!options.configDirs.length) options.configDirs = [resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))];
    const report = await measureStaticPrefix(options);
    if (json) console.log(JSON.stringify(report));
    else {
      for (const check of report.checks) {
        const loaded = check.loadedChars > check.totalChars ? ` (${check.loadedChars} chars loaded, files over the per-file limit included)` : '';
        const largest = check.largest.map((item) => `${item.path} (${item.chars})`).join(', ');
        console.log(`${check.status}: ${check.totalChars} chars in ${check.fileCount} files${loaded}, limit ${check.totalLimit} — ${check.configDir} at ${check.root}; largest: ${largest}`);
      }
      for (const file of report.unresolved) console.log(`unresolved: ${file}`);
    }
    process.exitCode = { ok: 0, warn: 2, unknown: 3, over: 4 }[report.status];
  } catch (error) { console.error(`prefix-size: ${error.message}`); process.exitCode = 3; }
}

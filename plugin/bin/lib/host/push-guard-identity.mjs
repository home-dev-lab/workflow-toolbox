// A repository identity is a suffix of path SEGMENTS, not a host spelling.
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export function normalizePushPath(value, baseDir) {
  const unmeasurable = () => { throw Error(`unmeasurable push URL: ${value}`); };
  if (typeof value !== 'string') return unmeasurable();
  const input = value.trim().replace(/\\/g, '/');
  const bracket = /^(?:[^/@:]+@)?\[/.exec(input);
  let bracketEnd;
  if (bracket) {
    bracketEnd = input.indexOf(']', bracket[0].length);
    if (bracketEnd < 0 || input[bracketEnd + 1] !== ':' || input.slice(0, bracketEnd).includes('/')) return unmeasurable();
  }
  if (!input || (bracketEnd === undefined && /^[^/]+::/.test(input)) || /[?#]/.test(input)) return unmeasurable();
  let path = input.replace(/^[a-z][\w+.-]*:\/\//i, '');
  if (path !== input && !/^file:/i.test(input)) path = path.replace(/^[^/]*\//, '');
  // Git's scp-like syntax uses the colon after a bracketed host, not a colon inside it.
  else if (bracketEnd !== undefined) path = path.slice(bracketEnd + 2);
  else if (!/^file:/i.test(input) && !/^[a-z]:\//i.test(path) && /^[^/]+:/.test(path)) path = path.slice(path.indexOf(':') + 1);
  try { path = decodeURIComponent(path); } catch { return unmeasurable(); }
  // Configured guard-path suffixes have no base; push URLs do. A relative local URL
  // is interpreted from the hook's cwd, not by stripping its leading dot segments.
  if (baseDir !== undefined && !/^[a-z][\w+.-]*:\/\//i.test(input) && !/^file:/i.test(input) &&
    !/^[^/]+:/.test(input) && !isAbsolute(path) && !/^[a-z]:\//i.test(path)) {
    const resolved = resolve(baseDir, path);
    try { if (!statSync(resolved).isDirectory()) throw Error('not a directory'); }
    catch { throw Error(`unmeasurable push URL: ${value} (relative local path not found; use an absolute path or a named remote)`); }
    path = resolved.replace(/\\/g, '/');
  }
  const segments = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return unmeasurable();
      segments.pop();
    }
    else segments.push(segment);
  }
  return segments.join('/').replace(/\.git$/i, '').toLowerCase() || unmeasurable();
}

export function matchesGuardPath(url, paths, baseDir) {
  const path = normalizePushPath(url, baseDir);
  if (!path) return true;
  return paths.some((entry) => {
    const suffix = normalizePushPath(entry);
    return suffix && (path === suffix || path.endsWith(`/${suffix}`));
  });
}

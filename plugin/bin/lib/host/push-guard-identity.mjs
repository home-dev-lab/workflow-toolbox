// A repository identity is a suffix of path SEGMENTS, not a host spelling.
import { statSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

const schemes = new Set(['ssh', 'git', 'http', 'https', 'ftp', 'ftps', 'file']);
const dnsName = (host) => host.length <= 253 && host.split('.').every((label) =>
  label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
const validHost = (host) => isIP(host) !== 0 || (dnsName(host) && !/^[0-9.]+$/.test(host));
const validPort = (port) => /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535;

function authorityShape(authority, allowBracketPort = false) {
  const hostPort = authority.replace(/^[^/@:]+@/, '');
  if (hostPort.startsWith('[')) {
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
    if (bracket && isIP(bracket[1]) === 6) return !bracket[2] || validPort(bracket[2]);
    if (!allowBracketPort) return false;
    if (bracket && !bracket[2] && validHost(bracket[1])) return true;
    const scp = /^\[([^\]:]+):(\d+)\]$/.exec(hostPort);
    return !!scp && validHost(scp[1]) && validPort(scp[2]);
  }
  const plain = /^([^:@]+)(?::(\d+))?$/.exec(hostPort);
  return !!plain && validHost(plain[1]) && (!plain[2] || validPort(plain[2]));
}

// git help urls: scheme://[user@]host[:port]/path, scp-like host:path
// (including [host(:port)]:path), or a local absolute/relative path.
export function recognizedPushShape(value) {
  if (typeof value !== 'string') return false;
  const input = value.trim().replace(/\\/g, '/');
  if (!input || /[?#]/.test(input) || (!/^(?:[^/@:]+@)?\[/.test(input) && /^[^/]+::/.test(input))) return false;
  const scheme = /^([a-z][\w+.-]*):\/\/(.*)$/i.exec(input);
  if (scheme) {
    if (!schemes.has(scheme[1].toLowerCase())) return false;
    const slash = scheme[2].indexOf('/');
    if (slash < 0 || !scheme[2].slice(slash + 1)) return false;
    const authority = scheme[2].slice(0, slash);
    return scheme[1].toLowerCase() === 'file' && !authority || authorityShape(authority);
  }
  if (/^[^/]+:/.test(input) && !/^[a-z]:\//i.test(input)) {
    const bracketed = /^(?:[^/@:]+@)?\[([^\]]+)\]:(.+)$/.exec(input);
    if (bracketed) return authorityShape(input.slice(0, input.indexOf(']:') + 1), true);
    const scp = /^(?:[^/@:]+@)?([^/@:]+):(.+)$/.exec(input);
    return !!scp && authorityShape(input.slice(0, input.indexOf(':')));
  }
  return !/^[^/]+:/.test(input) || /^[a-z]:\//i.test(input);
}

export function normalizePushPath(value, baseDir) {
  const unmeasurable = () => { throw Error(`unmeasurable push URL: ${value}`); };
  if (typeof value !== 'string') return unmeasurable();
  if (!recognizedPushShape(value)) return unmeasurable();
  const input = value.trim().replace(/\\/g, '/');
  const bracket = /^(?:[^/@:]+@)?\[/.exec(input);
  let bracketEnd;
  if (bracket) {
    bracketEnd = input.indexOf(']', bracket[0].length);
    if (bracketEnd < 0 || input[bracketEnd + 1] !== ':' || input.slice(0, bracketEnd).includes('/')) return unmeasurable();
  }
  if (!input || (bracketEnd === undefined && /^[^/]+::/.test(input)) || /[?#]/.test(input)) return unmeasurable();
  let path = input.replace(/^[a-z][\w+.-]*:\/\//i, '');
  if (path !== input && (!/^file:/i.test(input) || !path.startsWith('/'))) path = path.replace(/^[^/]*\//, '');
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
      if (!segments.length || (segments.length === 1 && /^[a-z]:$/i.test(segments[0]))) return unmeasurable();
      segments.pop();
    }
    else segments.push(segment);
  }
  return segments.join('/').replace(/\.git$/i, '').toLowerCase() || unmeasurable();
}

function rawGuardTokens(url, suffix) {
  let raw;
  try { raw = decodeURIComponent(url).toLowerCase(); } catch { return false; }
  const parts = raw.split(/[/:@[\]]+/);
  const [owner, repo] = suffix.split('/').slice(-2);
  return !!owner && !!repo && parts.some((part, index) =>
    part === owner && (parts[index + 1] === repo || parts[index + 1] === `${repo}.git`));
}

export function matchesGuardPath(url, paths, baseDir, parse = normalizePushPath) {
  const path = parse(url, baseDir);
  return paths.some((entry) => {
    const suffix = normalizePushPath(entry);
    return suffix && (path === suffix || path.endsWith(`/${suffix}`) || rawGuardTokens(url, suffix));
  });
}

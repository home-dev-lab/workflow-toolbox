import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { protectSnapshot, removeSnapshot } from './admission-snapshot-permissions.mjs'

class AdmissionSnapshotError extends Error {}

export function absoluteSnapshotSpelling(spelling) {
  // Preserve symlink/.. spelling: lexical normalization can identify a different directory.
  return path.isAbsolute(spelling) ? spelling : `${process.cwd()}${path.sep}${spelling}`
}

export function snapshotEnvironment(snapshot, env) {
  if (!snapshot) return env
  return { ...env, TMPDIR: snapshot.writable, TMP: snapshot.writable, TEMP: snapshot.writable }
}

export function watchSnapshotProcess(child, signal, terminate = (process) => process.kill('SIGTERM')) {
  if (!signal) return
  let timer
  const abort = () => {
    // Keep cleanup bounded even when the model ignores graceful termination.
    timer = setTimeout(() => child.kill('SIGKILL'), 1000)
    terminate(child)
  }
  const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  signal.addEventListener('abort', abort, { once: true })
  child.once('close', cleanup)
  child.once('error', cleanup)
  if (signal.aborted) abort()
}

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function copyEntry(source) {
  if (path.basename(source) === '.git') return false
  const stat = lstatSync(source)
  if (stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()) return true
  throw new AdmissionSnapshotError(`unsupported snapshot entry (socket, FIFO or device): ${source}`)
}

function checkLink(root, file) {
  let target
  try { target = realpathSync.native(file) } catch (error) {
    throw new AdmissionSnapshotError(`unresolved snapshot symlink: ${file}: ${error.code}`)
  }
  if (!inside(root, target)) throw new AdmissionSnapshotError(`symlink escapes snapshot: ${file}`)
}

function checkSnapshot(root, dir = root) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) checkLink(root, file)
    else if (stat.isDirectory()) checkSnapshot(root, file)
    else if (!stat.isFile()) throw new AdmissionSnapshotError(`unsupported snapshot entry: ${file}`)
  }
}

function snapshotLifetime(root) {
  const controller = new AbortController()
  const cleanup = () => removeSnapshot(root)
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGQUIT']
  const listeners = signals.map((signal) => [signal, () => controller.abort(signal)])
  process.once('exit', cleanup)
  for (const [signal, listener] of listeners) process.on(signal, listener)
  return {
    signal: controller.signal,
    dispose() {
      process.removeListener('exit', cleanup)
      for (const [signal, listener] of listeners) process.removeListener(signal, listener)
      cleanup()
    },
  }
}

function existingExtendedPath(text, offset, alias) {
  const after = text[offset + alias.length]
  if (!after || after === '/' || after === path.sep) return null
  const newline = text.indexOf('\n', offset)
  const end = newline === -1 ? text.length : newline
  // Keep the longest existing entry intact, even when it is a symlink back inside.
  for (let length = end - offset; length > alias.length; length -= 1) {
    try { return realpathSync.native(text.slice(offset, offset + length)) } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(error.code)) {
        throw new AdmissionSnapshotError(`cannot resolve request path candidate at offset ${offset}: ${error.code}`)
      }
    }
  }
  return null
}

function pathToken(text, offset, alias) {
  const before = text[offset - 1] ?? ''
  const after = text[offset + alias.length] ?? ''
  const starts = !before || /[\s'"`<([={:]/.test(before)
  if (!starts) return false
  if (existingExtendedPath(text, offset, alias)) return false
  if (after === '/' || after === path.sep) return true
  const quote = enclosingQuote(text, offset)
  return quote ? after === quote : !after || /[\s'"`)>}\]]/.test(after)
}

function enclosingQuote(text, offset) {
  let quote = null
  for (let i = 0; i < offset; i += 1) {
    const char = text[i]
    if (char === '\\') { i += 1; continue }
    if (char === quote) { quote = null; continue }
    const before = text[i - 1] ?? ''
    if (!quote && /['"`]/.test(char) && (!before || /[\s<([={:]/.test(before))) quote = char
  }
  return quote
}

function repositoryAlias(alias) {
  const root = path.parse(alias).root
  while (alias.length > root.length && [path.sep, '/'].includes(alias.at(-1))) alias = alias.slice(0, -1)
  return alias
}

function assertNoLiveRepositoryPath(text, aliases, originalRepo) {
  for (let offset = 0; offset < text.length; offset += 1) {
    // No surrounding byte can exempt a live-root occurrence. Only native proof can.
    for (const alias of aliases) {
      if (!text.startsWith(alias, offset)) continue
      const target = existingExtendedPath(text, offset, alias)
      if (target && ![originalRepo, ...aliases].some((root) => inside(root, target))) continue
      throw new AdmissionSnapshotError(`live repository path left unrewritten at offset ${offset}`)
    }
  }
}

function rewriteSnapshotText(text, aliases, repo, originalRepo) {
  // A single pass prevents a replacement being rewritten again when roots overlap.
  let result = ''; let offset = 0
  while (offset < text.length) {
    const alias = aliases.find((candidate) => text.startsWith(candidate, offset) && pathToken(text, offset, candidate))
    result += alias ? repo : text[offset]
    offset += alias ? alias.length : 1
  }
  assertNoLiveRepositoryPath(result, aliases, originalRepo)
  return result
}

function snapshotView(root, repo, originalRepo, spellings, lifetime) {
  const aliases = [...new Set([originalRepo, ...spellings])].filter((alias) => alias && path.isAbsolute(alias)).map(repositoryAlias).sort((a, b) => b.length - a.length)
  const writable = path.join(root, 'runtime')
  mkdirSync(writable, { mode: 0o700 })
  return {
    root, repo, originalRepo, writable, ...lifetime,
    freeze() {
      try { protectSnapshot(root, writable) } catch (error) {
        throw new AdmissionSnapshotError(`snapshot refused: cannot make snapshot read-only: ${error.message}`)
      }
    },
    rewrite(text) {
      return rewriteSnapshotText(text, aliases, repo, originalRepo)
    },
    writeRequest(text, name = 'request.md') {
      const request = path.join(root, name)
      writeFileSync(request, text, { flag: 'wx', mode: 0o600 })
      return request
    },
  }
}

export function createAdmissionSnapshot(source, spellings = []) {
  let lifetime
  try {
    const originalRepo = realpathSync.native(source)
    const parent = realpathSync.native(path.resolve(tmpdir()))
    if (inside(originalRepo, parent)) throw new AdmissionSnapshotError('snapshot parent lies inside source repository')
    const root = mkdtempSync(path.join(parent, 'wt-admission-'))
    lifetime = snapshotLifetime(root)
    chmodSync(root, 0o700)
    const repo = path.join(root, 'repo')
    mkdirSync(repo)
    cpSync(originalRepo, repo, { recursive: true, dereference: false, verbatimSymlinks: true, filter: copyEntry })
    const canonicalRepo = realpathSync.native(repo)
    checkSnapshot(canonicalRepo)
    return snapshotView(root, canonicalRepo, originalRepo, spellings, lifetime)
  } catch (error) {
    lifetime?.dispose()
    throw new AdmissionSnapshotError(`snapshot refused: ${error.message}`)
  }
}

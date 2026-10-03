import path from 'node:path'
import { createHash } from 'node:crypto'
import * as io from './host/work-journal-io.mjs'

export const STORE_LEAF = 'wt-daily-journal'
export const ARCHIVE_LEAF = 'wt-daily-journal-archive'
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function identity(target, width) {
  const resolved = io.canonical(target)
  const slug = path.basename(resolved).replace(/[^a-z0-9-]/gi, '-').slice(0, 48) || 'root'
  return { resolved, key: `${slug}-${sha256(resolved).slice(0, width)}` }
}

export function refuseRepository(target, project) {
  const resolved = io.canonical(target)
  const relative = path.relative(project, resolved)
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) || io.insideRepository(resolved)) {
    throw new Error('journal disabled: store resolves inside a repository')
  }
  return resolved
}

export function resolveJournal(payload = {}, env = process.env) {
  const userHome = io.platform() === 'win32' ? env.USERPROFILE || env.HOME || io.home() : env.HOME || io.home()
  const project = identity(env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd(), 12)
  const config = identity(env.CLAUDE_CONFIG_DIR || path.join(userHome, '.claude'), 8)
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(userHome, '.local', 'state')
  const primary = env.WT_WORK_JOURNAL_DIR || path.join(state, STORE_LEAF)
  const mirror = env.WT_WORK_JOURNAL_ARCHIVE_DIR || path.join(state, ARCHIVE_LEAF)
  if (!path.isAbsolute(primary) || !path.isAbsolute(mirror)) throw new Error('journal overrides must be absolute')
  const store = refuseRepository(path.join(primary, config.key, project.key), project.resolved)
  const archive = refuseRepository(path.join(mirror, config.key, project.key), project.resolved)
  if (store === archive) throw new Error('journal primary and archive must be distinct')
  const now = new Date(env.WT_WORK_JOURNAL_NOW || Date.now())
  if (Number.isNaN(now.getTime())) throw new Error('invalid journal time')
  return { store, archive, root: project.resolved, config: config.resolved, get now() { return new Date(env.WT_WORK_JOURNAL_NOW || Date.now()) }, env }
}

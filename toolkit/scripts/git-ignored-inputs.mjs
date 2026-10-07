import { execFileSync } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'

const slash = (path) => path.split(sep).join('/')
const escapeGlob = (path) => path.replace(/[\\*?\[\]{}()!+@]/g, '\\$&')
const escapeRegex = (path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function listGitIgnoredPaths(dir, { run = execFileSync } = {}) {
  try {
    const output = run('git', ['-C', dir, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
    })
    const paths = String(output).split('\0').filter(Boolean)
      .map(slash).filter((path) => !path.split('/').includes('node_modules'))
    return { status: 'listed', paths }
  } catch (error) {
    const diagnostic = String(error?.stderr ?? '').trim()
    const reason = String(diagnostic || error?.message || error).trim().replace(/[\r\n]+/g, ' ')
    if (/not a git repository/i.test(reason)) return { status: 'not-a-repo', paths: [] }
    process.stderr.write(`Cannot list git-ignored inputs in ${dir}: ${reason}; ignored files will be read.\n`)
    return { status: 'git-failed', paths: [] }
  }
}

function relativeInput(path, root, baseDir) {
  const rel = slash(relative(baseDir, resolve(root, path)))
  return path.endsWith('/') ? `${rel}/` : rel
}

export function eslintIgnorePatterns(paths, root, baseDirs) {
  return [...new Set(baseDirs.flatMap((base) => paths.map((path) => escapeGlob(relativeInput(path, root, base)))))]
}

export function pathsRegexSource(paths, root, baseDir) {
  if (paths.length === 0) return null
  const alternatives = paths.map((path) => {
    const rel = relativeInput(path, root, baseDir)
    return path.endsWith('/') ? escapeRegex(rel) : `${escapeRegex(rel)}$`
  })
  return `^(?:${alternatives.join('|')})`
}

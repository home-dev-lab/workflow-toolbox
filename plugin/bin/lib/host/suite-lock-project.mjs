import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function defaultSuiteLockProject(cwd = process.cwd(), home = homedir()) {
  let selected
  const resolved = path.resolve(cwd)
  for (let current = resolved; current !== path.dirname(current); current = path.dirname(current)) {
    const relative = path.relative(home, current)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && existsSync(path.join(current, '.claude'))) selected = current
  }
  if (selected) return path.basename(selected)
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return path.basename(path.dirname(path.resolve(cwd, common)))
  } catch { return path.basename(resolved) }
}

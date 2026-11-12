import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

function derivedProject(cwd, home) {
  let selected
  const resolved = path.resolve(cwd)
  for (let current = resolved; current !== path.dirname(current); current = path.dirname(current)) {
    const relative = path.relative(home, current)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && existsSync(path.join(current, '.claude'))) selected = current
  }
  if (selected) return path.basename(selected)
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return path.basename(path.dirname(path.resolve(cwd, common)))
  } catch { return path.basename(resolved) }
}

export function defaultSuiteLockProject(cwd, home) {
  try {
    const name = derivedProject(cwd ?? process.cwd(), home ?? homedir()).replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 120).trim()
    return name || 'unnamed'
  } catch { return 'unnamed' }
}

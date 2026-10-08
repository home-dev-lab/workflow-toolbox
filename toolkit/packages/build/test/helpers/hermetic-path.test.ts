import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hermeticPath } from './hermetic-path.js'

const TEST_DIR = join(__dirname, '..')

describe('hermeticPath', () => {
  it('never carries an inherited PATH entry on POSIX', () => {
    const value = hermeticPath(['/fixture/bin'], 'linux', '/mnt/c/Users/x/scoop/shims:/home/x/.local/bin', '/opt/node/bin/node')
    expect(value.split(':')).toEqual(['/fixture/bin', '/opt/node/bin', '/usr/local/bin', '/usr/bin', '/bin'])
  })

  it('keeps the inherited PATH on Windows, after the fixture directories', () => {
    expect(hermeticPath(['C:\\fixture\\bin'], 'win32', 'C:\\Windows\\System32', 'C:\\node\\node.exe')).toBe('C:\\fixture\\bin;C:\\Windows\\System32')
  })

  it.each(['opencode-skill-fence-paths.test.ts', 'opencode-verifier-entry.test.ts'])('%s does not hand the host PATH to its lane spawns', (file) => {
    const source = readFileSync(join(TEST_DIR, file), 'utf8')
    expect(source).not.toMatch(/\$\{process\.env\.PATH\}/)
    expect(source).toMatch(/hermeticPath\(/)
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hermeticPath } from './hermetic-path.js'

const TEST_DIR = join(__dirname, '..')
const KEPT_HOST_PATH_LINES: Record<string, readonly string[]> = {
  'sdk-pilot-lifecycle-server.test.ts': [
    'const oldPath = process.env.PATH; const oldConfig = process.env.CLAUDE_CONFIG_DIR; const oldState = process.env.XDG_STATE_HOME; const oldNodeOptions = process.env.NODE_OPTIONS; const oldMinimum = process.env.WT_LANE_MIN_AVAILABLE_MIB',
    'process.env.PATH = oldPath',
  ],
}

describe('hermeticPath', () => {
  it('never carries an inherited PATH entry on POSIX', () => {
    const value = hermeticPath(['/fixture/bin'], 'linux', '/mnt/c/Users/x/scoop/shims:/home/x/.local/bin', '/opt/node/bin/node')
    expect(value.split(':')).toEqual(['/fixture/bin', '/opt/node/bin', '/usr/local/bin', '/usr/bin', '/bin'])
  })

  it('keeps the inherited PATH on Windows, after the fixture directories', () => {
    expect(hermeticPath(['C:\\fixture\\bin'], 'win32', 'C:\\Windows\\System32', 'C:\\node\\node.exe')).toBe('C:\\fixture\\bin;C:\\Windows\\System32')
  })

  it.each([
    'opencode-skill-fence-paths.test.ts',
    'opencode-verifier-entry.test.ts',
    'lane-sandbox.test.ts',
    'wt-lane-launcher.test.ts',
    'suite-lock.test.ts',
    'sdk-pilot-lifecycle-server.test.ts',
  ])('%s does not hand the host PATH to its lane spawns', (file) => {
    const source = readFileSync(join(TEST_DIR, file), 'utf8')
    const lines = source.split('\n').map((line) => line.trim())
    // Only saving/restoring the parent's PATH is allowed; the fixture must pin its active PATH.
    const hostPathLines = lines.filter((line) => /process\.env\.PATH/.test(line.replace(/process\.env\.PATH(?=\s*=\s*hermeticPath\()/g, '')))
    expect(hostPathLines, 'inherited PATH reads/writes must be explicitly kept').toEqual(KEPT_HOST_PATH_LINES[file] ?? [])
    // Environment spreads must override PATH, including inside generated launcher programs.
    expect(lines.filter((line) => /\.\.\.process\.env/.test(line) && !/PATH:\s*(?:hermeticPath\(|bin\+delimiter\+\$\{JSON\.stringify\(hermeticPath\(\[\]\)\)\})/.test(line)), 'environment spreads must pin PATH').toEqual([])
    expect(source).toMatch(/hermeticPath\(/)
  })
})

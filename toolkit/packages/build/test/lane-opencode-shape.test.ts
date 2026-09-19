import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { reportableOpencodeArgv } from '../../../../plugin/bin/lib/lane-live-scan.mjs'

describe('reportableOpencodeArgv', () => {
  it.each([
    [['/tmp/x/opencode', '30'], false, '/tmp'],
    [['/bin/sh', join(tmpdir(), 'bin', 'opencode'), 'run', 'x'], false, tmpdir()],
    [['opencode', '30'], false, '/tmp'],
    [['/usr/local/bin/opencode', 'run', '--dir', '/w'], true, '/tmp'],
    [['node', '-e', '…', 'opencode', 'run'], true, '/tmp'],
    [['node', '/usr/lib/node_modules/opencode-ai/bin/opencode', 'run'], true, '/tmp'],
  ])('classifies %j as %s', (argv, expected, tmpRoot) => {
    expect(reportableOpencodeArgv(argv, { tmpRoot })).toBe(expected)
  })

  it('rejects a lane shape launched by an executable under the temp root', () => {
    expect(reportableOpencodeArgv(['/tmp/bin/node', '-e', '…', 'opencode', 'run'], { tmpRoot: '/tmp' })).toBe(false)
  })

  it('canonicalises executable paths before checking temp containment', () => {
    const realpath = (value: string) => value.replace('/tmp-alias', '/private/tmp')
    expect(reportableOpencodeArgv(['/bin/sh', '/tmp-alias/bin/opencode.cmd', 'run'], { tmpRoot: '/private/tmp', realpath })).toBe(false)
  })
})

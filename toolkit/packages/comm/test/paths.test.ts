import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { messagePath, ackPath, consumedPath, MSG_PREFIX, ACK_PREFIX, CONSUMED_PREFIX } from '../src/paths.js'

describe('path builders', () => {
  const dir = '/tmp/some-arc-dir'

  it('messagePath builds msg-<id>.json under dir', () => {
    expect(messagePath(dir, 'q-abc')).toBe(join(dir, 'msg-q-abc.json'))
  })

  it('ackPath builds ack-<id>.json under dir', () => {
    expect(ackPath(dir, 'q-abc')).toBe(join(dir, 'ack-q-abc.json'))
  })

  it('consumedPath builds consumed-<id>.json under dir', () => {
    expect(consumedPath(dir, 'q-abc')).toBe(join(dir, 'consumed-q-abc.json'))
  })

  it('rejects an unsafe id (path traversal) via the shared fs guard', () => {
    expect(() => messagePath(dir, '../etc/passwd')).toThrow()
    expect(() => ackPath(dir, 'a/b')).toThrow()
    expect(() => consumedPath(dir, 'a\\b')).toThrow()
  })

  it('exposes the family prefixes used by listers', () => {
    expect(MSG_PREFIX).toBe('msg-')
    expect(ACK_PREFIX).toBe('ack-')
    expect(CONSUMED_PREFIX).toBe('consumed-')
  })
})

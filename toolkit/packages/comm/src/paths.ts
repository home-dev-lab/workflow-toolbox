// paths.ts — filename-family path builders for the wt-comm tree. One flat directory per
// arc; three filename families share it (msg-/ack-/consumed-), distinguished only by
// prefix (see ../README.md "The tree"). Every builder runs the id through the shared
// path-safety guard ONCE, here, so fs.ts's call sites never need to repeat it.

import { join } from 'node:path'
import { assertSafeMessageId } from './ids.js'

export const MSG_PREFIX = 'msg-'
export const ACK_PREFIX = 'ack-'
export const CONSUMED_PREFIX = 'consumed-'

export function messagePath(dir: string, id: string): string {
  assertSafeMessageId(id)
  return join(dir, `${MSG_PREFIX}${id}.json`)
}

export function ackPath(dir: string, id: string): string {
  assertSafeMessageId(id)
  return join(dir, `${ACK_PREFIX}${id}.json`)
}

export function consumedPath(dir: string, id: string): string {
  assertSafeMessageId(id)
  return join(dir, `${CONSUMED_PREFIX}${id}.json`)
}

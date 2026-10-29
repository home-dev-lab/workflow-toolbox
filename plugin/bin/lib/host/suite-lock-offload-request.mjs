const KEYS = new Set(['version', 'requestId', 'cwd', 'laneToken'])
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value)
const validCwd = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096

function requestShape(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => KEYS.has(key))
}

export function parseOffloadRequest(value) {
  if (value === undefined) return undefined
  if (!requestShape(value) || value.version !== 1 || !validId(value.requestId) || !validCwd(value.cwd)) throw new Error('invalid offload request: only version, requestId, cwd and laneToken accepted')
  return { version: 1, requestId: value.requestId, cwd: value.cwd, laneToken: value.laneToken }
}

export function createOffloadRequest(cwd, env = process.env) {
  return { version: 1, requestId: createSuiteLockLeaseId(), cwd: cwd ?? process.cwd(), laneToken: env.WT_SUITE_LOCK_LANE_TOKEN }
}
import { createSuiteLockLeaseId } from './suite-lock-host.mjs'

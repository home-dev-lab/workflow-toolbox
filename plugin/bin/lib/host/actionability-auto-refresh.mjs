import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteJson, readJsonOrNull } from './actionability-files.mjs'
import { autoRefreshPath } from '../actionability-state-paths.mjs'
import { DEFAULT_REFRESH_TIMEOUT_MS } from '../actionability-refresh-deadline.mjs'
import { positiveMilliseconds } from '../proposal-age.mjs'

const REFRESH_BIN = fileURLToPath(new URL('../../wt-actionable-snapshot-refresh.mjs', import.meta.url))

function launchRefresh(cwd, failed) {
  const script = process.env.WT_ACTIONABLE_REFRESH_BIN || REFRESH_BIN
  if (!existsSync(script)) throw new Error(`refresh script missing: ${script}`)
  const child = spawn(process.execPath, [script], { cwd, detached: true, stdio: 'ignore', windowsHide: true })
  child.once('error', failed)
  child.unref()
}

// A throttle, not a mutex: two sessions may launch once each; atomic whole-file writers tolerate it.
export function autoRefresh({ root, cwd, snapshot, now, failed }) {
  const pointer = readJsonOrNull(join(cwd, '.claude/planka.json'))
  if (pointer?.actionableAutoRefresh !== true) return 'off'
  const windowMs = positiveMilliseconds(process.env.WT_ACTIONABLE_AUTO_REFRESH_AFTER_MS, 10 * 60_000)
  if (snapshot.status === 'present' && now - snapshot.at <= windowMs) return 'fresh'
  const path = autoRefreshPath(root, cwd)
  const previous = readJsonOrNull(path)
  if (Number.isFinite(previous?.launchedAt) && now < Math.max(previous.launchedAt + windowMs, previous.deadlineAt || 0)) return 'throttled'
  const timeoutMs = positiveMilliseconds(process.env.WT_ACTIONABLE_REFRESH_TIMEOUT_MS, DEFAULT_REFRESH_TIMEOUT_MS)
  try {
    atomicWriteJson(path, { launchedAt: now, deadlineAt: now + timeoutMs })
    launchRefresh(cwd, failed)
    return 'launched'
  } catch (error) {
    failed(error)
    return 'failed'
  }
}

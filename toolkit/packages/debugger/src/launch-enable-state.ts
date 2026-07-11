// launch-enable-state.ts — per-source, CROSS-RESTART persistence of the live-launch opt-in
// (card #1812476922312000519, increment B). Before this, `launchEnabled` reset to `false` on
// every server restart (dev-api.ts's own comment: "per-app memory, resets on restart") — a
// deliberate posture when a restart was assumed benign, but it defeats A3's boot orphan
// sweep: a crash/restart is EXACTLY when an in-flight run most needs `launchesEnabled: true`
// to actually resume, and the old behavior forced a manual re-opt-in first every time.
//
// Semantics (fixed): the boot-time `--enable-launch` env flag OR a runtime
// `POST /api/launch-enable` both WRITE a record here (app.ts's createApp / route handler);
// on boot, a source's effective `launchEnabled` = env flag OR record exists. `wt-observe
// stop` clears EVERY record (a deliberate stop is a deliberate revoke) — it never touches
// launch-records.ts's dir: a run killed by stop is exactly what the next enabled start
// should resume, so the IN-FLIGHT RECORD must survive a stop even though the GRANT does not.
//
// One JSON file per source, keyed by configDirKey directly under `<stateRoot>/launch-enable/`
// (not a per-key subdirectory the way spikeStateDir/launchStateDir are — there is exactly one
// small file per source here, never a directory of many, so a bare `<key>.json` is simpler
// and needs no state-paths.ts entry of its own).

// Namespace import, not named — the CLI bundle tree-shakes the server-only
// functions here (write/exists) and esbuild would otherwise leave their hoisted
// NAMED imports dangling in the generated bin (lint: no-unused-vars).
import * as fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { configDirKey } from './config-dir.js'
import { isRecord, strOrNull } from '@workflow-toolbox/std'

export interface LaunchEnableRecord {
  enabledAt: string
}

export function serializeLaunchEnableRecord(rec: LaunchEnableRecord): string {
  return JSON.stringify(rec)
}

/** Tolerant: garbage / wrong shape / missing field → null, never throws. */
export function parseLaunchEnableRecord(text: string): LaunchEnableRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const enabledAt = strOrNull(parsed['enabledAt'])
  return enabledAt === null ? null : { enabledAt }
}

export function launchEnableStateDir(stateRoot: string): string {
  return join(stateRoot, 'launch-enable')
}

function launchEnableRecordPath(stateRoot: string, configDir: string): string {
  return join(launchEnableStateDir(stateRoot), `${configDirKey(configDir)}.json`)
}

/** Write-then-rename (atomic same-dir rename), 0700 dir / 0600 file — same posture as every
 *  other small state record in this codebase (the wt-observe pidfile, launch-records.ts). */
export function writeLaunchEnableRecord(stateRoot: string, configDir: string, enabledAt: string): void {
  const dir = launchEnableStateDir(stateRoot)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const finalPath = launchEnableRecordPath(stateRoot, configDir)
  const tmpPath = join(dir, `.${configDirKey(configDir)}.${randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(tmpPath, serializeLaunchEnableRecord({ enabledAt }), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmpPath, finalPath)
}

export function launchEnableRecordExists(stateRoot: string, configDir: string): boolean {
  return fs.existsSync(launchEnableRecordPath(stateRoot, configDir))
}

/** `wt-observe stop` revokes EVERY source's grant in one go (a deliberate stop is a
 *  deliberate revoke — see this file's own header doc) — never touches launch-records.ts's
 *  dir. Tolerant of a missing dir (nothing was ever enabled) and of a per-file unlink failure
 *  (best-effort clear; one stuck file must not abort clearing the rest). */
export function clearAllLaunchEnableRecords(stateRoot: string): void {
  const dir = launchEnableStateDir(stateRoot)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      fs.unlinkSync(join(dir, name))
    } catch {
      // best-effort — one unremovable file must not block clearing the rest
    }
  }
}

/** Deletes only THIS source's own record. Not called anywhere today (stop clears every
 *  source's grant at once — see clearAllLaunchEnableRecords) but kept for symmetry with
 *  launch-records.ts's deleteLaunchRecord and for a future per-source revoke surface. */
export function deleteLaunchEnableRecord(stateRoot: string, configDir: string): void {
  try {
    fs.rmSync(launchEnableRecordPath(stateRoot, configDir))
  } catch (e) {
    if ((e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return
    throw e
  }
}

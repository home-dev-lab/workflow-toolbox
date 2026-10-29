import fs from 'node:fs'
import path from 'node:path'
import { signerConfigTarget } from './ssh-sign-config-paths.mjs'
export { runSignerGit } from './ssh-sign-config-paths.mjs'

function acquireLock(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.closeSync(fs.openSync(`${target}.lock`, 'wx'))
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    process.stdout.write('adopt: gpg.ssh.program left alone: Git configuration is locked by another writer; rerun the same adopt command\n')
    return false
  }
}

function snapshot(target) {
  try { return { bytes: fs.readFileSync(target), mode: fs.statSync(target).mode & 0o7777 } }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { bytes: null, mode: 0o666 & ~process.umask() }
  }
}

function retainOriginal(target, stage, previous) {
  if (previous.bytes === null) return
  try {
    // Pin the original inode, including its owner, special bits and native ACLs.
    fs.linkSync(target, `${stage}.original`)
  } catch (error) {
    throw new Error(`gpg.ssh.program REFUSED: cannot preserve original config identity, owner and ACLs: ${error.message}; no config publication occurred`, { cause: error })
  }
}

function restore(target, stage, previous) {
  try {
    if (previous.bytes === null) fs.rmSync(target)
    else fs.renameSync(`${stage}.original`, target)
  } catch (error) {
    throw Object.assign(new Error(`rollback incomplete: cannot restore original config bytes, mode, owner and ACLs: ${error.message}; original backup (if the config existed): ${stage}.original; inspect it before rerunning the same adopt command`, { cause: error }), { keepConfigBackup: true })
  }
}

function publish(target, stage, previous, verify) {
  fs.renameSync(stage, target)
  try {
    if (verify()) return true
  } catch (error) {
    restore(target, stage, previous)
    throw error
  }
  restore(target, stage, previous)
  return false
}

// Hold only the write target's Git lock, including through postcondition/rollback.
export function withSignerConfigLock(scope, write, verify) {
  const target = signerConfigTarget(scope)
  if (!acquireLock(target)) return false
  let directory
  try {
    if (signerConfigTarget(scope) !== target) {
      process.stdout.write('adopt: gpg.ssh.program left alone: Git configuration write target changed; rerun the same adopt command\n')
      return false
    }
    const previous = snapshot(target)
    directory = fs.mkdtempSync(`${target}.adopt-`)
    const stage = path.join(directory, 'config')
    retainOriginal(target, stage, previous)
    fs.writeFileSync(stage, previous.bytes ?? '', { mode: previous.mode })
    fs.chmodSync(stage, previous.mode)
    if (!write(stage)) return false
    return publish(target, stage, previous, verify)
  } catch (error) {
    if (error.keepConfigBackup) directory = undefined
    throw error
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
    fs.rmSync(`${target}.lock`, { force: true })
  }
}

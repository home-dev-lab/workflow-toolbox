// How this host spells one directory in Bash (Git Bash on Windows) and in Node, and which spellings Node can read.
// The concurrent-test guard reads directories out of Bash commands (`cd /c/x`, `pnpm -C /y`) and then reads config
// files there with Node; the lane waiter prints host paths built with `path.join`. This probe records the facts
// both depend on: the shell's spelling of a host directory, Node's resolution of each spelling, and whether a read
// through each spelling reaches the file.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { platform, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { outputPath, provenance, writeEvidence } from './probe-lib.mjs'

const destination = outputPath('git-bash-path-spelling')
const scratch = `${destination}.native`
const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-host-bash-path-')))
const marker = 'git-bash-path-spelling-marker'
writeFileSync(join(root, 'vitest.config.ts'), marker)

const bash = (label, script) => {
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  return {
    label,
    script,
    exitCode: result.status,
    spawnError: result.error === undefined ? null : { code: result.error.code ?? null, message: String(result.error.message) },
    stdout: result.stdout ?? null,
    stderr: result.stderr ?? null,
  }
}

const read = (label, file) => {
  if (file === null) return { label, file, status: 'not-measured' }
  try {
    return { label, file, status: readFileSync(file, 'utf8') === marker ? 'read-marker' : 'read-other' }
  } catch (error) {
    return { label, file, status: 'read-failed', code: error.code ?? null }
  }
}

const forward = root.replaceAll('\\', '/')
const pwd = bash('cd <host directory, forward slashes> && pwd', `cd '${forward}' && pwd`)
const shellSpelling = pwd.exitCode === 0 ? pwd.stdout.trim() : null
const drive = /^([A-Za-z]):\//.exec(forward)
const driveSpelling = drive ? `/${drive[1].toLowerCase()}${forward.slice(2)}` : forward

const measurements = {
  hostDirectory: root,
  shell: {
    pwd,
    pwdWindows: platform() === 'win32' ? bash('cd <host directory> && pwd -W', `cd '${forward}' && pwd -W`) : null,
    driveSpellingCd: bash('cd <drive-letter Git Bash spelling> && pwd', `cd '${driveSpelling}' && pwd`),
    driveless: platform() === 'win32' ? bash('cd /tmp && pwd && pwd -W', 'cd /tmp && pwd && pwd -W') : null,
  },
  nodeReads: [
    read('native host spelling', join(root, 'vitest.config.ts')),
    read('forward-slash host spelling', `${forward}/vitest.config.ts`),
    read('shell pwd spelling, raw', shellSpelling === null ? null : `${shellSpelling}/vitest.config.ts`),
    read('shell pwd spelling, path.normalize', shellSpelling === null ? null : path.normalize(`${shellSpelling}/vitest.config.ts`)),
    read('drive-letter Git Bash spelling, raw', `${driveSpelling}/vitest.config.ts`),
  ],
  nodePathStrings: {
    sep: path.sep,
    joinPosixLiteral: path.join('/host', 'run.log'),
    normalizePosixLiteral: path.normalize('/x/toolkit'),
    resolvePosixLiteral: path.resolve('/repo', 'toolkit'),
    isAbsoluteGitBashDrive: path.isAbsolute('/c/Users/x'),
    normalizeGitBashDrive: path.normalize('/c/Users/x'),
  },
}
rmSync(root, { recursive: true, force: true })
const command = `node ${basename(import.meta.filename)} ${destination}`
writeEvidence(destination, { provenance: provenance('git-bash-path-spelling', command, `${scratch}.provenance`), measurements })

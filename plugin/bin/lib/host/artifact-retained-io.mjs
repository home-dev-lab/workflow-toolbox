import * as fs from 'node:fs'
import path from 'node:path'

// The catalog owns policy and the durable write sequence; this boundary supplies native I/O.
export const artifactRetainedIO = fs
export const artifactRetainedPlatform = process.platform

export function ensureRetainedDirectories(stateDir, { platform = artifactRetainedPlatform } = {}) {
  for (const directory of ['retained', 'forgotten']) {
    const destination = path.join(stateDir, directory)
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
    const info = fs.lstatSync(destination)
    if (!info.isDirectory()) throw new Error(`artifact server ${directory} path is not a directory`)
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new Error(`artifact server ${directory} directory is owned by another uid`)
    }
    if (platform !== 'win32' && (info.mode & 0o022) !== 0) throw new Error(`artifact server ${directory} directory is group- or world-writable`)
    if (platform !== 'win32') fs.chmodSync(destination, 0o700)
  }
}

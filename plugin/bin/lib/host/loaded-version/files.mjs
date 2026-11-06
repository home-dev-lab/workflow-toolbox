// Filesystem metadata lookups the loaded-version check needs outside /proc: is a path a directory
// (a profile holds `plugins/cache`), and the real path of a module. Neither opens a file.
// A missing path is an answer (false / null); any other failure is thrown, never read as missing.
import { realpathSync, statSync } from 'node:fs'

const MISSING = new Set(['ENOENT', 'ENOTDIR'])

export const hostLoadedVersionFiles = Object.freeze({
  isDirectory(file) {
    try { return statSync(file).isDirectory() } catch (error) {
      if (MISSING.has(error?.code)) return false
      throw error
    }
  },
  realpath(file) {
    try { return realpathSync(file) } catch (error) {
      if (MISSING.has(error?.code)) return null
      throw error
    }
  },
})

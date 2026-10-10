import fs from 'node:fs'

// Default host access for the legacy state carry-over in plugin-data-dir.mjs; an injected
// filesystem (tests) replaces this object with the same narrow surface.
export const legacyCarryFilesystem = {
  existsSync: (path) => fs.existsSync(path),
  readdirSync: (path) => fs.readdirSync(path),
  mkdirSync: (path, options) => fs.mkdirSync(path, options),
  renameSync: (from, to) => fs.renameSync(from, to),
  cpSync: (from, to, options) => fs.cpSync(from, to, options),
  rmSync: (path, options) => fs.rmSync(path, options),
  rmdirSync: (path) => fs.rmdirSync(path),
}

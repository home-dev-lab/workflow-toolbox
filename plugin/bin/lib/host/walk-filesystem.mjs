import fs from 'node:fs'

// Keep the walk's default host access here; injected filesystems use the same narrow surface.
export const walkFilesystem = {
  lstatSync: (file) => fs.lstatSync(file),
  statSync: (file) => fs.statSync(file),
  realpathSync: (file) => fs.realpathSync(file),
  opendirSync: (file) => fs.opendirSync(file),
}

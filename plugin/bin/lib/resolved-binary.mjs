// Resolve an executable exactly as the target shell platform does. A missing result is a
// genuine absence; lookup errors throw so callers can report the mechanism as unavailable.
export function resolvedBinary(bin, env, { accessSyncFn, constants, platform, realpathSyncFn, statSyncFn, pathApi }) {
  if (bin.includes('/') || bin.includes('\\')) {
    try { return realpathSyncFn(bin) } catch { return pathApi.resolve(bin) }
  }
  const pathKey = platform === 'win32' ? Object.keys(env).find((key) => key.toUpperCase() === 'PATH') : 'PATH'
  const pathExtKey = platform === 'win32' ? Object.keys(env).find((key) => key.toUpperCase() === 'PATHEXT') : undefined
  const searchPath = pathKey === undefined ? undefined : env[pathKey]
  if (!searchPath) return null
  const extensions = platform === 'win32' && pathApi.extname(bin) === ''
    ? String((pathExtKey === undefined ? undefined : env[pathExtKey]) || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const delimiter = platform === 'win32' ? ';' : ':'
  for (const directory of searchPath.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = pathApi.resolve(directory || '.', `${bin}${extension}`)
      try {
        if (!statSyncFn(candidate).isFile()) continue
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
        throw new Error(`could not search PATH for ${bin}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (platform !== 'win32') {
        try { accessSyncFn(candidate, constants.X_OK) } catch (error) {
          if (error?.code === 'EACCES' || error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
          throw new Error(`could not inspect PATH result for ${bin}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try { return realpathSyncFn(candidate) } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
        throw new Error(`could not resolve PATH result for ${bin}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return null
}

export function executableName(value, platform, pathExt = '') {
  const basename = String(value || '').split(/[\\/]/).at(-1) || ''
  if (platform !== 'win32') return basename
  const extensions = String(pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const extension = extensions.find((item) => basename.toLowerCase().endsWith(item.toLowerCase()))
  return extension ? basename.slice(0, -extension.length) : basename
}

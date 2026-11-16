// OpenCode stores native Windows realpaths with forward slashes, preserving case.
export function openCodeStoredDirectory(nativePath, platform = process.platform) {
  return platform === 'win32' ? nativePath.replaceAll('\\', '/') : nativePath
}

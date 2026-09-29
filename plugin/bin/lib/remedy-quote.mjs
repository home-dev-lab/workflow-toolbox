// Quote one argument in a command printed for a human to paste on the target platform.
// quoteSafeOnPosix preserves the older POSIX always-quoted remedies.
export const hostPlatform = process.platform
export function quoteRemedyWord(value, platform = hostPlatform, quoteSafeOnPosix = false) {
  const word = String(value)
  const slash = String.fromCharCode(47)
  const backslash = String.fromCharCode(92)
  if (platform === 'win32') {
    if (word.length && /^[\w@%+=:,.-]*$/.test(word.replaceAll(slash, '').replaceAll(backslash, ''))) return word
    return `"${word.replaceAll('"', () => backslash + '"')}"`
  }
  if (!quoteSafeOnPosix && word.length && /^[\w@%+=,.-]*$/.test(word.replaceAll(slash, ''))) return word
  return `'${word.replaceAll("'", `'"'"'`)}'`
}

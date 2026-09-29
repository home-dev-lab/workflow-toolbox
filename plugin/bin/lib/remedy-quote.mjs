// Quote one argument in a command printed for a human to paste on the target platform.
// quoteSafeOnPosix preserves the older POSIX always-quoted remedies.
export const hostPlatform = process.platform
export function quoteRemedyWord(value, platform = hostPlatform, quoteSafeOnPosix = false) {
  const word = String(value)
  const slash = String.fromCharCode(47)
  const backslash = String.fromCharCode(92)
  if (platform === 'win32') {
    if (word.length && /^[\w@%+=:,.-]*$/.test(word.replaceAll(slash, '').replaceAll(backslash, ''))) return word
    // Double runs before embedded quotes and the closing quote; otherwise leave them literal.
    let escaped = ''
    let run = 0
    for (const char of word) {
      if (char === backslash) {
        run++
        continue
      }
      escaped += backslash.repeat(char === '"' ? run * 2 + 1 : run) + char
      run = 0
    }
    escaped += backslash.repeat(run * 2)
    return `"${escaped}"`
  }
  if (!quoteSafeOnPosix && word.length && /^[\w@%+=,.-]*$/.test(word.replaceAll(slash, ''))) return word
  return `'${word.replaceAll("'", `'"'"'`)}'`
}

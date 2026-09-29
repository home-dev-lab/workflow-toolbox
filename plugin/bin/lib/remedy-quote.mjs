// Quote one argument in a command printed for a human to paste on the target platform.
// quoteSafeOnPosix preserves the older POSIX always-quoted remedies.
export const hostPlatform = process.platform
export function quoteRemedyWord(value, platform = hostPlatform, quoteSafeOnPosix = false) {
  const word = String(value)
  const slash = String.fromCharCode(47)
  const backslash = String.fromCharCode(92)
  if (platform === 'win32') {
    if (word.length && /^[\w@%+=:,.-]*$/.test(word.replaceAll(slash, '').replaceAll(backslash, ''))) return word
    // A backslash run is literal unless it precedes a double quote, where it must be doubled:
    // before an embedded quote (then escaped) and before the closing quote.
    const escaped = word
      .replace(/(\\*)"/g, (_match, run) => run + run + backslash + '"')
      .replace(/(\\+)$/, (_match, run) => run + run)
    return `"${escaped}"`
  }
  if (!quoteSafeOnPosix && word.length && /^[\w@%+=,.-]*$/.test(word.replaceAll(slash, ''))) return word
  return `'${word.replaceAll("'", `'"'"'`)}'`
}

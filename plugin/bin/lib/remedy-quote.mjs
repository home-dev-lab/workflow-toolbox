// Quote one argument in a command printed for a human to paste into a POSIX-style shell.
// quoteSafeOnPosix preserves the older always-quoted remedies.
export function quoteRemedyWord(value, quoteSafeOnPosix = false) {
  const word = String(value)
  if (!quoteSafeOnPosix && word.length && /^[\w@%+=,./-]+$/.test(word)) return word
  return `'${word.replaceAll("'", `'"'"'`)}'`
}

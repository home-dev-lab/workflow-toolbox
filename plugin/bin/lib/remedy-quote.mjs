// Quote one argument in a command printed for a human to paste into a POSIX-style shell.
// quoteSafeOnPosix preserves the older always-quoted remedies.
export function quoteRemedyWord(value, quoteSafeOnPosix = false) {
  const word = String(value)
  if (!quoteSafeOnPosix && word.length && /^[\w@%+=,./-]+$/.test(word)) return word
  return `'${word.replaceAll("'", `'"'"'`)}'`
}

// JSON text for a printed command. A command that crosses a Windows command line into Git Bash can
// arrive with a doubled backslash collapsed to one, and a JSON-escaped backslash is exactly such a
// pair. Each one is written as the escape \u005c instead, which parses to the same text. The pattern
// consumes whole escapes, so a backslash that starts another escape is left as it is.
export function remedyJson(value) {
  return JSON.stringify(value).replace(/\\(.)/gs, (escape, char) => (char === '\\' ? '\\u005c' : escape))
}

/** Strip heredoc BODIES — never real shell in the segment they sit in, always pure data. */
export function stripHeredocs(cmd) {
  return cmd.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    '<<HEREDOC-BODY-STRIPPED',
  )
}

/** Strip quoted SPANS to empty quotes, so text merely mentioned or echoed stops looking like an instruction. */
export function stripQuotedSpans(cmd) {
  return cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

/** Strip heredocs before quotes because a body can contain quotes that would otherwise swallow code. */
export function stripNonCode(cmd) {
  return stripQuotedSpans(stripHeredocs(cmd))
}

// Does a Bash command invoke something, rather than merely mentioning it in prose.
export function stripNonCommandText(command) {
  return stripNonCode(command)
}

export function commandHeads(command) {
  return stripNonCommandText(command)
    .split(/&&|\|\||;|\||\n|\(|\{|\$\(/)
    .map((segment) => segment.trim().replace(/^(?:sudo\s+|env\s+|(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+)/, ''))
    .filter(Boolean)
}

export function invokes(command, headRe) {
  return typeof command === 'string' && Boolean(command) && commandHeads(command).some((head) => headRe.test(head))
}

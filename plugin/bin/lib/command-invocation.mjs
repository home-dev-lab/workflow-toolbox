// Does a Bash command invoke something, rather than merely mentioning it in prose.
export function stripNonCommandText(command) {
  let text = command
  text = text.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '\n')
  return text.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
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

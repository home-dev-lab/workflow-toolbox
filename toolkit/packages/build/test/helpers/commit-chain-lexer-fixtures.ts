export const LEXER_CASES = [
  ['G1 arithmetic shift', 'echo $((1 << 2));\npnpm test; git commit -m x', 'WARN'],
  ['G1 arithmetic compact', 'echo $((a<<b)); pnpm test; git commit -m x', 'WARN'],
  ['G1 arithmetic command', '((1 << 2)); pnpm test; git commit -m x', 'WARN'],
  ['G1 escaped delimiter', 'cat <<\\EOF\nx\nEOF\npnpm test; git commit -m x', 'WARN'],
  ['G1 mixed delimiter', 'cat <<E"OF"\nx\nEOF\npnpm test; git commit -m x', 'WARN'],
  ['G1 quoted whitespace delimiter', "cat <<'A B'\nx\nA B\npnpm test; git commit -m x", 'WARN'],
  ['G1 missing terminator', 'cat <<EOF\npnpm test; git commit -m x', 'WARN'],
  ['G1 missing newline', 'cat <<EOF; pnpm test; git commit -m x', 'WARN'],
  ['G1 multiple exact bodies', 'cat <<\\A <<B\nx\nA\npnpm test; git commit -m x\nB', 'SILENT'],
  ['G1 later missing terminator', 'cat <<A <<B\nx\nA\npnpm test; git commit -m x', 'WARN'],
  ['G1 backslash kept in single-quoted delimiter', "cat <<'E\\OF'\nx\nE\\OF\npnpm test; git commit -m x\nEOF", 'WARN'],
  ['G1 apostrophe in an earlier body', "cat <<A\nit's\nA\ncat <<'B'\npnpm test; git commit -m x\nB", 'SILENT'],
  ['G1 uncertain then certain', 'cat <<MISSING\ncat <<EOF\nx\nEOF\npnpm test; git commit -m x', 'WARN'],
  ['G2 unmatched double quote', 'echo "unbalanced\npnpm test; git commit -m x', 'WARN'],
  ['G2 unmatched single quote', "echo 'unbalanced\npnpm test; git commit -m x", 'WARN'],
  ['G2 terminated quoted data', 'echo "pnpm test; git commit -m x"', 'SILENT'],
  ['G2 escaped space before hash', "printf '%s' foo\\ #bar; pnpm test; git commit -m x", 'WARN'],
  ['G2 comments', '# pnpm test; git commit -m x\necho done', 'SILENT'],
  ['G3 redirected commit', 'pnpm test; >/dev/null git commit -m x', 'WARN'],
  ['G3 redirected gate', '>/dev/null pnpm test; git commit -m x', 'WARN'],
  ['G3 redirection two words', '2> log pnpm test; < input git commit -m x', 'WARN'],
  ['G3 redirection wrappers', '>log env X=y timeout 30 pnpm test; >&2 git commit -m x', 'WARN'],
  ['G3 append redirection', '>>log pnpm test; git commit -m x', 'WARN'],
  ['G3 fd redirection', '2>log pnpm test; git commit -m x', 'WARN'],
  ['G3 ampersand redirection', '&>log pnpm test; git commit -m x', 'WARN'],
  ['G3 input redirection', '<input pnpm test; git commit -m x', 'WARN'],
  ['G3 fd duplication', '2>&1 pnpm test; git commit -m x', 'WARN'],
  ['G3 output two words', '> log pnpm test; git commit -m x', 'WARN'],
  ['G3 interleaved assignments', '>log X=y 2>err pnpm test; git commit -m x', 'WARN'],
  ['G5 negated make', '! make check && git commit -m x', 'WARN'],
  ['G5 negated node', '! node scripts/check.mjs && git commit -m x', 'WARN'],
] as const

export const MERGE_LEXER_CASES = [
  ['arithmetic shift regression', 'echo $((1 << 2));\ngit merge branch; pnpm test', 'WARN', 'WARN', 'SILENT'],
  ['escaped delimiter regression', 'cat <<\\EOF\nx\nEOF\ngit merge branch; pnpm test', 'WARN', 'WARN', 'SILENT'],
  ['backslash kept in single-quoted delimiter', "cat <<'E\\OF'\nx\nE\\OF\ngit merge branch; pnpm test\nEOF", 'WARN', 'WARN', 'SILENT'],
  ['quoted apparent heredoc', "printf '%s' '<<EOF'; git merge branch; pnpm test", 'WARN', 'SILENT', 'WARN'],
  ['tab stripped heredoc', 'cat <<-EOF\n\tx\n\tEOF\ngit merge branch; pnpm test', 'WARN', 'SILENT', 'WARN'],
  ['numeric heredoc data', 'cat <<123\ngit merge branch; pnpm test\n123', 'SILENT', 'WARN', 'SILENT'],
  ['unterminated quote floor', 'echo "unbalanced\ngit merge branch; pnpm test', 'WARN', 'SILENT', 'WARN'],
  ['leading redirection classification', 'git merge branch; >/dev/null pnpm test', 'WARN', 'WARN', 'WARN'],
] as const

export function lexerPropertyCommands() {
  const shapes = [
    ['pnpm test;', 'git commit -m x'],
    ['pnpm lint\n', 'git commit -m x'],
    ['node scripts/check.mjs ||', 'git commit -m x'],
    ['npx tsc | tail -1;', 'git commit -m x'],
    ['make check &', 'git commit -m x'],
  ]
  const fragments = [
    'cat <<X', 'cat <<\\X', 'cat <<"X"', 'cat <<-X', 'echo $((a<<b))',
    'echo $((1 << 2))', 'echo "unbalanced', "echo 'unbalanced", '>/dev/null true', 'cat <<<word',
  ]
  return shapes.flatMap(([gate, commit]) => fragments.flatMap((fragment) => [
    `${fragment}\n${gate} ${commit}`,
    `${gate}\n${fragment}\n${commit}`,
    `${gate} ${commit}\n${fragment}`,
    `${fragment}; ${gate} ${commit}`,
    `${gate} ${fragment}; ${commit}`,
    `${gate} ${commit}; ${fragment}`,
  ]))
}

// node plugin/bin/wt-adopt-check-hook.selftest.mjs — known-answer cases for looksLikePush: the PostToolUse
// pre-filter must fire on a git push INVOCATION only, never on the words inside a heredoc body or a quoted
// string (measured 2026-09-05: a card description written with `cat <<'EOF'` that mentioned the words fired
// the drift notice three times in one afternoon while no push happened).
import { looksLikePush } from './wt-adopt-check-hook.mjs'

const cases = [
  ['git push public main', true, 'plain push'],
  ['git -C /repo push origin develop', true, 'git -C push'],
  ['pnpm test && git push origin develop', true, 'push after &&'],
  ['cd /x; git push', true, 'push after ;'],
  ['(cd /x && git push)', true, 'push in a subshell'],
  ['GIT_SSH_COMMAND=ssh git push', true, 'env-prefixed push'],
  ["cat > card.md <<'EOF'\nAlso cover `git push` to public for the toolbox: refuse when...\nEOF\nnode tool.mjs", false, 'the words inside a heredoc body'],
  ['echo "run git push later"', false, 'the words inside a double-quoted string'],
  ["grep -n 'git push' file.md", false, 'the words inside a single-quoted string'],
  ['git status && git log --oneline -3', false, 'no push at all'],
  ['npm run push-docs', false, 'push as part of another word'],
  ['git pushx', false, 'push with a suffix'],
]

let fail = 0
for (const [cmd, expected, name] of cases) {
  const got = looksLikePush(cmd)
  const ok = got === expected
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} → ${got}`)
}
console.log(`${cases.length - fail}/${cases.length} passed`)
process.exit(fail ? 1 : 0)

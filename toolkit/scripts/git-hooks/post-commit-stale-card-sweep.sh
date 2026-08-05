#!/usr/bin/env bash
# OPT-IN TEMPLATE ONLY: git runs hooks only from `.git/hooks/`, and that directory is never
# tracked by git, so this script does nothing until someone deliberately installs it locally.
# Install from the repo root with:
#   cp toolkit/scripts/git-hooks/post-commit-stale-card-sweep.sh .git/hooks/post-commit && chmod +x .git/hooks/post-commit
# Git executes this file directly; the `#!/usr/bin/env bash` shebang is what selects the
# interpreter. On Windows, Git for Windows ships its own bash (MSYS2) on PATH, which is what
# makes this shebang resolve there too — the same assumption the repo's existing pre-push hook
# already relies on. This has NOT been tested on Windows; state that plainly rather than implying
# coverage.

set -uo pipefail

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

append_log() {
  local log_file="$1"
  local message="$2"
  printf '%s %s\n' "$(timestamp)" "$message" >> "$log_file"
}

# No log entry on this one branch, by necessity rather than oversight: the log file lives
# under the repo root, so if we cannot resolve the repo root there is no location to log to.
# Git only ever invokes a post-commit hook from inside a working tree, so this branch is not
# expected to fire in practice.
repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

claude_dir="$repo_root/.claude"
mkdir -p "$claude_dir"
log_file="$claude_dir/stale-card-sweep-hook.log"
planka_file="$claude_dir/planka.json"

if [[ ! -f "$planka_file" ]]; then
  append_log "$log_file" 'skip: missing .claude/planka.json'
  exit 0
fi

board_id="$({ node -e '
const fs = require("node:fs")
const path = process.argv[1]
const data = JSON.parse(fs.readFileSync(path, "utf8"))
if (typeof data.boardId === "string" && data.boardId.length > 0) process.stdout.write(data.boardId)
' "$planka_file"; } 2>/dev/null)"

if [[ -z "$board_id" ]]; then
  append_log "$log_file" 'skip: missing boardId in .claude/planka.json'
  exit 0
fi

# --root: a root commit (no parent) otherwise diffs against nothing and reports zero files.
# -m: a merge commit otherwise diffs against nothing by default too (git shows merge diffs only
#     on request) — `-m` diffs it against EACH parent, which can repeat a path once per parent;
#     `sort -u` collapses that back to a plain set. Both flags are no-ops on an ordinary
#     single-parent, non-root commit, so this is safe unconditionally.
mapfile -t changed_files < <(git diff-tree --no-commit-id --name-only -r --root -m HEAD 2>/dev/null | sort -u)
if [[ ${#changed_files[@]} -eq 0 ]]; then
  append_log "$log_file" 'skip: no changed files in HEAD'
  exit 0
fi

command=(npx --yes tsx scripts/stale-card-sweep.ts --board "$board_id" --hook)
for file in "${changed_files[@]}"; do
  command+=(--changed-file "$file")
done

output=''
if output="$(cd "$repo_root/toolkit" && "${command[@]}" 2>/dev/null)"; then
  if [[ -n "$output" ]]; then
    candidate_count="$(printf '%s\n' "$output" | grep -c '^card ' || true)"
    append_log "$log_file" "flagged ${candidate_count} candidate(s)"
    printf '\n%s\n' "$output"
  else
    append_log "$log_file" 'clean'
  fi
else
  append_log "$log_file" 'error: stale-card-sweep invocation failed'
fi

exit 0

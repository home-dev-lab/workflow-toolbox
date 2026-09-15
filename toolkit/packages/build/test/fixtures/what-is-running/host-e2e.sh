#!/usr/bin/env bash
set -u

session="wir-e2e-$$-${RANDOM}-$(date +%s%N)"
fixture_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
plugin_dir="$(cd -- "$fixture_dir/../../../../../../plugin" && pwd)"
matcher="$fixture_dir/host-capture-match.mjs"
capture=''
sent=0
trusted=0

cleanup() {
  tmux kill-session -t "$session" 2>/dev/null || true
}

if ! validation="$(claude plugin validate "$plugin_dir" --strict 2>&1)"; then
  printf 'plugin manifest invalid (claude plugin validate --strict):\n%s\n' "$validation"
  exit 3
fi

tmux new-session -d -s "$session" -x "${COLS:-160}" -y 50 "claude --model haiku --setting-sources '' --tools '' --strict-mcp-config --plugin-dir \"$plugin_dir\"" || exit 1
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  capture="$(tmux capture-pane -p -t "$session" 2>/dev/null || true)"
  if printf '%s\n' "$capture" | node "$matcher"; then
    sleep 3
    capture="$(tmux capture-pane -p -t "$session" 2>/dev/null || true)"
    if printf '%s\n' "$capture" | node "$matcher"; then
      printf '%s\n' "$capture"
      exit 0
    fi
  fi
  if [[ $trusted -eq 0 && "$capture" == *"Yes, I trust this folder"* ]]; then
    tmux send-keys -t "$session" Down Enter
    trusted=1
    sleep 1
    continue
  fi
  if [[ $sent -eq 0 && ( "$capture" == *"❯"* || "$capture" == *">"* ) ]]; then
    tmux send-keys -t "$session" '/wir' Enter
    sent=1
  fi
  sleep 1
done

printf '%s\n' "$capture"
exit 1

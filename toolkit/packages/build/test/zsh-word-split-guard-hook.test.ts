import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs hook under plugin/bin/
import { analyze } from '../../../../plugin/bin/wt-zsh-word-split-guard-hook.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-zsh-word-split-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const roots: string[] = []

const FIELD_CASE =
  `L=""; for p in $(ps -eo pid=,comm= | awk '$2=="yes"||$2=="grep"{print $1}'); do c=$(readlink /proc/$p/cwd 2>/dev/null); case "$c" in /home/x/*) L="$L $p";; esac; done; kill $L 2>/dev/null; sleep 2; S=""; for p in $L; do kill -0 $p 2>/dev/null && S="$S $p"; done; [ -n "$S" ] && kill -9 $S; R=0; for p in $L; do kill -0 $p 2>/dev/null && R=$((R+1)); done; echo "still alive: $R"`

const FIELD_CASE_ARRAYS =
  `L=(); for p in $(ps -eo pid=,comm= | awk '$2=="yes"||$2=="grep"{print $1}'); do c=$(readlink /proc/$p/cwd 2>/dev/null); case "$c" in /home/x/*) L+=($p);; esac; done; (( \${#L} )) && kill "\${L[@]}" 2>/dev/null; sleep 2; S=(); for p in "\${L[@]}"; do kill -0 $p 2>/dev/null && S+=($p); done; (( \${#S} )) && kill -9 "\${S[@]}"; R=0; for p in "\${L[@]}"; do kill -0 $p 2>/dev/null && R=$((R+1)); done; echo "still alive: $R"`

type Payload = Record<string, unknown>

function run(payload: Payload, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpdir(), SHELL: '/bin/zsh', WT_GUARD_MODE: '', ...env },
  })
  return { ...result, context: result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.additionalContext ?? '' : '' }
}

function bash(command: string, env: NodeJS.ProcessEnv = {}) {
  return run({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    session_id: 'vitest',
    tool_input: { command },
  }, env)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The private selftest's 36 analyzer verdicts, preserved one-for-one.
const analyzerCases: Array<[string, string, string[]]> = [
  ['field case', FIELD_CASE, ['L', 'S']],
  ['set -- $pair', 'pair="a:b c"; set -- $pair; echo "$1 / $2"', ['pair']],
  ['cmdsub list iterated with for', 'FILES=$(git diff --name-only); for f in $FILES; do wc -l "$f"; done', ['FILES']],
  ['literal flags passed to a command', 'FLAGS="-q --no-ff"; git merge $FLAGS develop', ['FLAGS']],
  ['+= accumulation', 'L=""; for p in 1 2 3; do L+=" $p"; done; kill $L', ['L']],
  ['typeset-declared list', 'typeset ids="12 34"; kill -TERM $ids', ['ids']],
  ['braced ref is still a scalar', 'L="1 2"; kill ${L}', ['L']],
  ['inside a command substitution', 'L="1 2"; out=$(kill $L 2>&1); echo "$out"', ['L']],
  ['field case, array version', FIELD_CASE_ARRAYS, []],
  ['for over $(ls)', 'for f in $(ls); do echo "$f"; done', []],
  ['quoted single pid', 'PID=$(pgrep -f observe); kill "$PID"', []],
  ['explicit ${=L} split', 'L="a b"; for x in ${=L}; do echo "$x"; done', []],
  ['explicit $=L split', 'L="a b"; kill $=L', []],
  ['array unquoted in zsh splits', 'L=(1 2 3); kill $L; for x in $L; do echo $x; done', []],
  ['scalar list later re-made an array', 'L="1 2"; L=(${=L}); kill $L', []],
  ['array declared by typeset -a', 'typeset -a L; L+=(1); L+=(2); kill $L', []],
  ['echo of a phrase', 'MSG="hello world"; echo $MSG', []],
  ['path with a space', 'DIR="/mnt/c/Program Files"; ls $DIR', []],
  ['scalar with no space', 'DIR=$HOME/projects/wt-suite; ls $DIR', []],
  ['counter', 'R=0; R=$((R+1)); echo $R; exit $R', []],
  ['bash -c single-quoted body runs under bash', `setsid nohup bash -c 'L="a b"; kill $L' > /dev/null 2>&1 &`, []],
  ['quoted heredoc body is data', `git commit -F - <<'EOF'\nL="a b"; kill $L\nEOF`, []],
  ['setopt shwordsplit makes it split', 'setopt shwordsplit; L="1 2"; kill $L', []],
  ['use before any assignment is not ours', 'kill $L; L="1 2"', []],
  ['unassigned variable', 'for x in $SOME_LIST; do echo "$x"; done', []],
  ['test with unquoted list', 'L="a b"; [ -n $L ] && echo yes', []],
  ['real: git log', 'git -C /home/doublefx/projects/wt-suite/workflow-toolbox log --oneline -5', []],
  ['real: pnpm gate with EXIT marker', 'cd /home/doublefx/projects/wt-suite/workflow-toolbox/toolkit && pnpm test > /tmp/g.log 2>&1; echo EXIT=$? >> /tmp/g.log', []],
  ['real: node board script', 'node .claude/scripts/board-list.mjs --list "In Progress" --json | head', []],
  ['real: branch var', 'B=$(git branch --show-current); echo "$B"; git log --oneline "$B" -3', []],
  ['real: node --check loop', 'for f in toolkit/scripts/*.mjs; do node --check "$f" || echo "bad $f"; done', []],
  ['real: lane launcher', 'node ~/.claude/scripts/wt-lane.mjs --dir /x/wt --model openai/gpt-5.6-sol --brief /x/wt/.lane/brief.md --timeout 5400', []],
  ['real: commit -F file', 'git -C /x/wt add -A && git -C /x/wt commit -F /tmp/msg.txt', []],
  ['real: pnpm typecheck with pipe', 'pnpm typecheck 2>&1 | tail -20', []],
  ['real: worktree add', 'git -C workflow-toolbox worktree add /home/doublefx/projects/wt-suite/.claude/worktrees/foo -b card/123-foo develop', []],
  ['real: jq over a file', `jq -r '.hooks.PreToolUse[] | .matcher' ~/.claude/settings.json | sort | uniq -c`, []],
]

describe('wt-zsh-word-split-guard-hook analyzer cases', () => {
  it.each(analyzerCases)('%s', (_label, command, names) => {
    const result = bash(command)
    expect(result.status).toBe(0)
    expect([...new Set(analyze(command).map((finding: { name: string }) => finding.name))].sort()).toEqual(names)
    expect(Boolean(result.context)).toBe(names.length > 0)
    for (const name of names) expect(result.context).toContain(`\`${name}\``)
  })

  it.each([
    ['git rev-parse returns one revision', 'pre=$(git rev-parse abc123^); for rev in $pre HEAD; do echo "$rev"; done'],
    ['ps for one pid returns one parent pid', `P=$(ps -o ppid= -p $$ | tr -d ' '); for c in $P 1; do echo "$c"; done`],
  ])('measured false positive: %s', (_label, command) => {
    expect(bash(command).stdout).toBe('')
  })
})

describe('wt-zsh-word-split-guard-hook option and scope precision', () => {
  it.each([
    ['set -o form', 'set -o shwordsplit; L="1 2"; kill $L'],
    ['quoted option name', 'setopt "shwordsplit"; L="1 2"; kill $L'],
    ['control-flow prefix', 'if true; then setopt shwordsplit; fi; L="1 2"; kill $L'],
  ])('stays silent when splitting is enabled with the %s', (_label, command) => {
    expect(bash(command).stdout).toBe('')
  })

  it.each([
    ['a later scalar assignment', 'L="1 2"; L=3; kill $L'],
    ['an assignment in a command substitution', 'L=ok; out=$(L="a b"); kill $L'],
    ['an assignment in a subshell', 'L=ok; (L="a b"); kill $L'],
  ])('stays silent after %s', (_label, command) => {
    expect(bash(command).stdout).toBe('')
  })

  it('does not treat quoted text as an option change', () => {
    expect(bash('echo "x; setopt shwordsplit; y"; L="1 2"; kill $L').context).toContain('zsh does not word-split')
  })

  it('stays silent for quoted option text without a risky scalar', () => {
    expect(bash('echo "x; setopt shwordsplit; y"').stdout).toBe('')
  })
})

describe('wt-zsh-word-split-guard-hook contract', () => {
  it('warns without denying and names safe forms', () => {
    const result = bash(FIELD_CASE)
    expect(result.context).toContain('zsh does not word-split')
    expect(result.context).toContain('${=L}')
    expect(result.context).toContain('cannot inspect options enabled in your .zshrc')
    expect(result.stdout).not.toContain('permissionDecision')
  })

  it('stays silent for an ordinary command', () => {
    expect(bash('git status').stdout).toBe('')
  })

  it.skipIf(process.platform === 'win32')('still runs when invoked through a symlinked path (entry guard compares real paths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-zsh-word-split-link-')); roots.push(dir)
    const link = join(dir, 'hook.mjs')
    symlinkSync(HOOK, link)
    const result = spawnSync(process.execPath, [link], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: FIELD_CASE } }),
      encoding: 'utf8',
      env: { ...process.env, HOME: tmpdir(), SHELL: '/bin/zsh', WT_GUARD_MODE: '' },
    })
    expect(result.stdout).toContain('zsh does not word-split')
  })

  it('stays silent for a subagent payload', () => {
    const result = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'a123', tool_input: { command: FIELD_CASE } })
    expect(result.stdout).toBe('')
  })

  it('ignores non-Bash tools', () => {
    const result = run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { command: FIELD_CASE } })
    expect(result.stdout).toBe('')
  })

  it('fails open on malformed stdin', () => {
    const result = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, HOME: tmpdir(), SHELL: '/bin/zsh' } })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('journals a warning', () => {
    const journal = mkdtempSync(join(tmpdir(), 'wt-zsh-word-split-journal-')); roots.push(journal)
    bash(FIELD_CASE, { WT_GUARD_JOURNAL_DIR: journal })
    const entries = readdirSync(journal).filter((file) => file.endsWith('.ndjson'))
      .flatMap((file) => readFileSync(join(journal, file), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    expect(entries).toContainEqual(expect.objectContaining({
      guard: 'wt-zsh-word-split-guard-hook.mjs', decision: 'warned', class: 'zsh-unquoted-scalar-split',
    }))
  })

  it('stays silent when the invoking shell is not zsh', () => {
    expect(bash(FIELD_CASE, { SHELL: '/bin/bash' }).stdout).toBe('')
  })

  it('recognizes the sh_word_split spelling', () => {
    expect(bash('setopt sh_word_split; L="1 2"; kill $L').stdout).toBe('')
  })

  it('is registered as a PreToolUse Bash hook', () => {
    expect(existsSync(HOOK)).toBe(true)
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const commands = (manifest.hooks?.PreToolUse ?? [])
      .filter((entry: { matcher?: string }) => entry.matcher === 'Bash')
      .flatMap((entry: { hooks?: Array<{ command?: string }> }) => entry.hooks ?? [])
      .map((hook: { command?: string }) => hook.command ?? '')
    expect(commands.some((command: string) => command.includes('wt-zsh-word-split-guard-hook.mjs'))).toBe(true)
  })
})

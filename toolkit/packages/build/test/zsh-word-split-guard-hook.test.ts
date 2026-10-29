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
  ['real: git log', 'git -C /home/dev/projects/wt-suite/workflow-toolbox log --oneline -5', []],
  ['real: pnpm gate with EXIT marker', 'cd /home/dev/projects/wt-suite/workflow-toolbox/toolkit && pnpm test > /tmp/g.log 2>&1; echo EXIT=$? >> /tmp/g.log', []],
  ['real: node board script', 'node .claude/scripts/board-list.mjs --list "In Progress" --json | head', []],
  ['real: branch var', 'B=$(git branch --show-current); echo "$B"; git log --oneline "$B" -3', []],
  ['real: node --check loop', 'for f in toolkit/scripts/*.mjs; do node --check "$f" || echo "bad $f"; done', []],
  ['real: lane launcher', 'node ~/.claude/scripts/wt-lane.mjs --dir /x/wt --model openai/gpt-5.6-sol --brief /x/wt/.lane/brief.md --timeout 5400', []],
  ['real: commit -F file', 'git -C /x/wt add -A && git -C /x/wt commit -F /tmp/msg.txt', []],
  ['real: pnpm typecheck with pipe', 'pnpm typecheck 2>&1 | tail -20', []],
  ['real: worktree add', 'git -C workflow-toolbox worktree add /home/dev/projects/wt-suite/.claude/worktrees/foo -b card/123-foo develop', []],
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

function registerBasicNoticeCases() {
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

}

function registerSubagentAndInputCases() {
  it('delivers the exact file-copy loop warning to the subagent that triggered it', () => {
    const result = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'copy-worker',
      tool_input: { command: 'files=$(git -C $X diff --name-only); for f in $files; do mkdir -p $(dirname $W/$f); cp -f $X/$f $W/$f; done' } })
    expect(result.status).toBe(0)
    expect(result.context).toContain('zsh does not word-split')
    expect(result.context).toContain('`files`')
    expect(result.stdout).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: result.context } }))
  })

  it('delivers a warning for a subagent payload', () => {
    const result = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'a123', tool_input: { command: FIELD_CASE } })
    expect(result.context).toContain('zsh does not word-split')
    expect(result.stdout).not.toContain('permissionDecision')
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

}

function registerJournalAndScopeCases() {
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
}

describe('wt-zsh-word-split-guard-hook contract', () => {
  registerBasicNoticeCases()
  registerSubagentAndInputCases()
  registerJournalAndScopeCases()
})

type CharacterizationFinding = { name: string; kind: 'list' | 'cmdsub'; context: 'args' | 'for' | 'set'; use: string }

const listFindings: CharacterizationFinding[] = [{ name: 'L', kind: 'list', context: 'args', use: 'kill $L' }]
const loopFindings: CharacterizationFinding[] = [{ name: 'L', kind: 'cmdsub', context: 'for', use: 'for ... in $L' }]

// Lock complete findings, including their order and use text, before splitting the lexer helpers.
const characterizationCases: Array<[string, string, CharacterizationFinding[]]> = [
  ['escaped whitespace', 'L=a\\ b; kill $L', listFindings],
  ['escaped tab', 'L=a\\\tb; kill $L', listFindings],
  ['line continuation inside a word', 'L=a\\\nb; kill $L', []],
  ['line continuation between words', 'L="a b"; \\\nkill $L', listFindings],
  ['double-quoted escaped space retains current silence', 'L="a\\ b"; kill $L', []],
  ['single-quoted scalar', "L='a b'; kill $L", listFindings],
  ['single-quoted empty scalar', "L=''; kill $L", []],
  ['unterminated single quote', "L='a b; kill $L", []],
  ['unterminated double quote', 'L="a b; kill $L', []],
  ['trailing backslash inside double quotes', 'L="a\\', []],
  ['trailing unquoted backslash', 'L=a\\; kill $L\\', []],
  ['balanced midword glob', 'L="a b"; kill foo(bar) $L', listFindings],
  ['unterminated midword glob', 'L="a b"; kill foo(bar $L', []],
  ['ANSI-C newline escape', "L=$'a\\nb'; kill $L", listFindings],
  ['ANSI-C tab escape', "L=$'a\\tb'; kill $L", listFindings],
  ['ANSI-C escaped quote', "L=$'a\\' b'; kill $L", listFindings],
  ['ANSI-C non-whitespace escape', "L=$'a\\rb'; kill $L", []],
  ['unterminated ANSI-C quote', "L=$'a b; kill $L", []],
  ['braced copy', 'L="a b"; X=${L}; kill $X', [{ name: 'X', kind: 'list', context: 'args', use: 'kill $X' }]],
  ['braced flags copy', 'L="a b"; X=${=#^~+L}; kill $X', [{ name: 'X', kind: 'list', context: 'args', use: 'kill $X' }]],
  ['braced no-name substitution', 'L=${1:-$(printf x)}; for x in $L', loopFindings],
  ['braced nested command is analyzed', 'L="a b"; echo ${X:-$(kill $L)}', listFindings],
  ['braced arithmetic is not a command substitution', 'L=${X:-$((1+2))}; for x in $L', []],
  ['unterminated braced expression', 'L="a b"; kill ${L', []],
  ['unquoted backtick assignment', 'L=`printf x`; for x in $L', loopFindings],
  ['quoted backtick assignment', 'L="`printf x`"; for x in $L', loopFindings],
  ['backtick nested command', 'L="a b"; echo `kill $L`', listFindings],
  ['backtick escape', 'L=`printf \\`x`; for x in $L', loopFindings],
  ['unterminated backtick', 'L=`printf x; for x in $L', []],
  ['quoted command substitution', 'L="$(printf x)"; for x in $L', loopFindings],
  ['nested parentheses and quotes in substitution', 'L=$(echo ("a)" \'b)\')); for x in $L', loopFindings],
  ['nested parameters in quoted substitution', 'L=$(echo "${X:-$(echo x)}"); for x in $L', loopFindings],
  ['backticks inside balanced substitution', 'L=$(echo `printf x`); for x in $L', loopFindings],
  ['escaped closing parenthesis', 'L=$(echo \\)); for x in $L', loopFindings],
  ['unterminated command substitution', 'L=$(printf x; for x in $L', []],
  ['special parameters and lone dollars', 'L="a b"; echo $? $$ $# $@ $* $- $! $0 $9 $; kill $L', listFindings],
  ['lone dollar at EOF', 'L="a b"; echo $', []],
  ['unrecognized dollar suffix', 'L="a b"; echo $%; kill $L', listFindings],
  ['braced numeric parameter without substitution', 'L=${1}; for x in $L', []],
  ['arithmetic assignment', 'L=$((1+2)); for x in $L', []],
  ['arithmetic command boundary', 'L="a b"; ((x++)); kill $L', listFindings],
  ['comment with newline', 'L="a b"; # kill $L\nkill $L', listFindings],
  ['comment without newline', 'L="a b"; # kill $L', []],
  ['hash inside word stays literal', 'L="a b"; echo foo#bar; kill $L', listFindings],
  ['process input substitution', 'L="a b"; cat <(kill $L)', listFindings],
  ['process output substitution', 'L="a b"; cat >(kill $L)', listFindings],
  ['redirected substitution', 'L="a b"; cat 2>$(kill $L)', listFindings],
  ['redirect target alone does not flag', 'L="a b"; cat >$L', []],
  ['redirect with no target before operator', 'L="a b"; cat > ; kill $L', listFindings],
  ['redirect with no target at EOF', 'L="a b"; cat >', []],
  ['redirect whitespace', 'L="a b"; cat 2> \t /dev/null; kill $L', listFindings],
  ['plain heredoc', 'cat <<EOF\nL="a b"; kill $L\nEOF\nkill $L', []],
  ['double-quoted stripped heredoc', 'L="a b"; cat <<-"EOF"\n\tkill $L\n\tEOF\nkill $L', listFindings],
  ['multiple pending heredocs', 'L="a b"; cat <<A <<-B\nkill $L\nA\n\tkill $L\n\tB\nkill $L', listFindings],
  ['unterminated heredoc final line', 'L="a b"; cat <<EOF\nkill $L', []],
  ['heredoc delimiter without final newline', 'L="a b"; cat <<EOF\nEOF', []],
  ['missing heredoc tag', 'L="a b"; cat <<\nkill $L', listFindings],
  ['array element assignment', 'L[1]="a b"; kill $L', []],
  ['array append on unknown name', 'L+=(a b); kill $L', []],
  ['scalar append promotes cmdsub to list', 'L=$(printf x); L+=" y"; kill $L', listFindings],
  ['copy preserves list classification', 'L="a b"; X=$L; kill $X', [{ name: 'X', kind: 'list', context: 'args', use: 'kill $X' }]],
  ['assignments and prefixes before command', 'do time L="a b" noglob kill $L', listFindings],
  ['assignments and prefixes only', 'L="a b"; do then', []],
  ['command substitution before prefix assignment', 'L="a b" out=$(kill $L)', []],
  ['select in scalar list', 'L="a b"; select x in $L', [{ name: 'L', kind: 'list', context: 'for', use: 'select ... in $L' }]],
  ['foreach in scalar list', 'L="a b"; foreach x in $L', [{ name: 'L', kind: 'list', context: 'for', use: 'foreach ... in $L' }]],
  ['loop without in clause', 'L="a b"; for x $L', []],
  ['loop without args', 'L="a b"; for', []],
  ['set flags cmdsub', 'L=$(printf x); set -- $L', [{ name: 'L', kind: 'cmdsub', context: 'set', use: 'set -- $L' }]],
  ['set quoted scalar', 'L="a b"; set -- "$L"', []],
  ['typeset array assignment', 'typeset -a L="a b"; kill $L', []],
  ['typeset associative name', 'L="a b"; typeset +A L; kill $L', []],
  ['typeset flag persists across args', 'typeset -ax ignored L="a b"; kill $L', []],
  ['typeset invalid array name', 'L="a b"; typeset -a not-a-name; kill $L', listFindings],
  ['declaration without array flag ignores bare name', 'L="a b"; local L; kill $L', listFindings],
  ['declared scalar append', 'typeset L=x L+=" y"; kill $L', listFindings],
  ['bare scalar as command', 'L="a b"; $L', [{ name: 'L', kind: 'list', context: 'args', use: ' $L' }]],
  ['braced scalar as command', 'L="a b"; ${L}', [{ name: 'L', kind: 'list', context: 'args', use: ' ${L}' }]],
  ['literal concatenation is not an exact reference', 'L="a b"; kill prefix$L $L/suffix', []],
  ['emulate shell splitting', 'emulate -L sh; L="a b"; kill $L', []],
  ['emulate with combined flags before the mode', 'emulate -LR sh; L="a b"; kill $L', []],
  ['emulate ksh mode after a flag', 'emulate -R ksh; L="a b"; kill $L', []],
  // zsh -f: `emulate foo sh` fails with "unknown argument sh" and leaves splitting off.
  ['emulate with an invalid mode does not split', 'emulate foo sh; L="a b"; kill $L', listFindings],
  // zsh -f: `emulate sh -c cmd` emulates for that one command only.
  ['emulate -c scopes the mode to one command', 'emulate sh -c true; L="a b"; kill $L', listFindings],
  ['emulate zsh mode does not split', 'emulate zsh; L="a b"; kill $L', listFindings],
  ['dynamic option argument is not recognized', 'setopt $option shwordsplit; L="a b"; kill $L', listFindings],
  ['preserves current redirected-option warning', 'setopt >/dev/null shwordsplit; L="a b"; kill $L', listFindings],
  ['preserves current assignment-prefixed-option warning', 'X=x setopt shwordsplit; L="a b"; kill $L', listFindings],
]

describe('wt-zsh-word-split-guard-hook lexer and command characterizations', () => {
  it.each(characterizationCases)('%s', (_label, command, findings) => {
    expect(analyze(command)).toEqual(findings)
  })

  it.each([';;', ';&', ';|', '&&', '||', '|&', '&!', '&|', ';', '|', '&', '\n'])('splits commands on %j', (operator) => {
    expect(analyze(`L="a b" ${operator} kill $L`)).toEqual(listFindings)
  })

  it.each(['&>>', '&>', '<<<', '>>', '>|', '>!', '>&', '<&', '<>', '>', '<'])('recognizes %s redirection', (operator) => {
    expect(analyze(`L="a b"; cat ${operator} /dev/null; kill $L`)).toEqual(listFindings)
  })

  it.each(['echo', 'print', 'printf', '[', '[[', 'test', 'eval', ':', 'exit', 'return', 'unset', 'read', 'case', 'source', '.', 'let'])('stays silent for %s', (command) => {
    expect(analyze(`L="a b"; ${command} $L`)).toEqual([])
  })
})

describe('wt-zsh-word-split-guard-hook exact notice and journal characterizations', () => {
  it('preserves the full notice, deduplicated uses and three-use limit', () => {
    const result = bash('L="a b"; kill $L; kill $L; for x in $L; set -- $L; cat $L')
    const text = '[workflow-toolbox zsh word-split guard] zsh does not word-split an unquoted scalar: ' +
      '`L` (built as a space-separated string, then used as `kill $L`, `for ... in $L`, `set -- $L`) ' +
      'will reach the command as one word; a command can receive one malformed argument and a loop can run once. ' +
      'Use `${=L}` for an explicit split, or an array: `L=()`, `L+=(value)`, then `"${L[@]}"`. ' +
      'This hook recognizes `setopt shwordsplit` in the same command but cannot inspect options enabled in your .zshrc.'
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }))
  })

  it.each([['observe', 'observe', ''], ['subagent', '', 'a123']])('preserves the %s notice contract and journal record', (_label, mode, agent) => {
    const journal = mkdtempSync(join(tmpdir(), 'wt-zsh-word-split-characterization-')); roots.push(journal)
    const result = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'vitest', agent_id: agent,
      tool_input: { command: 'L="a b"; kill $L' } }, {
      WT_GUARD_MODE: mode, WT_GUARD_JOURNAL_DIR: journal,
      WT_GUARD_JOURNAL_NOW: '2026-01-05T00:00:00Z', WT_GUARD_JOURNAL_TEST_ORIGIN: '1',
    })
    expect(result.status).toBe(0)
    if (mode === 'observe') expect(result.stdout).toBe('')
    else expect(result.context).toContain('zsh does not word-split')
    const entries = readdirSync(journal).filter((file) => file.endsWith('.ndjson'))
      .flatMap((file) => readFileSync(join(journal, file), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ ts: '2026-01-05T00:00:00.000Z', guard: 'wt-zsh-word-split-guard-hook.mjs',
      decision: mode === 'observe' ? 'silent' : 'warned', mode: mode || 'enforce', origin: 'test',
      class: 'zsh-unquoted-scalar-split', session: 'vitest', evidence: { vars: 'L' }, ...(agent ? { agent } : {}),
    })
  })
})

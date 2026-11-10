// live-config-tree-guard-hook.test.ts — behavior gate for the PreToolUse/Bash guard against
// git commands that switch the working tree of a LIVE ambient rules directory. Drives the
// REAL hook as a child process against isolated fixture paths, never the real ~/.claude.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-live-config-tree-guard-hook.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The REAL host environment this test runs in sets CLAUDE_CONFIG_DIR (this repo is itself
// worked on inside a Claude Code session) — and CLAUDE_CONFIG_DIR wins over the HOME-based
// `.claude*` heuristic. Every fixture must scrub it, or a fixture's HOME override is silently
// ignored and the hook resolves the REAL live rules directory instead of the fixture's.
function withoutRealConfigDir(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  delete clean.CLAUDE_CONFIG_DIR
  return clean
}

/** A fixture with `<home>/.claude/rules` present as a real git working tree (a `.git` dir). */
function gitFixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-live-tree-${tag}-`))
  roots.push(root)
  const home = join(root, 'home')
  const rulesDir = join(home, '.claude', 'rules')
  mkdirSync(join(rulesDir, '.git'), { recursive: true })
  return { root, home, rulesDir, env: withoutRealConfigDir({ ...process.env, HOME: home, USERPROFILE: home }) }
}

/** A fixture where `<home>/.claude/rules` exists but is NOT a git working tree. */
function nonGitFixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-live-tree-nogit-${tag}-`))
  roots.push(root)
  const home = join(root, 'home')
  const rulesDir = join(home, '.claude', 'rules')
  mkdirSync(rulesDir, { recursive: true })
  return { root, home, rulesDir, env: withoutRealConfigDir({ ...process.env, HOME: home, USERPROFILE: home }) }
}

function runHook(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  extraArgv: string[] = [],
  agentId?: string,
): { status: number | null; stdout: string; decision: string | null; systemMessage: string | null } {
  const res = spawnSync(process.execPath, [HOOK, ...extraArgv], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, ...(agentId ? { agent_id: agentId } : {}) }),
    encoding: 'utf8',
    env,
  })
  const stdout = (res.stdout ?? '').trim()
  let decision: string | null = null
  let systemMessage: string | null = null
  try {
    const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null
    const out = parsed?.['hookSpecificOutput'] as Record<string, unknown> | undefined
    decision = (out?.['permissionDecision'] as string | undefined) ?? null
    systemMessage = (parsed?.['systemMessage'] as string | undefined) ?? null
  } catch {
    /* leave both null */
  }
  return { status: res.status, stdout, decision, systemMessage }
}

function registerLiveWarningCases() {
  it('warns (does not deny) on a plain git switch to the live rules dir, by default', () => {
    const f = gitFixture('switch')
    const r = runHook(`git -C ${f.rulesDir} switch some-branch`, f.root, f.env)
    expect(r.decision).toBeNull()
    expect(r.systemMessage, 'must not be silent').toBeTruthy()
    expect(r.systemMessage).toContain('LIVE CONFIG TREE')
  })

  it('delivers the same warning to a subagent as additionalContext only', () => {
    const f = gitFixture('subagent-warn')
    const command = `git -C ${f.rulesDir} switch some-branch`
    const main = runHook(command, f.root, f.env)
    const r = runHook(command, f.root, f.env, [], 'a1')
    expect(r.status).toBe(0)
    expect(main.systemMessage).toContain('LIVE CONFIG TREE')
    expect(r.stdout).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: main.systemMessage } }))
  })

  it('catches the exact near-miss: cd into the live dir then reset --hard, split across &&', () => {
    const f = gitFixture('split-cd')
    const r = runHook(`cd ${f.rulesDir} && git reset --hard origin/main`, f.root, f.env)
    expect(r.systemMessage, 'must not be silent — this is the pattern that defeated the first draft').toBeTruthy()
  })

}

function registerLiveModeCases() {
  it('denies when WT_LIVE_CONFIG_TREE_GUARD_MODE=deny is set', () => {
    const f = gitFixture('deny-mode')
    const r = runHook(`git -C ${f.rulesDir} checkout other-branch`, f.root, {
      ...f.env,
      WT_LIVE_CONFIG_TREE_GUARD_MODE: 'deny',
    })
    expect(r.decision).toBe('deny')
  })

  it('still denies a subagent when deny mode is enabled', () => {
    const f = gitFixture('subagent-deny')
    const r = runHook(`git -C ${f.rulesDir} checkout other-branch`, f.root, {
      ...f.env,
      WT_LIVE_CONFIG_TREE_GUARD_MODE: 'deny',
    }, [], 'a1')
    expect(r.decision).toBe('deny')
  })

  it('is silenced entirely when WT_LIVE_CONFIG_TREE_GUARD_MODE=off is set', () => {
    const f = gitFixture('off-mode')
    const r = runHook(`git -C ${f.rulesDir} reset --hard`, f.root, {
      ...f.env,
      WT_LIVE_CONFIG_TREE_GUARD_MODE: 'off',
    })
    expect(r.stdout).toBe('')
  })

  it('honors an explicit CLAUDE_CONFIG_DIR for an arbitrarily-named config directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-live-tree-customdir-'))
    roots.push(root)
    const configDir = join(root, 'srv', 'claude-config')
    mkdirSync(join(configDir, 'rules', '.git'), { recursive: true })
    const r = runHook(`git -C ${join(configDir, 'rules')} checkout -b work`, root, {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
    })
    expect(r.systemMessage, 'must not be silent — CLAUDE_CONFIG_DIR names this as the rules root').toBeTruthy()
  })
}

describe('wt-live-config-tree-guard-hook — CATCHES the near-miss pattern (default warn posture)', () => {
  registerLiveWarningCases()
  registerLiveModeCases()
})

describe('wt-live-config-tree-guard-hook — does NOT block legitimate work', () => {
  it('never touches the recommended remedy: git worktree add', () => {
    const f = gitFixture('worktree-add')
    const r = runHook(`git -C ${f.rulesDir} worktree add ../elsewhere -b fix`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('never touches an ordinary commit', () => {
    const f = gitFixture('commit')
    const r = runHook(`git -C ${f.rulesDir} commit -m "edit a rule"`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('never touches git status', () => {
    const f = gitFixture('status')
    const r = runHook(`git -C ${f.rulesDir} status`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('never touches a pathspec checkout (`checkout -- <file>`), only a branch-shaped one', () => {
    const f = gitFixture('checkout-pathspec')
    const r = runHook(`git -C ${f.rulesDir} checkout -- some-rule.md`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('never touches a git command targeting an unrelated project worktree', () => {
    const f = gitFixture('other-dir')
    const otherDir = join(f.root, 'projects', 'my-repo')
    mkdirSync(otherDir, { recursive: true })
    const r = runHook(`git -C ${otherDir} switch feature-branch`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('is fully INERT when the resolved rules directory is not a git working tree', () => {
    const f = nonGitFixture('inert')
    const r = runHook(`git -C ${f.rulesDir} reset --hard`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('does not guess at an unresolvable target (a shell variable)', () => {
    const f = gitFixture('unresolvable')
    const r = runHook(`git -C "$RULES_DIR" checkout other`, f.root, f.env)
    expect(r.stdout).toBe('')
  })

  it('fails safe on malformed stdin', () => {
    const res = spawnSync(process.execPath, [HOOK], { input: '{not valid JSON', encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect((res.stdout ?? '').trim()).toBe('')
  })
})

describe('wt-live-config-tree-guard-hook — --diagnose is legible', () => {
  it('reports active:true and isGitRepo:true for a fixture with a live git rules dir', () => {
    const f = gitFixture('diag-active')
    const res = spawnSync(process.execPath, [HOOK, '--diagnose'], { encoding: 'utf8', env: f.env })
    const parsed = JSON.parse((res.stdout ?? '').trim())
    expect(parsed.isGitRepo).toBe(true)
    expect(parsed.active).toBe(true)
  })

  it('reports active:false and isGitRepo:false for a fixture with a non-git rules dir', () => {
    const f = nonGitFixture('diag-inert')
    const res = spawnSync(process.execPath, [HOOK, '--diagnose'], { encoding: 'utf8', env: f.env })
    const parsed = JSON.parse((res.stdout ?? '').trim())
    expect(parsed.isGitRepo).toBe(false)
    expect(parsed.active).toBe(false)
  })
})

// ---- Parity with the retired private guard -------------------------------------------------
// The private copy this one replaces carried a table of verdicts. Every row runs here under
// deny mode, against a fixture whose rules directory is a git working tree (this guard acts only
// on a git working tree), and must give the same verdict. Command strings are hook INPUT only:
// the only executable launched for a row is Node.

type Verdict = 'deny' | 'warn' | 'silent'
type Row = [string, string] | [string, string, Verdict]

const PARITY_HOME = mkdtempSync(join(tmpdir(), 'wt-live-tree-parity-'))
const home = PARITY_HOME
const live = join(home, '.claude', 'rules')
mkdirSync(join(live, '.git'), { recursive: true })
afterAll(() => rmSync(PARITY_HOME, { recursive: true, force: true }))

const PARITY_ROWS: { name: string; command: string; expected: Verdict; cwd: string }[] = []
function checkRows(prefix: string, rows: Row[], cwd: string = home): void {
  for (const [name, command, expected = 'deny'] of rows) {
    PARITY_ROWS.push({ name: `${prefix}: ${name}`, command, expected, cwd })
  }
}

function parityEnv(): NodeJS.ProcessEnv {
  return { ...withoutRealConfigDir(process.env), HOME: home, USERPROFILE: home, WT_LIVE_CONFIG_TREE_GUARD_MODE: 'deny' }
}

function parityVerdict(command: string, cwd: string, extra: Record<string, unknown> = {}, timeout = 10_000) {
  const started = performance.now()
  const res = spawnSync(process.execPath, [HOOK], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: parityEnv(),
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command }, ...extra }),
  })
  const ms = performance.now() - started
  const out = res.stdout ? (JSON.parse(res.stdout) as Record<string, unknown>) : {}
  const decision = (out['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['permissionDecision']
  const verdict: Verdict = res.stdout ? (typeof decision === 'string' ? (decision as Verdict) : 'warn') : 'silent'
  return { verdict, ms, status: res.status, out }
}

const git = `git -C ${live}`
const reset = `${git} reset --hard`
const large = `cat <<EOF\n${'$(:)'.repeat(130000)}\nEOF\ngit -C ~/.claude/rules reset --hard`
const exactLarge = large.padEnd(520063, ' ')
function nest(start: string, count = 9, prefix = 'echo '): string {
  let command = start
  for (let i = 0; i < count; i += 1) command = `${prefix}$(${command})`
  return command
}

checkRows('regression', [
  ['R1 eval', `eval '${reset}'`],
  ['R2 bash -c', `bash -c '${reset}'`],
  ['R2 env bash -c', `env bash -c '${reset}'`],
  ['R2 ANSI quoted bash -c', `bash -c $'${reset}'`],
  ['R2 sh stash', `sh -c 'git -C ${live} stash'`, 'warn'],
  ['R2 zsh -c', `zsh -c '${reset}'`],
  ['R3 shell heredoc', `bash <<EOF\n${reset}\nEOF`],
  ['R3 quoted shell heredoc', `bash <<'EOF'\n${reset}\nEOF`],
  ['R5 appended reset quotes', `git -C ${live} reset'' --hard`],
  ['R5 appended switch quotes', `git -C ${live} switch'' x`],
  ['R6 cd substitution', `cd "$(${reset}; printf /)"`],
  ['R7 literal quotes in expanding heredoc', `cat <<EOF\n'$(${reset})'\nEOF`],
  ['R8 nine nested substitutions', nest(reset, 9, '')],
  ['R9 bare process substitution', `<(${reset})`],
  ['R10 large heredoc', exactLarge],
  ['F1 subshell cwd isolation', `(cd ${live}); git reset --hard`, 'silent'],
  ['F2 echo is data', `echo ${reset}`],
  ['F3 unreachable branch retained', `false && ${reset}`],
  ['control env git', `env ${reset}`],
  ['control process substitution', `cat <(${reset})`],
  ['control bare switch', `${git} switch x`],
  ['control sed data', `sed -i "s#old#CMD='${git} switch x'#" file`],
  ['control quoted git subcommand', `git -C ${live} 'reset' --hard`, 'silent'],
  ['control quoted git and option', `'git' '-C' ${live} reset --hard`, 'silent'],
  ['R4 here-string followed by reset', `cat <<<'data'\n${reset}`],
])

checkRows('differential', [
  ['timeout', `timeout 30 ${git} checkout main`],
  ['absolute git', `/usr/bin/${git} checkout main`],
  ['setsid', `setsid ${reset}`],
  ['time', `time ${git} switch main`],
  ['command separator', 'command -- git reset --hard'],
  ['brace group', '{ git reset --hard; }'],
  ['else branch', 'if false; then :; else git reset --hard; fi'],
  ['multiline printf data', "printf %s 'note\ngit reset --hard\nend'"],
  ['echo data', 'echo git reset --hard'],
  ['bare control', `${git} switch main`],
  ['nice', `nice -n 5 ${reset}`],
  ['stdbuf', `stdbuf -oL ${reset}`],
  ['flock', `flock /tmp/example.lock ${reset}`],
  ['xargs', `xargs ${reset}`],
  ['env clean', `env -i ${reset}`],
  ['exec', `exec ${reset}`],
  ['negation', `! ${reset}`],
  ['until', `until ${reset}; do :; done`],
  ['while', `while ${reset}; do :; done`],
  ['case arm', `case x in x) ${reset};; esac`],
  ['and chain', `true && ${reset}`],
  ['or chain', `false || ${reset}`],
  ['dollar substitution', `echo $(${reset})`],
  ['backtick substitution', `echo \`${reset}\``],
  ['process substitution', `cat <(${reset})`],
  ['sudo options', `sudo -u nobody ${reset}`],
  ['unknown wrapper', `custom-runner ${reset}`],
  ['busybox', `busybox ${reset}`],
  ['ionice', `ionice -c 3 ${reset}`],
  ['assignment', `MODE=x ${reset}`],
  ['nohup', `nohup ${reset}`],
  ['elif', `if false; then :; elif ${reset}; then :; fi`],
  ['function body', `f() { ${reset}; }; f`],
  ['quoted command pieces', `g''it -C ${live} re''set --hard`, 'silent'],
  ['quoted sed data', `sed -i "s#old#CMD='${git} switch x'#" file`],
  ['grep data', `grep '${reset}' file`],
  ['awk retains base', `awk 'BEGIN { print "${reset}" }'`],
  ['tee quoted argument', `tee '${reset}'`],
  ['quoted nonshell heredoc', `tee <<'EOF'\n${reset}\nEOF`],
  ['unknown heredoc consumer retains base', `custom-reader <<'EOF'\n${reset}\nEOF`],
  ['wrapped shell heredoc retains base', `timeout 30 bash <<'EOF'\n${reset}\nEOF`],
  ['data followed by unknown wrapper', `echo '${reset}'; custom-runner ${reset}`],
  ['unknown quoted argument retains base', `custom-runner '${reset}'`],
  ['git text in unknown git arguments retains base', `git log '${reset}'`],
  ['glob-shaped subcommand retains base', `git reset? --hard`],
  ['substitution-suffixed subcommand retains base', `git reset$(printf '') --hard`],
  ['base cwd inside subshell retained', `cd ${live}; (cd /elsewhere; git reset --hard); git status`],
  ['base cwd inside data-command substitution retained', `echo $(cd /elsewhere; git reset --hard)`],
  ['global config option before reset', 'git -c color.ui=false reset --hard'],
  ['repeated directory resolves to the last absolute one', `git -C /elsewhere -C ${live} reset --hard`],
], live)

checkRows('round 4', [
  ['sed execute command', `sed 'e ${reset}' file`],
  ['sed execute substitution flag', `sed 's#old#${reset}#e' file`],
  ['awk system', `awk 'BEGIN { system("${reset}") }'`],
  ...['bash', 'sh', 'zsh'].map((shell): Row =>
    [`cat heredoc piped to ${shell}`, `cat <<'EOF' | ${shell}\n${reset}\nEOF`]),
  ...['.', 'source'].map((source): Row =>
    [`tee heredoc then ${source}`, `tee payload <<'EOF'; ${source} payload\n${reset}\nEOF`]),
  ...['true', ':', 'false'].map((builtin): Row =>
    [`ignored stdin ${builtin}`, `${builtin} <<'EOF'\n${reset}\nEOF`]),
  ['sed control', `sed -i "s#old#CMD='${git} switch x'#" file`],
  ['plain printf control', `printf '%s' '${reset}'`],
  ['grep control', `grep '${reset}' file`],
  ['cat unsourced file control', `cat <<'EOF' > payload\n${reset}\nEOF`],
  ['printf piped to shell', `printf '%s' '${reset}' | bash`],
  ['printf output process substitution shell', `printf '%s' '${reset}' > >(bash)`],
  ['printf output process substitution eval', `printf '%s' '${reset}' > >(eval)`],
  ['printf piped unsafe sed', `printf '%s' '${reset}' | sed e`],
  ['printf piped awk system input', `printf '%s' '${reset}' | awk '{ system($0) }'`],
  ['substitution supplying executable', `$(printf '%s' '${reset}')`],
  ['quoted shell executable pipe', `echo '${reset}' | '/bin/bash'`],
  ['echo piped to eval', `echo '${reset}' | eval`],
  ['printf redirected then sourced', `printf '%s' '${reset}' > payload; . payload`],
  ['cat process substitution shell', `bash <(cat <<'EOF'\n${reset}\nEOF\n)`],
  ['cat output substitution eval', `eval "$(cat <<'EOF'\n${reset}\nEOF\n)"`],
  ['cat redirection then source after document', `cat > payload <<'EOF'\n${reset}\nEOF\nsource payload`],
  ['tee argument then source', `tee '${reset}'; source payload`],
  ['sed write substitution flag', `sed 's#old#${reset}#w payload' file`],
  ['sed read command', `sed 'r ${reset}' file`],
  ['sed write command', `sed 'w ${reset}' file`],
  ['sed multiple safe substitutions', `sed -e 's#old#${reset}#g; s#x#y#' file`],
  ['sed separate scripts unsafe', `sed -e 's#x#y#' -e 'e ${reset}' file`],
  ['sed script file conservative', `sed -f script '${reset}'`],
], live)

// These lexical limitations are inherited from the base, without a new parser or exemption.
checkRows('lexical limits', [
  ['depth quote removal', nest(`git -C ${live} re''set --hard`), 'silent'],
  ['ANSI hexadecimal escape', `bash -c $'git -C ${live} \\x72eset --hard'`, 'silent'],
  ['ANSI hexadecimal hard flag', `bash -c $'git reset --ha\\x72d'`, 'silent'],
  ['ANSI octal escape', `bash -c $'git -C ${live} \\162eset --hard'`, 'silent'],
  ['ANSI Unicode escape', `bash -c $'git -C ${live} \\u0072eset --hard'`, 'silent'],
  ['ANSI wide Unicode escape', `bash -c $'git -C ${live} \\U00000072eset --hard'`, 'silent'],
  ['multiline quoted fake heredoc', `printf %s 'note\nbash <<EOF\n${reset}\nEOF\nend'`],
  ['shell noexec heredoc', `bash -n <<'EOF'\n${reset}\nEOF`],
  ['shell command ignores stdin heredoc', `bash -c 'printf ok' <<'EOF'\n${reset}\nEOF`],
  ['here-string preserves following mutation', `cat <<<'data'\n${reset}`],
  ['nine nested data', nest(`echo '${reset}'`)],
  ['shell script containing only data', `bash -c 'echo "${reset}"'`],
  ['eval script containing only data', `eval 'echo "${reset}"'`],
  ['shell script unknown wrapper', `bash -c 'unfamiliar ${reset}'`],
  ['nested quotes before comment-looking prose', `echo "$(printf " #"; ${reset})"`],
  ['deep boundary remains conservative', nest(reset, 40)],
  ['deep boundary quote removal', nest(`git -C ${live} re''set --hard`, 40), 'silent'],
  ['unknown wrapper after cd', `cd ${live}; unfamiliar git reset --hard`],
], live)

checkRows('former data exemption', [
  ['reported double-quoted sed argument', `sed -i "s#old#CMD='${git} switch x'#" file`],
  ['single-quoted argument', `printf '%s' '${git} switch x'`],
  ['double-quoted argument with separators', `printf '%s' "note; ${git} switch x && done"`],
  ['single-quoted argument with double quotes', `printf '%s' 'note; git -C "${live}" switch x'`],
  ['escaped quotes inside double quotes', `printf '%s' "note; git -C \"${live}\" switch x"`],
  ['multiline quoted data', `printf '%s' "note\n${reset}\nend"`],
  ['quoted heredoc', `cat <<'TEXT'\n${git} switch x\nTEXT`],
  ['double-quoted heredoc', `cat <<"TEXT"\n${git} checkout x\nTEXT`],
  ['unquoted heredoc prose', `cat <<TEXT\n${reset}\nTEXT`],
  ['tab-stripped heredoc', `cat <<-'TEXT'\n\t${git} switch x\n\tTEXT`],
  ['unterminated heredoc', `cat <<'TEXT'\n${git} switch x`],
  ['multiple heredocs', `cat <<FIRST <<'SECOND'\n${git} switch x\nFIRST\n${reset}\nSECOND`],
  ['heredoc cd is data', `cat <<'TEXT'\ncd ${live}\nTEXT\ngit switch x`],
  ['comment', `true # ${git} switch x`],
  ['quoted warning text', `printf '%s' '${git} merge main'`, 'warn'],
  ['quoted heredoc substitution is literal', `cat <<'TEXT'\n$(${git} switch x)\nTEXT`],
  ['quoted heredoc marker is data', `printf '%s' '<<TEXT'\nprintf '%s' '${git} switch x'`],
  ['nested cd stays in substitution', `printf '%s' "$(cd ${live})"; git switch x`, 'silent'],
  ['quoted reset prose is data', `${git} reset --soft 'description mentions --hard here'`],
])

checkRows('executable command', [
  ['cd and switch', `cd ${live} && git switch x`],
  ['quoted cd and reset', `cd "${live}"; git reset --hard`],
  ['single-quoted cd and checkout', `cd '${live}'\ngit checkout x`],
  ['data then switch', `printf '%s' 'safe; git -C /elsewhere switch x'; ${git} switch x`],
  ['heredoc then switch', `cat <<'TEXT'\nsafe prose\nTEXT\n${git} switch x`],
  ['switch before heredoc', `cat <<'TEXT'; ${git} switch x\nsafe prose\nTEXT`],
  ['deny beats warn', `${git} merge main; ${git} switch x`],
  ['quoted path with spaces', `git -C "${join(home, '.claude shared', 'rules')}" switch x`, 'silent'],
  ['quoted substitution', `printf '%s' "$(${git} switch x)"`],
  ['unquoted substitution', `printf '%s' $(${git} switch x)`],
  ['backtick substitution', `printf '%s' \`${git} switch x\``],
  ['heredoc substitution', `cat <<TEXT\n$(${git} switch x)\nTEXT`],
  ['heredoc backticks', `cat <<TEXT\n\`${git} switch x\`\nTEXT`],
  ['cd then heredoc substitution', `cd ${live}; cat <<TEXT\n$(git switch x)\nTEXT`],
  ['substitution cd', `printf '%s' "$(cd ${live}; git switch x)"`, 'silent'],
  ['single-quoted hard flag', `${git} reset '--hard'`],
  ['double-quoted hard flag', `${git} reset "--hard"`],
])

// git's global options never hide the subcommand, `-C` chains resolve as git resolves them, and
// an option-led checkout that moves HEAD is a checkout.
checkRows('global options', [
  ['-c then -C then switch', `git -c core.quotePath=false -C ${live} switch main`],
  ['--no-pager before reset', `git --no-pager -C ${live} reset --hard`],
  ['-C chain relative to the one before', `git -C ${home} -C .claude/rules reset --hard`],
  ['-C chain leaving the live tree', `git -C ${live} -C ../../other reset --hard`, 'silent'],
  ['--git-dir and --work-tree name the live tree', `git --git-dir=${live}/.git --work-tree=${live} checkout main`],
  ['separate-word --work-tree and --git-dir', `git --work-tree ${live} --git-dir ${live}/.git reset --hard`],
  ['--git-dir with a read-only subcommand', `git --git-dir ${live}/.git status`, 'silent'],
  ['checkout --detach', `git -C ${live} checkout --detach main`],
  ['checkout -f with a ref', `git -C ${live} checkout -f main`],
  ['checkout -q with a ref', `git -C ${live} checkout -q main`],
  ['checkout -f alone discards the tree', `git -C ${live} checkout -f`],
  ['checkout -p restores paths only', `git -C ${live} checkout -p`, 'silent'],
], '/')

function nestShell(script: string, levels: number): string {
  let command = script
  for (let i = 0; i < levels; i += 1) command = `bash -c ${JSON.stringify(command)}`
  return command
}

// A shell `-c` script is walked as a command of its own, with its own `cd`s, from the cwd its
// outer chain reached, three levels deep. A `cd` inside the script never moves the outer chain.
checkRows('shell script cwd', [
  ['cd inside bash -c', `bash -c 'cd ${live} && git reset --hard'`],
  ['cd inside sh -c with a semicolon', `sh -c 'cd ${live}; git switch x'`],
  ['relative cd inside the script from the outer cwd', `cd ${home} && bash -c 'cd .claude/rules && git reset --hard'`],
  ['warn-class subcommand inside the script', `bash -c 'cd ${live} && git merge x'`, 'warn'],
  ['a cd inside the script does not move the outer chain', `bash -c 'cd ${live}'; git reset --hard`, 'silent'],
  ['a shell word that is only an argument', `echo bash -c 'cd ${live} && git reset --hard'`, 'silent'],
  ['three nested scripts', nestShell(`cd ${live} && git reset --hard`, 3)],
  ['a fourth level is past the depth bound', nestShell(`cd ${live} && git reset --hard`, 4), 'silent'],
], '/')

for (const target of [live, '~/.claude/rules', `'${live}'`, `"${live}"`]) {
  checkRows(`target ${target}`, ['switch x', 'checkout x', 'checkout -b x', 'reset --hard']
    .map((operation): Row => [operation, `git -C ${target} ${operation}`]))
}


describe('wt-live-config-tree-guard-hook — verdict parity with the retired private guard (deny mode)', () => {
  it('has the whole row table loaded', () => {
    expect(PARITY_ROWS.length).toBeGreaterThan(170)
  })

  for (const row of PARITY_ROWS) {
    it(row.name, () => {
      const r = parityVerdict(row.command, row.cwd)
      expect(r.status).toBe(0)
      expect(r.verdict).toBe(row.expected)
    })
  }
})

const repeatedGit = (count: number) => `printf '%s' '${'git '.repeat(count)}switch main'`
const TIMING_ROWS: [string, string, Verdict, string][] = [
  ['git, 50000 spaces and reset --hard', `git${' '.repeat(50_000)}reset --hard`, 'deny', live],
  ['a 30-space redirect target after reset --hard', `git reset --hard > '${' '.repeat(30)}'`, 'deny', live],
  ['a 100000-space redirect target after reset --hard', `git reset --hard > '${' '.repeat(100_000)}'`, 'deny', live],
  // Outside the live tree the verdict is found and the target is then extracted and rejected:
  // the whitespace run is read by target extraction, not skipped before it.
  ['git, 50000 spaces and reset --hard outside the live tree', `git${' '.repeat(50_000)}reset --hard`, 'silent', home],
  ['32000 repeated git words (128 KB)', repeatedGit(32_000), 'deny', live],
  ['64000 repeated git words (256 KB)', repeatedGit(64_000), 'deny', live],
  // A segment-wide check run once per git word turns quadratic when no word hits the live tree.
  ['17000 repeated checkouts outside the live tree (256 KB)', 'git checkout x '.repeat(17_000), 'silent', home],
]

describe('wt-live-config-tree-guard-hook — detection is linear in the command length', () => {
  for (const [name, command, expected, cwd] of TIMING_ROWS) {
    it(`${name} finishes within 1 s with the verdict ${expected}`, () => {
      const r = parityVerdict(command, cwd, {}, 5_000)
      expect(r.status, 'hook must finish, not time out').toBe(0)
      expect(r.verdict).toBe(expected)
      expect(r.ms).toBeLessThan(1_000)
    })
  }
})

describe('wt-live-config-tree-guard-hook — the refusal text routes DATA to Edit or Write', () => {
  const DENY = `sed -i "s#old#CMD='git -C ${live} switch x'#" file`

  it('the deny reason tells the reader to write git-as-data with the Edit or Write tool', () => {
    const r = parityVerdict(DENY, home)
    expect(r.verdict).toBe('deny')
    const reason = String((r.out['hookSpecificOutput'] as Record<string, unknown>)['permissionDecisionReason'])
    expect(reason).toContain('If the git text is DATA')
    expect(reason).toContain('Edit or Write tool')
    expect(reason).toContain('only reads Bash commands')
  })

  it('the warning text carries the same guidance', () => {
    const f = gitFixture('data-warn')
    const r = runHook(`git -C ${f.rulesDir} switch some-branch`, f.root, f.env)
    expect(r.systemMessage).toContain('Edit or Write tool')
  })
})

describe('wt-live-config-tree-guard-hook — a subagent refusal under deny mode', () => {
  it('a subagent payload (agent_id set) for a deny-class command still gets permissionDecision deny', () => {
    const r = parityVerdict(`git -C ${live} checkout other`, home, { agent_id: 'worker' })
    expect(r.verdict).toBe('deny')
  })

  it('a subagent warn-class command gets context only, never a decision', () => {
    const r = parityVerdict(`git -C ${live} merge main`, home, { agent_id: 'worker' })
    expect(r.verdict).toBe('warn')
    expect(JSON.stringify(r.out)).not.toContain('permissionDecision')
  })
})

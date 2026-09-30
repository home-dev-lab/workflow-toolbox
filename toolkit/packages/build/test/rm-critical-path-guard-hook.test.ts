import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-rm-critical-path-guard-hook.mjs')
const CORE = join(REPO_ROOT, 'plugin/bin/lib/rm-critical-path-core.mjs')
const { describeRemedy, scanRmCriticalPath } = await import(pathToFileURL(CORE).href) as {
  describeRemedy: (command: string, hits: unknown[]) => { rewritten: string | null; lines: string[] }
  scanRmCriticalPath: (command: string, context: { cwd: string; home?: string }) => unknown[]
}
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const JOURNAL_DIR = mkdtempSync(join(tmpdir(), 'rm-critical-path-journal-'))

interface RunOptions {
  event?: 'PreToolUse' | 'PermissionRequest'
  agentId?: string
  permissionMode?: string
  env?: Record<string, string>
  cwd?: string
  rawCwd?: unknown
}

function run(command: string, opts: RunOptions = {}) {
  const payload: Record<string, unknown> = {
    hook_event_name: opts.event ?? 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: 'rawCwd' in opts ? opts.rawCwd : (opts.cwd ?? '/work/project'),
    session_id: 'test-session',
  }
  if (opts.agentId) payload.agent_id = opts.agentId
  if (opts.permissionMode) payload.permission_mode = opts.permissionMode
  // A clean environment: whether a variable "may be unset" is read from the inherited environment,
  // so the machine running the suite must not decide a verdict.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: '/home/tester',
    WT_GUARD_JOURNAL_DIR: JOURNAL_DIR,
    ...opts.env,
  }
  const res = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env })
  const out = res.stdout.trim() === '' ? null : JSON.parse(res.stdout)
  const hso = out?.hookSpecificOutput
  return {
    status: res.status,
    stderr: res.stderr,
    out,
    denied: hso?.permissionDecision === 'deny' || hso?.decision?.behavior === 'deny',
    reason: String(hso?.permissionDecisionReason ?? hso?.decision?.message ?? hso?.additionalContext ?? ''),
  }
}

function rewrite(command: string) {
  const result = describeRemedy(command, scanRmCriticalPath(command, { cwd: '/work/project', home: '/home/tester' })).rewritten
  if (result !== null) expect(spawnSync('bash', ['-n'], { input: result, encoding: 'utf8' }).status).toBe(0)
  return result
}

describe('review regression locks — rewrite', () => {
  it('F1 declines nested defaults, escapes, single quotes and second expansions', () => {
    for (const target of ['${D:-${E}}/*.log', '"${D:-${E}}"/*.log', '${D-foo}/*.log', "'$D'/*.log", '$D/$X', '$D/\\*.log']) {
      expect(rewrite(`rm -f ${target}`)).toBeNull()
    }
  })

  it('F2 changes only the operand offset, not printf or heredoc data', () => {
    expect(rewrite("printf '%s\\n' '$D/*.log'; rm -f $D/*.log"))
      .toBe("printf '%s\\n' '$D/*.log'; rm -f \"${D:?}\"/*.log")
    // A command carrying a heredoc gets per-target advice but no full rewrite: a delimiter the
    // parser misreads would put the edit inside the written data (round-2 review, case A).
    const command = "cat <<'EOF'\n$D/*.log\nEOF\nrm -f $D/*.log"
    expect(rewrite(command)).toBeNull()
  })

  it('R2-A offers no full rewrite when the command carries a heredoc or a parameter expansion', () => {
    expect(rewrite("cat <<'END TEXT'\nEND\nrm -f $D/*.log\nEND TEXT")).toBeNull()
    expect(rewrite('printf "%s\\n" ${X:-; rm -f $D/*.log;}')).toBeNull()
    const hits = scanRmCriticalPath("cat <<'EOF'\nx\nEOF\nrm -f $D/*.log", { cwd: '/work/project', home: '/home/tester' })
    expect(describeRemedy("cat <<'EOF'\nx\nEOF\nrm -f $D/*.log", hits).lines.join('\n')).toContain('"${D:?}"/*.log')
    // an ordinary command keeps its paste-ready rewrite, braced target included
    expect(rewrite('rm -f ${D}/*.log')).toBe('rm -f "${D:?}"/*.log')
  })

  it('F3 balances fully quoted and concatenated quotes and shell-validates every rewrite', () => {
    expect(rewrite('rm -rf "$D/"')).toBe('rm -rf "${D:?}/"')
    expect(rewrite('rm -f "$D"/*.log')).toBe('rm -f "${D:?}"/*.log')
    expect(rewrite('rm -f "${D}/*.log"')).toBe('rm -f "${D:?}/*.log"')
    expect(rewrite('rm -f ${D}/*.log')).toBe('rm -f "${D:?}"/*.log')
  })
  it('F1 keeps nested removals advice-only rather than rewriting the enclosing word', () => {
    expect(rewrite('echo $(rm -f $D/*.log)')).toBeNull()
    expect(rewrite('bash -c "rm -f $D/*.log"')).toBeNull()
    expect(rewrite("trap 'rm -f $D/*.log' EXIT")).toBeNull()
  })
})

describe('review regression locks — parser', () => {
  it('F4 recognizes heredocs only outside quotes/comments, with complete delimiters', () => {
    for (const cmd of ['# <<EOF\nrm -f $UNSET/*.log', ': "<<EOF"\nrm -f $UNSET/*.log', 'cat <<EOF-X\nhello\nEOF-X\nrm -f $UNSET/*.log']) {
      expect(run(cmd).denied).toBe(true)
    }
  })
  it('F5 treats quoted heredocs and exact terminators as inert, scans expanding substitutions', () => {
    expect(run("cat <<'123'\nrm -rf /\n123").denied).toBe(false)
    expect(run("cat <<'EOF'\n EOF\nrm -rf /\nEOF").denied).toBe(false)
    expect(run('cat <<EOF\n$(rm -rf /)\nEOF').denied).toBe(true)
  })
  it('F6 does not strip braces from target words', () => {
    expect(run('M=$(pwd); rm -rf ${M:?}').denied).toBe(true)
    expect(run('rm -rf /work/project}').denied).toBe(false)
  })
  it('F7 recognizes fd redirects and attached output redirects', () => {
    expect(run('2>&1 rm -rf /work/project').denied).toBe(true)
    expect(run('rm -rf /work/project>out').denied).toBe(true)
  })
  it('F8 removes quotes and escapes and joins continued lines', () => {
    for (const cmd of ["rm -rf '/work'/'project'", 'rm -rf /work/proj\\ect', "rm -rf ''$UNSET/*", 'rm -rf \\\n$UNSET/*.log']) {
      expect(run(cmd).denied).toBe(true)
    }
  })
  it('F9 skips escaped backticks and scans eight nested substitutions', () => {
    expect(run('echo `printf "\\`"; rm -rf /`').denied).toBe(true)
    expect(run('echo $(echo $(echo $(echo $(rm -rf /))))').denied).toBe(true)
  })
  it('F10 tracks declarations after options and bare names', () => {
    expect(run('export -n M=$(pwd); rm -rf "$M"').denied).toBe(true)
    expect(run('export A M=$(pwd); rm -rf "$M"').denied).toBe(true)
    expect(run('export -n X=/tmp/safe; rm -rf $X/usr').denied).toBe(false)
  })
  it('F11 confines subshell and conditional assignments and inherits nested variables', () => {
    expect(run('(X=/tmp/foo); rm -rf $X/usr').denied).toBe(true)
    expect(run('D=/tmp/foo; echo $(rm -rf $D/usr)').denied).toBe(false)
    expect(run('false || X=/tmp/foo; rm -rf $X/usr').denied).toBe(true)
    expect(run('false && X=/tmp/foo; rm -rf $X/usr').denied).toBe(false)
  })
  it('F12 ignores empty targets and does not expand quoted tilde', () => {
    expect(run("rm -f ''").denied).toBe(false)
    expect(run("rm -rf '~'").denied).toBe(false)
    expect(run('rm -rf ~').denied).toBe(true)
  })
  it('W1 reads a Windows-form home and working directory the way Git Bash spells them', () => {
    // On win32 the hook receives `C:\...` from os.homedir() and the payload cwd, while the Bash
    // commands it judges spell the same directories `/c/...`.
    const ctx = { cwd: 'C:\\work\\project', home: 'C:\\Users\\tester' }
    expect(scanRmCriticalPath('rm -rf ~', ctx)).not.toEqual([])
    expect(scanRmCriticalPath('rm -rf /c/Users/tester', ctx)).not.toEqual([])
    expect(scanRmCriticalPath('rm -rf .', ctx)).not.toEqual([])
    expect(scanRmCriticalPath('rm -rf ..', ctx)).not.toEqual([])
    expect(scanRmCriticalPath('rm -rf build', ctx)).toEqual([])
    expect(scanRmCriticalPath('rm -rf /c/work/project/build', ctx)).toEqual([])
    expect(scanRmCriticalPath('rm -rf ~/scratch', ctx)).toEqual([])
  })
  it('W2 treats a bare tilde as the home directory even when the home path is unknown', () => {
    expect(scanRmCriticalPath('rm -rf ~', { cwd: '/work/project' })).not.toEqual([])
    expect(scanRmCriticalPath('rm -rf ~/', { cwd: '/work/project' })).not.toEqual([])
    expect(scanRmCriticalPath('rm -rf ~/scratch', { cwd: '/work/project' })).toEqual([])
  })
  it('F13 judges the working directory at call time and reads built-in critical variables', () => {
    // The check compares literal targets with the directory the Bash call starts in; a `cd` inside
    // the command does not move it (replay of real sessions: six `cd X … rm -rf X` commands, no prompt).
    expect(run('cd /tmp/p && rm -rf /tmp/p').denied).toBe(false)
    expect(run('cd /tmp/p && rm -rf /work/project').denied).toBe(true)
    expect(run('rm -rf "$PWD"').denied).toBe(true)
    expect(run('rm -rf "$HOME"').denied).toBe(true)
    expect(run('cd "$UNKNOWN" && rm -rf /tmp').denied).toBe(true)
  })
  it('R2-C reads an empty single-quoted assignment as empty', () => {
    expect(run("X=''; rm -rf $X/usr").denied).toBe(true)
    expect(run("X='/tmp/safe'; rm -rf $X/usr").denied).toBe(false)
  })
  it('R2-F keeps a derived variable critical behind a guard followed by more path', () => {
    expect(run('M=$(pwd); rm -rf "${M:?}"/*.log').denied).toBe(true)
    expect(run('M=/tmp/safe; rm -rf "${M:?}"/*.log').denied).toBe(false)
  })
  it('F14a treats single-quoted assignment as literal', () => {
    expect(run("M='$PWD'; rm -rf \"$M\"").denied).toBe(false)
  })
  it('F15 advises changing directories before removing the current directory', () => {
    expect(run('M=$(pwd); rm -rf "$M"').reason).toContain('change to its parent directory first')
  })
  it('F16 skips wrapper option operands', () => {
    expect(run('sudo -u root rm -rf /').denied).toBe(true)
    expect(run('timeout 5 rm -rf /').denied).toBe(true)
    expect(run('xargs -0 rm -rf').denied).toBe(false)
  })
  it('F17 scans a large glob in linear time', () => {
    const start = performance.now()
    scanRmCriticalPath(`rm -f /${'*'.repeat(80000)}/file`, { cwd: '/work/project' })
    expect(performance.now() - start).toBeLessThan(200)
  })
  it('F18 scans trap strings but ignores incidental rm text on PermissionRequest', () => {
    expect(run("trap 'rm -f $X/*.log' EXIT").denied).toBe(true)
    expect(run("trap 'rm -f $X/*.log' EXIT", { event: 'PermissionRequest', permissionMode: 'bypassPermissions' }).denied).toBe(true)
    expect(run('printf "%s\\n" "rm -rf /"', { event: 'PermissionRequest', permissionMode: 'bypassPermissions' }).out).toBeNull()
  })
  it('F19 defaults malformed cwd without failing open', () => {
    const r = run('rm -rf /tmp', { rawCwd: 42 })
    expect(r.denied).toBe(true)
    expect(r.stderr).not.toContain('FAILED OPEN')
    const relative = run('rm -rf ..', { rawCwd: 42 })
    expect(relative.denied).toBe(true)
    expect(relative.stderr).not.toContain('FAILED OPEN')
  })
})

describe('wt-rm-critical-path-guard-hook — PreToolUse', () => {
  it('denies a glob under a variable for a SUB-AGENT and hands back the guarded command', () => {
    const cmd = 'W=/abs/wt; G=$W/.lane/gates; rm -f $G/*.log $G/done; git -C $W diff'
    const r = run(cmd, { agentId: 'a0123' })
    expect(r.status).toBe(0)
    expect(r.denied).toBe(true)
    expect(r.reason).toContain('W=/abs/wt; G=$W/.lane/gates; rm -f "${G:?}"/*.log $G/done; git -C $W diff')
  })

  it('lets the guarded form through', () => {
    expect(run('rm -f "${G:?}"/*.log', { agentId: 'a0123' }).denied).toBe(false)
  })

  it('denies a trailing slash and a second variable directly under a variable', () => {
    expect(run('rm -rf "$D"/').denied).toBe(true)
    expect(run('M=/abs/m; rm -rf $M/$m/.git').denied).toBe(true)
  })

  it('denies $VAR/<top-level name> when VAR is neither assigned in the command nor in the environment', () => {
    const r = run('rm -rf $S/usr; echo done')
    expect(r.denied).toBe(true)
    expect(r.reason).toContain('rm -rf "${S:?}"/usr; echo done')
    // a name that is not a known top-level directory is not a critical path for the harness
    expect(run('rm -rf $S/mut').denied).toBe(false)
  })

  it('lets $VAR/name through when VAR is set in the inherited environment or assigned in the command', () => {
    expect(run('rm -rf $S/usr', { env: { S: '/tmp/s' } }).denied).toBe(false)
    expect(run('S=/tmp/s; rm -rf $S/usr').denied).toBe(false)
  })

  it('denies a variable derived from the working directory and asks for a literal path, not a guard', () => {
    const r = run('M=$(pwd); rm -rf "${M:?}"')
    expect(r.denied).toBe(true)
    expect(r.reason).toContain('literal absolute path')
    expect(r.reason).not.toContain('Run this instead')
    expect(run('R=$(git rev-parse --show-toplevel); rm -rf $R').denied).toBe(true)
  })

  it('denies literal critical paths and passes ordinary literal paths', () => {
    expect(run('rm -rf /tmp').denied).toBe(true)
    expect(run('rm -rf ~').denied).toBe(true)
    expect(run('rm -rf ..', { cwd: '/work/project' }).denied).toBe(true)
    expect(run('rm -rf /tmp/abc/def').denied).toBe(false)
    expect(run('rm -f /work/project/build/out.log').denied).toBe(false)
  })

  it('does not fire on rm that is not a command, or on a temporary directory from mktemp', () => {
    expect(run('git rm -r $X/*').denied).toBe(false)
    expect(run('grep "rm -rf $x/*" file').denied).toBe(false)
    expect(run("git commit -F - <<'EOF'\nrm -rf $X/*\nEOF").denied).toBe(false)
    expect(run('T=$(mktemp -d); rm -rf "$T"').denied).toBe(false)
    expect(run('D=/tmp/x; rm -rf $D').denied).toBe(false)
  })

  it('reads nested scripts: command substitution and bash -c', () => {
    expect(run('echo $(rm -rf $Q/*)').denied).toBe(true)
    const r = run('bash -c "rm -rf $Q/*"')
    expect(r.denied).toBe(true)
    expect(r.reason).toContain('parses a second time')
  })

  it('only warns when switched to warn mode', () => {
    const r = run('rm -f $G/*.log', { env: { WT_RM_CRITICAL_PATH_GUARD: 'warn' } })
    expect(r.denied).toBe(false)
    expect(r.out?.hookSpecificOutput?.additionalContext).toContain('"${G:?}"/*.log')
  })
})

describe('wt-rm-critical-path-guard-hook — PermissionRequest backstop', () => {
  it('answers a bypass-mode rm prompt with a refusal, even when the prediction saw nothing', () => {
    const r = run('eval "rm -f \\$X/*.log"', { event: 'PermissionRequest', permissionMode: 'bypassPermissions', agentId: 'a1' })
    expect(r.denied).toBe(true)
    expect(r.out.hookSpecificOutput.hookEventName).toBe('PermissionRequest')
    expect(r.reason).toContain('literal absolute path')
    // nothing to rewrite mechanically: the refusal must not hand back the same command as a fix
    expect(r.reason).not.toContain('Run this instead')
  })

  it('R2-J leaves a prompt alone when every rm target is a plain literal path', () => {
    // Only a non-literal target (variable, glob, substitution) can be what the critical-path check
    // stopped on; a prompt on this command was raised for something else.
    const bypass = { event: 'PermissionRequest' as const, permissionMode: 'bypassPermissions' }
    expect(run('curl https://example.com/data; rm -f /tmp/build.log', bypass).out).toBeNull()
    expect(run('curl https://example.com/data; rm -f $T', bypass).denied).toBe(true)
  })

  it('stays out of the way outside bypassPermissions and for commands without rm', () => {
    expect(run('rm -f $G/*.log', { event: 'PermissionRequest', permissionMode: 'default' }).out).toBeNull()
    expect(run('curl http://x', { event: 'PermissionRequest', permissionMode: 'bypassPermissions' }).out).toBeNull()
  })
})

describe('wt-rm-critical-path-guard-hook — registration', () => {
  it('is registered on PreToolUse and PermissionRequest for Bash', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    for (const event of ['PreToolUse', 'PermissionRequest']) {
      const commands = (manifest.hooks[event] ?? [])
        .filter((b: { matcher?: string }) => b.matcher === 'Bash')
        .flatMap((b: { hooks: { command: string }[] }) => b.hooks.map((h) => h.command))
      expect(commands.some((c: string) => c.includes('wt-rm-critical-path-guard-hook.mjs'))).toBe(true)
    }
  })
})

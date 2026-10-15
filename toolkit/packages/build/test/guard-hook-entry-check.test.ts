// guard-hook-entry-check.test.ts — a PreToolUse or PermissionRequest entry the host cannot use must never ship.
//
// Measured on Claude Code 2.1.289 in disposable headless sessions, each entry beside a valid sibling hook:
// - ONE PreToolUse entry the host cannot load (no `command`, an unknown `type`, an http hook without `url`, a
//   `timeout` that is a string or 0, a non-boolean `async`) makes the host drop the WHOLE source it sits in: every
//   hook and every permission rule of that settings file, or the whole plugin. The tool call then runs unguarded,
//   and the print-mode session we probed reported nothing.
// - A matcher on the regular-expression path that does not compile (`Bash(`) skips that matcher group, and an `if`
//   that is not a permission rule skips that one hook. `claude plugin validate --strict` reports the first class and
//   passes the second, so the host-validator test (plugin-host-validate.test.ts) cannot see it.
// This check runs offline, so the cross-os CI covers both classes too. It is not the host's schema.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { guardHookEntryProblems } from '../../../../plugin/bin/lib/guard-hook-entry-check.mjs'

type Problem = { path: string; problem: string }
const check = guardHookEntryProblems as (config: unknown) => Problem[]

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

const pre = (group: Record<string, unknown>) => ({ hooks: { PreToolUse: [group] } })
const ok = { type: 'command', command: 'node guard.mjs' }

describe('guardHookEntryProblems — each measured failure shape is flagged', () => {
  it('flags a command hook with no command (measured: the whole source is dropped)', () => {
    expect(check(pre({ matcher: 'Bash', hooks: [{ type: 'command' }] }))).toEqual([
      { path: 'hooks.PreToolUse.0.hooks.0', problem: 'a command hook needs a string `command`' },
    ])
  })

  it('flags a timeout written as a string (measured: the whole source is dropped)', () => {
    expect(check(pre({ matcher: 'Bash', hooks: [{ ...ok, timeout: '5' }] }))).toEqual([
      { path: 'hooks.PreToolUse.0.hooks.0', problem: '`timeout` must be a positive number of seconds; received string' },
    ])
  })

  it('flags a regular-expression matcher that does not compile (measured: the group is skipped silently)', () => {
    const problems = check({ hooks: { PermissionRequest: [{ matcher: 'Bash(', hooks: [ok] }] } })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.path).toBe('hooks.PermissionRequest.0.matcher')
    expect(problems[0]?.problem).toMatch(/^matcher "Bash\(" is a regular expression that does not compile/)
  })

  it('flags a non-string matcher, a non-array hooks list and a non-string `if`', () => {
    expect(check(pre({ matcher: 3, hooks: [ok] })).map((p) => p.path)).toEqual(['hooks.PreToolUse.0.matcher'])
    expect(check(pre({ matcher: 'Bash', hooks: ok })).map((p) => p.path)).toEqual(['hooks.PreToolUse.0.hooks'])
    expect(check(pre({ matcher: 'Bash', hooks: [{ ...ok, if: 7 }] })).map((p) => p.path)).toEqual(['hooks.PreToolUse.0.hooks.0'])
  })

})

describe('guardHookEntryProblems — malformed matchers, handlers and event lists', () => {
  it('flags an uncompilable matcher on PreToolUse as well as PermissionRequest', () => {
    expect(check(pre({ matcher: 'Edit(', hooks: [ok] })).map((p) => p.path)).toEqual(['hooks.PreToolUse.0.matcher'])
  })

  it('flags an `if` the host cannot parse (measured: that handler is skipped while its siblings run)', () => {
    expect(check(pre({ matcher: 'Bash', hooks: [{ ...ok, if: 'Bash(' }] }))).toEqual([
      { path: 'hooks.PreToolUse.0.hooks.0', problem: '`if` "Bash(" is not a permission rule (`Tool` or `Tool(pattern)`); the host skips this hook' },
    ])
  })

  it('flags each shape measured to drop the whole source: unknown type, http without url, zero timeout, non-boolean async', () => {
    const paths = (hook: Record<string, unknown>) => check(pre({ matcher: 'Bash', hooks: [hook] })).map((p) => p.problem)
    expect(paths({ type: 'bogus', command: 'true' })).toEqual(['unknown hook `type` "bogus"; the documented types are command, http, mcp_tool, prompt, agent'])
    expect(paths({ type: 'http' })).toEqual(['an http hook needs a string `url`'])
    expect(paths({ ...ok, timeout: 0 })).toEqual(['`timeout` must be a positive number of seconds; received 0'])
    expect(paths({ ...ok, async: 'yes' })).toEqual(['`async` must be a boolean; received string'])
  })

  it('flags a non-array event list, a non-object group and a non-object handler', () => {
    expect(check({ hooks: { PreToolUse: {} } }).map((p) => p.path)).toEqual(['hooks.PreToolUse'])
    expect(check({ hooks: { PreToolUse: ['Bash'] } }).map((p) => p.path)).toEqual(['hooks.PreToolUse.0'])
    expect(check(pre({ matcher: 'Bash', hooks: ['node guard.mjs'] })).map((p) => p.path)).toEqual(['hooks.PreToolUse.0.hooks.0'])
  })

  // The host strips a malformed entry of any other event on its own; only these two events make it withhold the whole
  // source (read off the 2.1.289 binary: the settings loader collects them as "unloadable guards").
  it('ignores every other event: only PreToolUse and PermissionRequest drop their source', () => {
    expect(check({ hooks: { PostToolUse: [{ matcher: 'Bash(', hooks: [{ type: 'command' }] }] } })).toEqual([])
  })
})

describe('guardHookEntryProblems — the shapes the host accepts stay quiet', () => {
  it('accepts exact, list, regex, match-all and omitted matchers with numeric timeouts and an `if`', () => {
    const config = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ ...ok, timeout: 5 }] },
          { matcher: 'Edit|Write|MultiEdit', hooks: [ok] },
          { matcher: 'mcp__.*|Bash', hooks: [ok] },
          { matcher: '*', hooks: [ok] },
          { hooks: [{ ...ok, if: 'Bash(git push *)', async: true }] },
          { matcher: 'Bash', hooks: [{ ...ok, timeout: 0.5, if: 'Bash' }, { type: 'command', command: '' }] },
          { matcher: 'Agent', hooks: [{ type: 'http', url: 'http://127.0.0.1:1/hook' }] },
        ],
        PermissionRequest: [{ matcher: '', hooks: [ok] }],
      },
    }
    expect(check(config)).toEqual([])
  })

  it('accepts a config with no hooks, and a hooks object without the two events', () => {
    expect(check({})).toEqual([])
    expect(check({ hooks: { Stop: [] } })).toEqual([])
  })
})

// A plugin registers hooks inline in its manifest or in `hooks/hooks.json`; both are read by the host, so both are
// checked. A `hooks.json` holding only `modules` (Function Hooks) has no `hooks` key and yields no entry to check.
const pluginRoots = [
  join(REPO_ROOT, 'plugin'),
  join(REPO_ROOT, 'plugin', 'launch-agents'),
  ...readdirSync(join(REPO_ROOT, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(REPO_ROOT, 'plugins', entry.name)),
]
const shippedManifests = pluginRoots
  .flatMap((root) => [join(root, '.claude-plugin', 'plugin.json'), join(root, 'hooks', 'hooks.json')])
  .filter((file) => existsSync(file))

describe('every shipped plugin manifest carries only guard hook entries the host can use', () => {
  it('finds the manifests that register guard hooks', () => {
    const rel = shippedManifests.map((file) => relative(REPO_ROOT, file).replaceAll('\\', '/'))
    expect(rel).toEqual(
      expect.arrayContaining([
        'plugin/.claude-plugin/plugin.json',
        'plugin/launch-agents/.claude-plugin/plugin.json',
        'plugins/wt-rules-on-demand/hooks/hooks.json',
      ]),
    )
  })

  it('reads guard entries from every file that registers them, so a clean result is not a vacuous one', () => {
    for (const rel of ['plugin/.claude-plugin/plugin.json', 'plugin/launch-agents/.claude-plugin/plugin.json', 'plugins/wt-rules-on-demand/hooks/hooks.json']) {
      const hooks = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')).hooks ?? {}
      expect(hooks.PreToolUse?.length ?? 0, rel).toBeGreaterThan(0)
    }
  })

  for (const file of shippedManifests) {
    it(`${relative(REPO_ROOT, file).replaceAll('\\', '/')} has no unusable PreToolUse or PermissionRequest entry`, () => {
      expect(check(JSON.parse(readFileSync(file, 'utf8')))).toEqual([])
    })
  }
})

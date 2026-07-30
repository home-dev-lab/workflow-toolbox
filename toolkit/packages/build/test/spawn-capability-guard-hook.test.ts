// spawn-capability-guard-hook.test.ts — behavior gates for plugin/bin/wt-spawn-capability-guard-hook.mjs
//
// WHAT THE GUARD IS FOR. Briefing an agent type that has no Write tool with "write your report to
// <path>" produces a silent, expensive failure: the agent does the work, cannot write, and ends
// its turn reporting success. Observed twice on this machine, ~120k tokens each, WITH a written
// rule and a memory note already describing it — which is why it is a hook and not a paragraph.
//
// Like the sibling hook tests, every case drives the REAL script as a child process with a crafted
// stdin payload and asserts stdout + exit code. Fixtures are hermetic: each test builds its own
// `.claude/agents/<type>.md` in a temp dir and points BOTH resolution roots (cwd and
// CLAUDE_CONFIG_DIR) at it, so the machine's real agent definitions can never make a case pass or
// fail by accident.
//
// The negative cases carry as much weight as the positive ones. A guard that denies a legitimate
// read-only brief gets routed around, and a routed-around guard protects nothing — so "allows a
// brief that merely NAMES a path to read" is a load-bearing assertion, not padding.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-spawn-capability-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** Build a temp project whose `.claude/agents/` holds one definition, and return its path. */
function projectWithAgent(name: string, frontmatter: string): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-capability-guard-'))
  roots.push(root)
  const dir = join(root, '.claude', 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\n${frontmatter}\n---\n\nbody\n`)
  return root
}

function run(payload: unknown, cwd: string) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    // Point the user-level resolution root at an empty dir so only the fixture can match.
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(cwd, '.nonexistent-config') },
  })
  const denied = res.stdout.includes('"deny"')
  return { denied, stdout: res.stdout, stderr: res.stderr, status: res.status }
}

function spawnPayload(type: string, prompt: string, cwd: string) {
  return { tool_name: 'Agent', cwd, tool_input: { subagent_type: type, prompt } }
}

describe('wt-spawn-capability-guard-hook', () => {
  describe('denies when the type cannot write but the brief demands a file', () => {
    it('English: "write your report to <path>"', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read, Grep, Glob')
      const r = run(spawnPayload('groomer', 'Groom it. Write your report to /tmp/out.md', cwd), cwd)
      expect(r.denied).toBe(true)
      // The refusal must name the missing capability AND the fix, or it just blocks work.
      expect(r.stdout).toContain('NO Write tool')
      expect(r.stdout).toContain('final message')
    })

    it('the REPORT WRITTEN contract alone is enough to trigger it', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read, Grep, Glob')
      const r = run(spawnPayload('groomer', 'Do the work.\nFINAL MESSAGE: REPORT WRITTEN: <path>', cwd), cwd)
      expect(r.denied).toBe(true)
    })

    it('French with accents', () => {
      const cwd = projectWithAgent('lecteur', 'tools: Read, Grep')
      const r = run(spawnPayload('lecteur', 'Vérifie, puis écris ton rapport dans /tmp/r.md', cwd), cwd)
      expect(r.denied).toBe(true)
    })

    // Regression lock: the first implementation used `\bécri[st]\b`. JS word boundaries are built
    // on ASCII \w, so `\b` before `é` does not mean what it looks like, and the unaccented spelling
    // was not matched at all — a French pattern that could never fire on French briefs. A pattern
    // that cannot fire is worse than no pattern: it reads as coverage.
    it('French WITHOUT accents — the spelling that silently escaped the first implementation', () => {
      const cwd = projectWithAgent('lecteur', 'tools: Read, Grep')
      const r = run(spawnPayload('lecteur', 'Verifie, puis ecris ton rapport dans /tmp/r.md', cwd), cwd)
      expect(r.denied).toBe(true)
    })

    it('French: "dépose … dans ~/chemin"', () => {
      const cwd = projectWithAgent('lecteur', 'tools: Read')
      const r = run(spawnPayload('lecteur', 'Analyse puis dépose le résultat dans ~/audits/x.md', cwd), cwd)
      expect(r.denied).toBe(true)
    })

    it('a YAML inline list is parsed the same as a comma list', () => {
      const cwd = projectWithAgent('groomer', 'tools: [Read, Grep, Glob]')
      const r = run(spawnPayload('groomer', 'Write your findings to /tmp/x.md', cwd), cwd)
      expect(r.denied).toBe(true)
    })
  })

  describe('allows everything it has no business refusing', () => {
    it('a type that DOES declare Write', () => {
      const cwd = projectWithAgent('writer', 'tools: Read, Write, Bash')
      const r = run(spawnPayload('writer', 'Write your report to /tmp/out.md', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    it('a type with no tools: line at all — it inherits every tool', () => {
      const cwd = projectWithAgent('inherits', 'model: sonnet')
      const r = run(spawnPayload('inherits', 'Write your report to /tmp/out.md', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    it('tools: * means everything', () => {
      const cwd = projectWithAgent('star', 'tools: *')
      const r = run(spawnPayload('star', 'Write your report to /tmp/out.md', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    it('an unknown type — cannot judge, so says nothing', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read')
      const r = run(spawnPayload('does-not-exist', 'Write your report to /tmp/out.md', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    // The load-bearing negative: briefs name paths to READ constantly. Denying those would make
    // the guard a nuisance, and a nuisance guard gets disabled.
    it('a read-only brief that merely names a path', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read, Grep, Glob')
      const r = run(spawnPayload('groomer', 'Read /home/x/MEMORY.md and report in your final message.', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    it('French "décris" is not the verb "écris"', () => {
      const cwd = projectWithAgent('lecteur', 'tools: Read')
      const r = run(spawnPayload('lecteur', 'Décris ce que fait /home/x/script.mjs, sans rien modifier.', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    it('a propose-only brief whose deliverable is the final message', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read, Grep, Glob')
      const r = run(
        spawnPayload('groomer', 'PROPOSE only. Your final message IS the proposal. Never edit.', cwd),
        cwd,
      )
      expect(r.denied).toBe(false)
    })

    it('a tool other than Agent', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read')
      const r = run({ tool_name: 'Bash', tool_input: { command: 'echo write to /tmp/x' } }, cwd)
      expect(r.denied).toBe(false)
    })
  })

  describe('fails open, never closed', () => {
    it('malformed stdin produces no output and exit 0', () => {
      const res = spawnSync(process.execPath, [HOOK], { input: 'not json at all', encoding: 'utf8' })
      expect(res.stdout.trim()).toBe('')
      expect(res.status).toBe(0)
    })

    it('empty stdin produces no output and exit 0', () => {
      const res = spawnSync(process.execPath, [HOOK], { input: '', encoding: 'utf8' })
      expect(res.stdout.trim()).toBe('')
      expect(res.status).toBe(0)
    })
  })

  // A hook that is not registered never runs, and its passing unit tests then prove nothing about
  // the shipped product — the wiring is part of the behavior.
  it('is registered as a PreToolUse hook on Agent in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Agent')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) => h.command?.includes('wt-spawn-capability-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})

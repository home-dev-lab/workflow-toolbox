// env-prerequisite-drift-hook.test.ts — behaviour lock for the SessionStart warning
// light that notices an environment prerequisite which drifted AFTER adoption
// (plugin/bin/wt-env-prerequisite-drift-hook.mjs, card 1833979134787716505).
//
// Drives the REAL hook as a child process against isolated project + config dirs,
// never the real ~/.claude — same technique as adopt-check-hook.test.ts.
//
// What each case is FOR, since a list of assertions does not say it: this hook runs at
// every session start, the noisiest surface there is. One false positive per session and
// it gets switched off, taking its real case with it. So the silence cases below are not
// padding — they are the ones that decide whether the mechanism survives, and the
// nothing-adopted case is the sharpest of them.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-env-prerequisite-drift-hook.mjs')

const DEPTH_KEY = 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH'
const OBSERVER_KEY = 'CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS'
/** A value that exists ONLY to be hunted for in the output. The env block carries real
 *  credentials on a real machine, so "no value ever reaches output" is a security
 *  property, not tidiness — and a property nobody asserts is a property nobody keeps. */
const SECRET_VALUE = 'sentinel-value-must-never-be-printed'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `wt-envdrift-${tag}-`))
  roots.push(r)
  return r
}

const BANNER = '<!-- installed from workflow-toolbox v0.107.4 · content sha256:abcdef123456 -->'

interface Fixture {
  proj: string
  cfg: string
}

/** `adopted` seeds banner-stamped copies (what the installer leaves behind); `handWritten`
 *  seeds an agent file with NO banner, which is a project that owns its own agents and has
 *  adopted nothing. */
function fixture(tag: string, opts: { adopted?: boolean; handWritten?: boolean }): Fixture {
  const root = mkRoot(tag)
  const proj = join(root, 'proj')
  const cfg = join(root, 'cfg')
  mkdirSync(join(proj, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(proj, '.claude', 'rules'), { recursive: true })
  mkdirSync(cfg, { recursive: true })
  if (opts.adopted) {
    writeFileSync(join(proj, '.claude', 'agents', 'pilot.md'), `---\nname: pilot\n---\n${BANNER}\nbody\n`)
    writeFileSync(join(proj, '.claude', 'rules', 'wt-x.md'), `${BANNER}\nrule body\n`)
  }
  if (opts.handWritten) {
    writeFileSync(join(proj, '.claude', 'agents', 'mine.md'), '---\nname: mine\n---\nmy own agent\n')
  }
  return { proj, cfg }
}

function writeSettings(cfg: string, raw: string): void {
  writeFileSync(join(cfg, 'settings.json'), raw)
}

function envJson(keys: Record<string, string>): string {
  return JSON.stringify({ env: { ...keys, A_CREDENTIAL: SECRET_VALUE } })
}

function run(fx: Fixture): { out: string; code: number | null } {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: fx.proj }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: fx.cfg },
  })
  return { out: `${res.stdout ?? ''}${res.stderr ?? ''}`, code: res.status }
}

describe('env-prerequisite drift — the SessionStart warning light', () => {
  it('is SILENT when every prerequisite is present', () => {
    const fx = fixture('present', { adopted: true })
    writeSettings(fx.cfg, envJson({ [DEPTH_KEY]: '3', [OBSERVER_KEY]: '1' }))
    const { out, code } = run(fx)
    expect(out).toBe('')
    expect(code).toBe(0)
  })

  it('SPEAKS when a prerequisite is absent and the sets are adopted, naming the key, the consequence, and the way out', () => {
    const fx = fixture('absent', { adopted: true })
    writeSettings(fx.cfg, envJson({}))
    const { out, code } = run(fx)
    expect(out).toContain(DEPTH_KEY)
    expect(out).toContain(OBSERVER_KEY)
    // The consequence in the reader's terms, not "the key is missing".
    expect(out).toContain('executor lane dies mid-wave')
    expect(out).toContain('WITHOUT their paired watchdog')
    // A warning with no exit becomes wallpaper. Both directions must be offered.
    expect(out).toContain('--install')
    expect(out).toContain('declare the key yourself')
    expect(code).toBe(0)
  })

  it('is SILENT for a project that adopted nothing, even with the observer flag absent', () => {
    // THE case that decides survival: a project with its own hand-written agents has no
    // observer prerequisite, and nagging it would be firing on a correct state.
    const fx = fixture('unadopted', { handWritten: true })
    writeSettings(fx.cfg, envJson({}))
    const { out } = run(fx)
    expect(out).toBe('')
  })

  it('reports UNKNOWN — never "absent" — when the settings file is unparseable', () => {
    const fx = fixture('badjson', { adopted: true })
    writeSettings(fx.cfg, '{ not json')
    const { out, code } = run(fx)
    expect(out).toContain('NOT CHECKED')
    expect(out).toContain('nothing was read')
    // The distinction this whole clause exists for: an unreadable file must not be
    // reported as a finding about the settings.
    expect(out).not.toContain('has gone missing')
    expect(code).toBe(0)
  })

  it('reports UNKNOWN when there is no settings file at all', () => {
    const fx = fixture('nofile', { adopted: true })
    const { out } = run(fx)
    expect(out).toContain('NOT CHECKED')
    expect(out).not.toContain('has gone missing')
  })

  it('never lets an environment VALUE reach the output, in any of the three verdicts', () => {
    const present = fixture('leak-ok', { adopted: true })
    writeSettings(present.cfg, envJson({ [DEPTH_KEY]: '3', [OBSERVER_KEY]: '1' }))
    const missing = fixture('leak-missing', { adopted: true })
    writeSettings(missing.cfg, envJson({}))
    const unreadable = fixture('leak-bad', { adopted: true })
    writeSettings(unreadable.cfg, `{"env":{"A_CREDENTIAL":"${SECRET_VALUE}"`)

    for (const fx of [present, missing, unreadable]) {
      expect(run(fx).out).not.toContain(SECRET_VALUE)
    }
  })

  it('declares the SAME requirements as the installer, so the detector can never go quiet about one only the installer knows', () => {
    // The two lists are a deliberate duplication: install.mjs must stay a single
    // relocatable file (its own tests copy it alone into a synthetic plugin root, so a
    // runtime import of a sibling module breaks it — measured, ERR_MODULE_NOT_FOUND
    // across six test files). Self-containment wins there, so THIS test is what keeps
    // the copies honest instead of an import.
    //
    // The failure it prevents is asymmetric and that is why it matters: add a
    // requirement to the installer only, and the hook stays silent about it forever —
    // silence that is indistinguishable from "nothing has drifted", which is the exact
    // defect the hook exists to end.
    // Both sides are read as TEXT and parsed the same way. Importing the shared module
    // instead would be shorter, and it would make the two sides asymmetric — one
    // evaluated, one parsed — so a defect in the parser could only ever be visible on
    // one of them. Same method both sides means a broken parser fails loudly on both.
    const declarationsOf = (relPath: string): string[] => {
      const source = readFileSync(join(REPO_ROOT, relPath), 'utf8')
      const entryRe = /key:\s*'([^']+)',\s*value:\s*'([^']+)',\s*sets:\s*\[([^\]]*)\]/g
      const out: string[] = []
      for (const m of source.matchAll(entryRe)) {
        const sets = (m[3] ?? '')
          .split(',')
          .map((s) => s.trim().replace(/'/g, ''))
          .filter(Boolean)
          .sort()
        out.push(`${m[1]}=${m[2]}:${sets.join('+')}`)
      }
      return out.sort()
    }

    const installerPairs = declarationsOf('plugin/skills/adopt/scripts/install.mjs')
    const sharedPairs = declarationsOf('plugin/bin/lib/env-prerequisites.mjs')

    // Assert non-emptiness on BOTH sides first: a regex that silently matched nothing
    // would make this test pass by comparing two empty arrays — a green that proves
    // nothing, the very shape this file is full of warnings about.
    expect(installerPairs.length, 'the installer must still declare its requirements').toBeGreaterThan(0)
    expect(sharedPairs.length, 'the shared module must still declare its requirements').toBeGreaterThan(0)
    expect(installerPairs).toEqual(sharedPairs)
  })

  it('exits 0 even when it speaks — a warning light, never a gate', () => {
    // A SessionStart hook that can fail a session start is a hook that gets removed the
    // first morning it is wrong about something.
    const fx = fixture('exitcode', { adopted: true })
    writeSettings(fx.cfg, envJson({}))
    expect(run(fx).code).toBe(0)
  })
})

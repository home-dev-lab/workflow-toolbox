// docs-provenance.test.ts — integrity gate over the doc↔source provenance map
// (Tier 2 of the doc-alignment defence) + unit coverage of the pure matcher.
//
// The manifest is only useful while it tells the truth: a source prefix that
// matches zero files (the module moved/was renamed) or a doc path that no
// longer exists means pr-review's docs-alignment lens fires on phantoms or
// never fires — both silently. This gate makes either drift a loud suite
// failure in the same change that moved the file.

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DOCS_PROVENANCE, docsForChangedFiles } from '../docs-provenance.js'
import type { ProvenanceEntry } from '../docs-provenance.js'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

describe('docs-provenance — manifest integrity against the real tree', () => {
  it('has entries', () => {
    expect(DOCS_PROVENANCE.length).toBeGreaterThan(0)
  })

  it('every source prefix matches at least one existing file or directory', () => {
    const dead: string[] = []
    for (const entry of DOCS_PROVENANCE) {
      for (const prefix of entry.sources) {
        // A prefix is alive when it IS an existing path (file or dir). Prefixes
        // are written as full file paths or directory prefixes ending in '/',
        // so plain existence is the right liveness check for both.
        const p = join(REPO_ROOT, prefix)
        if (!existsSync(p)) dead.push(prefix)
      }
    }
    expect(dead, `source prefixes matching nothing: ${dead.join(', ')}`).toEqual([])
  })

  it('every mapped doc surface exists', () => {
    const dead = DOCS_PROVENANCE.flatMap((e) => e.docs).filter(
      (d) => !existsSync(join(REPO_ROOT, d)),
    )
    expect(dead, `doc surfaces that no longer exist: ${dead.join(', ')}`).toEqual([])
  })

  it('directory prefixes end in "/" and are non-empty dirs; file prefixes are files', () => {
    for (const entry of DOCS_PROVENANCE) {
      for (const prefix of entry.sources) {
        const p = join(REPO_ROOT, prefix)
        const st = statSync(p)
        if (prefix.endsWith('/')) {
          expect(st.isDirectory(), `${prefix} should be a directory`).toBe(true)
          expect(readdirSync(p).length, `${prefix} is an empty directory`).toBeGreaterThan(0)
        } else {
          expect(st.isFile(), `${prefix} should be a file (or end in "/" for a dir)`).toBe(true)
        }
      }
    }
  })
})

describe('docsForChangedFiles — pure prefix matcher', () => {
  it('maps a changed file under a directory prefix to its docs', () => {
    const docs = docsForChangedFiles(['toolkit/packages/scaffold/src/scaffold.ts'])
    expect(docs).toContain('plugin/skills/toolkit-scaffold/SKILL.md')
  })

  it('maps an exact file prefix', () => {
    const docs = docsForChangedFiles(['toolkit/packages/build/src/lint.ts'])
    expect(docs).toContain('plugin/skills/workflow-composer/references/api-reference.md')
    expect(docs).toContain('CLAUDE.md')
  })

  it('a probe-routing change maps to the routing reference (the cabfab1 shape)', () => {
    const docs = docsForChangedFiles([
      'toolkit/packages/patterns/src/lean-routing.ts',
      'toolkit/packages/patterns/test/lean-routing.test.ts',
    ])
    expect(docs).toContain('plugin/skills/workflow-composer/references/model-and-agent-routing.md')
  })

  it('dedupes docs across entries and preserves manifest order', () => {
    const docs = docsForChangedFiles([
      'toolkit/packages/patterns/src/lean-routing.ts', // → SKILL.md (entry 1)
      'toolkit/packages/scaffold/src/cli.ts', // → SKILL.md again (scaffold entry)
    ])
    expect(docs.filter((d) => d === 'plugin/skills/workflow-composer/SKILL.md')).toHaveLength(1)
  })

  it('returns [] when nothing mapped is touched', () => {
    expect(docsForChangedFiles(['some/other/file.ts', 'server/app.ts'])).toEqual([])
    expect(docsForChangedFiles([])).toEqual([])
  })

  it('does not fire on a sibling whose name merely shares the prefix string start', () => {
    // 'toolkit/packages/patterns/src/' must not match a hypothetical
    // 'toolkit/packages/patterns-extra/…' — the '/' terminator in the manifest
    // prefix guarantees it.
    expect(docsForChangedFiles(['toolkit/packages/patterns-extra/src/x.ts'])).toEqual([])
  })

  it('a file-level entry is an EXACT match — a same-stem sibling does not false-trigger', () => {
    // Review finding (run wf_0decbfe8-7e4, verified live by the reviewer):
    // 'toolkit/packages/build/src/lint.tsx'.startsWith('…/lint.ts') is true, so
    // a naive prefix match armed the lens for a file the manifest never mapped.
    // File entries (no trailing '/') must match exactly.
    expect(docsForChangedFiles(['toolkit/packages/build/src/lint.tsx'])).toEqual([])
    expect(docsForChangedFiles(['toolkit/packages/build/src/lint.ts.bak'])).toEqual([])
    // Same-stem sibling of an exact runtime entry: no directory entry covers
    // runtime/src/, so this must map to nothing at all.
    expect(docsForChangedFiles(['toolkit/packages/runtime/src/digest.ts.orig'])).toEqual([])
  })
})

describe('docsForChangedFiles — explicit manifest parameter (pr-review provenance knob)', () => {
  // An external repo's manifest (observatory-shaped paths — they deliberately
  // do NOT exist in this tree: the matcher is pure, only the bundled
  // DOCS_PROVENANCE is integrity-gated against the real tree above).
  const CUSTOM: readonly ProvenanceEntry[] = [
    {
      sources: ['apps/observe-ui/server/'],
      docs: ['apps/observe-ui/README.md', 'docs/known-issues.md'],
    },
    { sources: ['packages/licensing/src/license.ts'], docs: ['EULA.md'] },
  ]

  it('uses the provided manifest instead of the bundled one', () => {
    const docs = docsForChangedFiles(['apps/observe-ui/server/host.ts'], CUSTOM)
    expect(docs).toEqual(['apps/observe-ui/README.md', 'docs/known-issues.md'])
  })

  it('REPLACES the bundled manifest, never merges: a bundled-mapped path stops matching', () => {
    // This path maps via the BUNDLED manifest (build/lint.ts entry); under a
    // custom manifest it must map to nothing.
    expect(docsForChangedFiles(['toolkit/packages/build/src/lint.ts'], CUSTOM)).toEqual([])
  })

  it('applies the same exact-vs-subtree semantics to a custom manifest', () => {
    // Exact file entry: same-stem sibling must not false-trigger.
    expect(docsForChangedFiles(['packages/licensing/src/license.tsx'], CUSTOM)).toEqual([])
    expect(docsForChangedFiles(['packages/licensing/src/license.ts'], CUSTOM)).toEqual(['EULA.md'])
    // Directory entry: '/' terminator guards the sibling-dir case.
    expect(docsForChangedFiles(['apps/observe-ui/server-extra/x.ts'], CUSTOM)).toEqual([])
  })

  it('passing the bundled manifest explicitly behaves exactly like the default', () => {
    const changed = ['toolkit/packages/scaffold/src/scaffold.ts']
    expect(docsForChangedFiles(changed, DOCS_PROVENANCE)).toEqual(docsForChangedFiles(changed))
  })
})

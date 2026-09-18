import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { parseIntegrateArgs } from '../../../../plugin/bin/lib/lane-integrate.mjs'

// Relative on purpose: path.resolve leaves an absolute path unchanged, so absolute inputs could not tell a
// resolved option from an unresolved one — and would read C:\tmp\… on Windows.
const required = ['--dir', 'lane', '--into', 'integration', '--message', 'message.txt']

describe('parseIntegrateArgs', () => {
  it('rejects a value option without a following argument', () => {
    expect(parseIntegrateArgs(['--dir'])).toEqual({ error: '--dir requires a value' })
  })

  it('rejects a value option followed by another option', () => {
    expect(parseIntegrateArgs(['--remote', '--dry-run'])).toEqual({ error: '--remote requires a value' })
  })

  it('rejects pre-remove-check without a command', () => {
    expect(parseIntegrateArgs(['--pre-remove-check', '--force'])).toEqual({ error: '--pre-remove-check requires a command' })
  })

  it('returns help for the long help option', () => {
    expect(parseIntegrateArgs(['--help'])).toEqual({ help: true })
  })

  it('returns help for the short help option', () => {
    expect(parseIntegrateArgs(['-h'])).toEqual({ help: true })
  })

  it('rejects an unknown argument', () => {
    expect(parseIntegrateArgs(['--no-such-option'])).toEqual({ error: 'unknown integrate argument: --no-such-option' })
  })

  it('requires dir, into, and message', () => {
    expect(parseIntegrateArgs([])).toEqual({ error: 'integrate requires --dir, --into, and --message' })
    expect(parseIntegrateArgs(['--dir', 'lane'])).toEqual({ error: 'integrate requires --dir, --into, and --message' })
    expect(parseIntegrateArgs(['--dir', 'lane', '--into', 'integration'])).toEqual({ error: 'integrate requires --dir, --into, and --message' })
  })

  it('requires ci-branch when dispatch is requested', () => {
    expect(parseIntegrateArgs([...required, '--dispatch', 'release.yml'])).toEqual({ error: '--dispatch requires --ci-branch' })
  })

  it('requires dispatch when wait is requested', () => {
    expect(parseIntegrateArgs([...required, '--wait'])).toEqual({ error: '--wait requires --dispatch' })
  })

  it('consumes the documented pre-remove-check command shape', () => {
    expect(parseIntegrateArgs([...required, '--pre-remove-check', 'node', 'check.mjs'])).toEqual({
      dir: resolve('lane'),
      into: resolve('integration'),
      message: resolve('message.txt'),
      mergeSubject: null,
      archiveRoot: null,
      preRemoveCheck: ['node', 'check.mjs'],
      ciBranch: null,
      remote: 'public',
      authorizeFile: null,
      dispatch: null,
      wait: false,
      dryRun: false,
      keepWorktree: false,
      force: false,
    })
  })

  it('returns every parsed option and resolves path options', () => {
    expect(parseIntegrateArgs([
      ...required,
      '--merge-subject', 'Merge lane',
      '--archive-root', 'archive',
      '--ci-branch', 'ci/lane',
      '--remote', 'origin',
      '--authorize-file', 'authorization.json',
      '--dispatch', 'release.yml',
      '--wait',
      '--dry-run',
      '--keep-worktree',
      '--force',
    ])).toEqual({
      dir: resolve('lane'),
      into: resolve('integration'),
      message: resolve('message.txt'),
      mergeSubject: 'Merge lane',
      archiveRoot: resolve('archive'),
      preRemoveCheck: null,
      ciBranch: 'ci/lane',
      remote: 'origin',
      authorizeFile: resolve('authorization.json'),
      dispatch: 'release.yml',
      wait: true,
      dryRun: true,
      keepWorktree: true,
      force: true,
    })
  })
})

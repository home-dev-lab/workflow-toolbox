import { describe, it, expect } from 'vitest'
import { recoverExitCodeFor, RECOVER_NOT_FOUND_EXIT_CODE, RECOVER_REFUSED_EXIT_CODE } from '../src/observe-resume.js'

describe('recoverExitCodeFor', () => {
  it('0 on a successful dispatch (2xx)', () => {
    expect(recoverExitCodeFor(200, true, undefined)).toBe(0)
  })

  it('RECOVER_NOT_FOUND_EXIT_CODE on a 404 with code "not-found" (no journal at all)', () => {
    expect(recoverExitCodeFor(404, false, 'not-found')).toBe(RECOVER_NOT_FOUND_EXIT_CODE)
  })

  it('RECOVER_REFUSED_EXIT_CODE on a 404 with a DIFFERENT code (the run exists, its workflow does not)', () => {
    expect(recoverExitCodeFor(404, false, 'not-allowlisted')).toBe(RECOVER_REFUSED_EXIT_CODE)
  })

  it('RECOVER_REFUSED_EXIT_CODE on a 404 with NO code at all (malformed body — never conflated with genuine not-found)', () => {
    expect(recoverExitCodeFor(404, false, undefined)).toBe(RECOVER_REFUSED_EXIT_CODE)
  })

  it.each([
    ['not-failed (completed is final)', 409, 'not-failed'],
    ['no-disk-state (transcriptDir gone)', 409, 'no-disk-state'],
    ['already-running', 409, 'already-running'],
    ['resume-budget-exhausted', 429, 'resume-budget-exhausted'],
    ['launch-disabled', 403, 'launch-disabled'],
    ['pro-required (free tier)', 402, undefined],
    ['internal (defensive tripwire)', 500, 'internal'],
  ])('RECOVER_REFUSED_EXIT_CODE for %s', (_label, status, code) => {
    expect(recoverExitCodeFor(status, false, code)).toBe(RECOVER_REFUSED_EXIT_CODE)
  })

  it('never returns 0 when ok is false, regardless of status', () => {
    expect(recoverExitCodeFor(200, false, undefined)).not.toBe(0)
  })
})

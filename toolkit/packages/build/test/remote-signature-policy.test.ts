import { describe, expect, it } from 'vitest'
// @ts-expect-error plugin runtime module
import { remoteSignaturePolicy } from '../../../../plugin/bin/lib/remote-signature-policy.mjs'

const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
function policy(rules: unknown, classic: unknown = { enabled: false }) {
  return remoteSignaturePolicy({ url: 'git@github.com:team/repo.git', branch: 'topic/a', run: (_cmd: string, args: string[]) => args.includes('--slurp') ? ok(rules) : ok(classic) })
}
describe('remote signature policy evidence', () => {
  it('reads every paginated page and escapes a branch as one path component', () => {
    const calls: string[][] = []
    const result = remoteSignaturePolicy({ url: 'https://github.com/team/repo.git', branch: 'topic/a', run: (_cmd: string, args: string[]) => { calls.push(args); return ok([[], [{ type: 'required_signatures' }]]) } })
    expect(result.state).toBe('requirement-present')
    expect(calls[0]).toContain('--paginate')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 4)).toEqual(['api', '--hostname', 'github.com', '--paginate'])
    expect(calls[0]).toContain('repos/team/repo/rules/branches/topic%2Fa')
    expect(result.sentence).toContain('bypass rights were not checked')
    expect(result.sentence).not.toMatch(/WILL|expected to reject/)
  })
  it('pins github.com on the classic protection request too', () => {
    const calls: string[][] = []
    remoteSignaturePolicy({ url: 'https://github.com/team/repo.git', branch: 'main', run: (_cmd: string, args: string[]) => { calls.push(args); return args.includes('--slurp') ? ok([[]]) : ok({ enabled: false }) } })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.slice(0, 3)).toEqual(['api', '--hostname', 'github.com'])
  })
  it('reports no requirement only from complete rules and classic false', () => {
    expect(policy([[]]).state).toBe('no-requirement-found')
    expect(policy([[]], { enabled: true }).state).toBe('requirement-present')
  })
  it.each([null, {}, [], [[{}]], [[{ type: 3 }]], [[], {}]])('names unknown page shape %j', (rules) => {
    expect(policy(rules).state).toBe('unknown')
  })
  it.each([{}, { enabled: 'false' }, null])('names unknown classic shape %j', (classic) => {
    expect(policy([[]], classic).state).toBe('unknown')
  })
  it.each(['Branch not protected', 'Not Found'])('distinguishes classic 404 message %s', (message) => {
    const result = remoteSignaturePolicy({ url: 'ssh://git@github.com/team/repo.git', branch: 'main', run: (_cmd: string, args: string[]) => args.includes('--slurp') ? ok([[]]) : { status: 1, stdout: JSON.stringify({ message }), stderr: 'gh: response (HTTP 404)' } })
    expect(result.state).toBe(message === 'Branch not protected' ? 'no-requirement-found' : 'unknown')
  })
  it.each(['timeout', 'gh missing', 'partial pagination'])('keeps %s unknown', (reason) => {
    const result = remoteSignaturePolicy({ url: 'https://github.com/team/repo', branch: 'main', run: () => ({ status: 1, stdout: '[[]]', stderr: reason }) })
    expect(result.state).toBe('unknown')
  })
  it.each([{ status: 2 }, { status: 1, signal: 'SIGTERM' }])('does not interpret a failed classic command as an unprotected branch: %j', (failure) => {
    const result = remoteSignaturePolicy({ url: 'https://github.com/team/repo', branch: 'main', run: (_cmd: string, args: string[]) => args.includes('--slurp') ? ok([[]]) : { ...failure, stdout: '{"message":"Branch not protected"}', stderr: 'gh: response (HTTP 404)' } })
    expect(result.state).toBe('unknown')
  })
  it('catches thrown runners and explains local E signatures', () => {
    const result = remoteSignaturePolicy({ url: 'https://github.com/team/repo', branch: 'main', statuses: ['E'], run: () => { throw Error('timeout') } })
    expect(result.state).toBe('unknown')
    expect(result.sentence).toContain('GitHub may verify')
    expect(remoteSignaturePolicy({ url: '/local/repo', branch: 'main' }).state).toBe('unknown')
  })
})
